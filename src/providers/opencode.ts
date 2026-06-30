import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import Database from "libsql";
import type {
  AgentProvider,
  CliOptions,
  ProjectCandidate,
  ProviderApplyResult,
  ProviderScanResult,
  SessionCandidate,
} from "../types.js";
import { compactSqliteFiles } from "./sqlite.js";
import {
  excerpt,
  expandHome,
  formatBytes,
  getPathSize,
  matchesIgnoredProject,
  matchesSizeThreshold,
  parseDate,
  pathExists,
  removePath,
} from "../utils.js";

interface OpencodeProjectInternal {
  metadataPaths: string[];
  projectId: string;
  sessionDirectoryPath: string;
}

interface OpencodeSessionInternal {
  cleanupPaths: string[];
  projectId: string;
  sessionDirectoryParentPath: string;
  sessionId: string;
}

interface OpencodeProjectRow {
  id: string;
  name: string | null;
  time_created: number;
  time_updated: number;
  worktree: string;
}

interface OpencodeSessionMessageRow {
  id: string;
  session_id: string;
}

interface OpencodeSessionRow {
  directory: string;
  id: string;
  project_id: string;
  project_name: string | null;
  time_created: number;
  time_updated: number;
  title: string;
  worktree: string | null;
}

const OPENCODE_ROOT = expandHome("~/.local/share/opencode");
const OPENCODE_DB_PATH = join(OPENCODE_ROOT, "opencode.db");
const OPENCODE_SNAPSHOT_ROOT = join(OPENCODE_ROOT, "snapshot");
const OPENCODE_STORAGE_ROOT = join(OPENCODE_ROOT, "storage");
const OPENCODE_STORAGE_AGENT_USAGE_REMINDER_ROOT = join(
  OPENCODE_STORAGE_ROOT,
  "agent-usage-reminder",
);
const OPENCODE_STORAGE_MESSAGE_ROOT = join(OPENCODE_STORAGE_ROOT, "message");
const OPENCODE_STORAGE_PART_ROOT = join(OPENCODE_STORAGE_ROOT, "part");
const OPENCODE_STORAGE_PROJECT_ROOT = join(OPENCODE_STORAGE_ROOT, "project");
const OPENCODE_STORAGE_SESSION_DIFF_ROOT = join(
  OPENCODE_STORAGE_ROOT,
  "session_diff",
);
const OPENCODE_STORAGE_SESSION_ROOT = join(OPENCODE_STORAGE_ROOT, "session");
const OPENCODE_STORAGE_SESSION_SHARE_ROOT = join(
  OPENCODE_STORAGE_ROOT,
  "session_share",
);

export const opencodeProvider: AgentProvider<
  OpencodeSessionInternal,
  OpencodeProjectInternal
> = {
  async apply(
    result: ProviderScanResult<
      OpencodeSessionInternal,
      OpencodeProjectInternal
    >,
    options: CliOptions,
  ): Promise<ProviderApplyResult> {
    const sessionIds = result.sessions.map((session) => session.id);
    const projectIds = result.projects.map(
      (project) => project.internal.projectId,
    );
    const cleanupPaths = new Set<string>();
    const sessionDirectoryParents = new Set<string>();

    for (const session of result.sessions) {
      for (const path of session.internal.cleanupPaths) {
        cleanupPaths.add(path);
      }

      sessionDirectoryParents.add(session.internal.sessionDirectoryParentPath);
    }

    for (const project of result.projects) {
      for (const path of project.internal.metadataPaths) {
        cleanupPaths.add(path);
      }

      cleanupPaths.add(project.internal.sessionDirectoryPath);
    }

    const database = new Database(OPENCODE_DB_PATH, { timeout: 5000 });

    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("BEGIN");

      const deleteSession = database.prepare(
        "DELETE FROM session WHERE id = ?",
      );
      const deleteProject = database.prepare(
        "DELETE FROM project WHERE id = ? AND id != 'global'",
      );

      for (const sessionId of sessionIds) {
        deleteSession.run(sessionId);
      }

      for (const projectId of projectIds) {
        deleteProject.run(projectId);
      }

      database.exec("COMMIT");
      database.pragma("wal_checkpoint(TRUNCATE)");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }

    await Promise.all(Array.from(cleanupPaths, (path) => removePath(path)));
    await Promise.all(
      Array.from(sessionDirectoryParents, (path) =>
        cleanupEmptyDirectory(path),
      ),
    );

    const notes: string[] = [];
    const warnings: string[] = [];

    if (options.compactSqlite) {
      const compacted = await compactSqliteFiles([OPENCODE_DB_PATH], warnings);

      if (compacted) {
        notes.push("Opencode SQLite database was compacted with VACUUM.");
      }
    } else {
      notes.push(
        "Opencode SQLite rows and mapped storage files were deleted directly. Physical database size may not shrink until VACUUM runs (disabled via --no-compact-sqlite).",
      );
    }

    return {
      deletedBytes:
        result.sessions.reduce((sum, session) => sum + session.bytes, 0) +
        result.projects.reduce((sum, project) => sum + project.bytes, 0),
      deletedProjects: result.projects.length,
      deletedSessions: result.sessions.length,
      notes,
      providerId: result.providerId,
      providerName: result.providerName,
      warnings,
    };
  },
  id: "opencode",
  // beta: data layout not locally verified — based on public docs/source only.
  name: "Opencode (beta)",
  async scan(
    options: CliOptions,
  ): Promise<ProviderScanResult<
    OpencodeSessionInternal,
    OpencodeProjectInternal
  > | null> {
    if (!(await pathExists(OPENCODE_DB_PATH))) {
      return null;
    }

    const cutoffDate = getCutoffDate(options);
    const database = new Database(OPENCODE_DB_PATH, {
      readonly: true,
      timeout: 5000,
    });

    try {
      const projectRows = parseProjectRows(
        database
          .prepare(
            [
              "SELECT id, worktree, name, time_created, time_updated",
              "FROM project",
              "ORDER BY time_updated DESC",
            ].join(" "),
          )
          .all(),
      );
      const sessionRows = parseSessionRows(
        database
          .prepare(
            [
              "SELECT",
              "  s.id,",
              "  s.project_id,",
              "  s.directory,",
              "  s.title,",
              "  s.time_created,",
              "  s.time_updated,",
              "  p.worktree,",
              "  p.name AS project_name",
              "FROM session s",
              "LEFT JOIN project p ON p.id = s.project_id",
              "ORDER BY s.time_updated DESC",
            ].join(" "),
          )
          .all(),
      );
      const sessionMessageMap = buildSessionMessageMap(
        parseSessionMessageRows(
          database.prepare("SELECT session_id, id FROM message").all(),
        ),
      );
      const sessions: SessionCandidate<OpencodeSessionInternal>[] = [];
      const projects: ProjectCandidate<OpencodeProjectInternal>[] = [];

      for (const row of sessionRows) {
        const projectPath = resolveSessionProjectPath(
          row.project_id,
          row.worktree,
          row.directory,
        );
        const projectName = projectPath
          ? basename(projectPath)
          : resolveProjectLabel(row.project_name, row.project_id);

        if (
          matchesIgnoredProject(
            projectPath,
            projectName,
            options.ignoredProjectTerms,
          )
        ) {
          continue;
        }

        const projectMissing =
          options.includeOrphaned && projectPath
            ? !(await pathExists(projectPath))
            : false;
        const reasons = collectReasons(
          parseDate(row.time_updated) ?? new Date(0),
          cutoffDate,
          projectMissing,
        );

        if (!reasons.length) {
          continue;
        }

        const cleanupPaths = buildSessionCleanupPaths(
          row.project_id,
          row.id,
          sessionMessageMap.get(row.id) ?? [],
        );
        const bytes = await sumPathSizes(cleanupPaths);

        if (!matchesSizeThreshold(bytes, options.largerThanBytes)) {
          continue;
        }

        sessions.push({
          bytes,
          createdAt: parseDate(row.time_created),
          current: false,
          id: row.id,
          internal: {
            cleanupPaths,
            projectId: row.project_id,
            sessionDirectoryParentPath: join(
              OPENCODE_STORAGE_SESSION_ROOT,
              row.project_id,
            ),
            sessionId: row.id,
          },
          projectName,
          projectPath,
          providerId: "opencode",
          providerName: "Opencode",
          reasons,
          title: excerpt(row.title),
          updatedAt: parseDate(row.time_updated) ?? new Date(0),
        });
      }

      for (const row of projectRows) {
        if (row.id === "global") {
          continue;
        }

        if (await pathExists(row.worktree)) {
          continue;
        }

        const projectName = resolveProjectLabel(row.name, row.id, row.worktree);

        if (
          matchesIgnoredProject(
            row.worktree,
            projectName,
            options.ignoredProjectTerms,
          )
        ) {
          continue;
        }

        const metadataPaths = buildProjectCleanupPaths(row.id);
        const bytes = await sumPathSizes(metadataPaths);

        if (!matchesSizeThreshold(bytes, options.largerThanBytes)) {
          continue;
        }

        projects.push({
          bytes,
          createdAt: parseDate(row.time_created),
          displayName: projectName,
          internal: {
            metadataPaths,
            projectId: row.id,
            sessionDirectoryPath: join(OPENCODE_STORAGE_SESSION_ROOT, row.id),
          },
          key: `opencode-project:${row.id}`,
          projectPath: row.worktree,
          providerId: "opencode",
          providerName: "Opencode",
          reasons: ["missing project root"],
          updatedAt: parseDate(row.time_updated),
        });
      }

      const warnings =
        sessions.length || projects.length
          ? [
              `Reported size excludes SQLite free pages. Only ${formatBytes(
                sessions.reduce((sum, session) => sum + session.bytes, 0) +
                  projects.reduce((sum, project) => sum + project.bytes, 0),
              )} of mapped Opencode storage bytes are directly reclaimable.`,
            ]
          : [];

      return {
        notes: [
          "Opencode cleanup removes SQLite rows plus mapped files from ~/.local/share/opencode/storage and ~/.local/share/opencode/snapshot.",
        ],
        projects,
        providerId: "opencode",
        providerName: "Opencode",
        sessions,
        warnings,
      };
    } finally {
      database.close();
    }
  },
};

function buildProjectCleanupPaths(projectId: string): string[] {
  return [
    join(OPENCODE_SNAPSHOT_ROOT, projectId),
    join(OPENCODE_STORAGE_PROJECT_ROOT, `${projectId}.json`),
  ];
}

function buildSessionCleanupPaths(
  projectId: string,
  sessionId: string,
  messageIds: string[],
): string[] {
  const cleanupPaths = [
    join(OPENCODE_STORAGE_AGENT_USAGE_REMINDER_ROOT, `${sessionId}.json`),
    join(OPENCODE_STORAGE_MESSAGE_ROOT, sessionId),
    join(OPENCODE_STORAGE_SESSION_DIFF_ROOT, `${sessionId}.json`),
    join(OPENCODE_STORAGE_SESSION_ROOT, projectId, `${sessionId}.json`),
    join(OPENCODE_STORAGE_SESSION_SHARE_ROOT, `${sessionId}.json`),
  ];

  for (const messageId of messageIds) {
    cleanupPaths.push(join(OPENCODE_STORAGE_PART_ROOT, messageId));
  }

  return cleanupPaths;
}

function buildSessionMessageMap(
  rows: OpencodeSessionMessageRow[],
): Map<string, string[]> {
  const messageIdsBySession = new Map<string, string[]>();

  for (const row of rows) {
    const messageIds = messageIdsBySession.get(row.session_id) ?? [];
    messageIds.push(row.id);
    messageIdsBySession.set(row.session_id, messageIds);
  }

  return messageIdsBySession;
}

async function cleanupEmptyDirectory(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return;
  }

  const remainingEntries = await readdir(path).catch(() => []);

  if (!remainingEntries.length) {
    await removePath(path);
  }
}

function collectReasons(
  updatedAt: Date,
  cutoffDate: Date | null,
  projectMissing: boolean,
): string[] {
  const reasons: string[] = [];

  if (cutoffDate && updatedAt < cutoffDate) {
    reasons.push("older than threshold");
  }

  if (projectMissing) {
    reasons.push("missing project root");
  }

  return reasons;
}

function getCutoffDate(options: CliOptions): Date | null {
  if (!options.olderThanDays) {
    return null;
  }

  return new Date(
    options.now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseProjectRows(rows: unknown): OpencodeProjectRow[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  const parsedRows: OpencodeProjectRow[] = [];

  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }

    const { id, name, time_created, time_updated, worktree } = row;

    if (
      typeof id !== "string" ||
      typeof time_created !== "number" ||
      typeof time_updated !== "number" ||
      typeof worktree !== "string"
    ) {
      continue;
    }

    parsedRows.push({
      id,
      name: typeof name === "string" ? name : null,
      time_created,
      time_updated,
      worktree,
    });
  }

  return parsedRows;
}

function parseSessionMessageRows(rows: unknown): OpencodeSessionMessageRow[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  const parsedRows: OpencodeSessionMessageRow[] = [];

  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }

    const { id, session_id } = row;

    if (typeof id !== "string" || typeof session_id !== "string") {
      continue;
    }

    parsedRows.push({
      id,
      session_id,
    });
  }

  return parsedRows;
}

function parseSessionRows(rows: unknown): OpencodeSessionRow[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  const parsedRows: OpencodeSessionRow[] = [];

  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }

    const {
      directory,
      id,
      project_id,
      project_name,
      time_created,
      time_updated,
      title,
      worktree,
    } = row;

    if (
      typeof directory !== "string" ||
      typeof id !== "string" ||
      typeof project_id !== "string" ||
      typeof time_created !== "number" ||
      typeof time_updated !== "number" ||
      typeof title !== "string"
    ) {
      continue;
    }

    parsedRows.push({
      directory,
      id,
      project_id,
      project_name: typeof project_name === "string" ? project_name : null,
      time_created,
      time_updated,
      title,
      worktree: typeof worktree === "string" ? worktree : null,
    });
  }

  return parsedRows;
}

function resolveProjectLabel(
  name: string | null,
  projectId: string,
  projectPath?: string,
): string {
  if (name) {
    return name;
  }

  if (projectPath && projectPath !== "/") {
    return basename(projectPath);
  }

  if (projectId === "global") {
    return "global";
  }

  return projectId;
}

function resolveSessionProjectPath(
  projectId: string,
  worktree: string | null,
  directory: string,
): string | null {
  if (projectId === "global") {
    return directory || null;
  }

  if (worktree && worktree !== "/") {
    return worktree;
  }

  return directory || null;
}

async function sumPathSizes(paths: string[]): Promise<number> {
  const sizes = await Promise.all(paths.map((path) => getPathSize(path)));
  return sizes.reduce((sum, size) => sum + size, 0);
}
