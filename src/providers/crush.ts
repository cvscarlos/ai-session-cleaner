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
  expandHome,
  getPathSize,
  matchesIgnoredProject,
  matchesSizeThreshold,
  parseDate,
  pathExists,
  readJsonFile,
  removePath,
  safeStat,
  writeJsonFile,
} from "../utils.js";

interface CrushDataDirContext {
  dataDir: string;
  representativeProjectPath: string | null;
}

interface CrushProjectFile {
  projects?: CrushTrackedProjectEntry[];
}

interface CrushProjectInternal {
  dataDir: string | null;
  projectPath: string;
  removeDataDir: boolean;
}

interface CrushSessionInternal {
  dataDir: string;
  sessionIds: string[];
}

interface CrushSessionRow {
  createdAt: number;
  id: string;
  parentSessionId: string | null;
  title: string;
  todos: string | null;
  updatedAt: number;
}

interface CrushSizeRow {
  sessionId: string;
  totalBytes: number;
}

interface CrushTrackedProject {
  dataDir: string | null;
  ignored: boolean;
  lastAccessed: Date | null;
  path: string;
  projectExists: boolean;
}

interface CrushTrackedProjectEntry {
  data_dir?: string;
  last_accessed?: string;
  path?: string;
}

const CRUSH_DATA_ROOT = expandHome("~/.local/share/crush");
const CRUSH_PROJECTS_PATH = join(CRUSH_DATA_ROOT, "projects.json");

export const crushProvider: AgentProvider<
  CrushSessionInternal,
  CrushProjectInternal
> = {
  async apply(
    result: ProviderScanResult<CrushSessionInternal, CrushProjectInternal>,
    options: CliOptions,
  ): Promise<ProviderApplyResult> {
    const sessionGroups = new Map<string, Set<string>>();
    const projectPathsToDelete = new Set<string>();

    for (const session of result.sessions) {
      const sessionIds =
        sessionGroups.get(session.internal.dataDir) ?? new Set();

      for (const sessionId of session.internal.sessionIds) {
        sessionIds.add(sessionId);
      }

      sessionGroups.set(session.internal.dataDir, sessionIds);
    }

    for (const project of result.projects) {
      projectPathsToDelete.add(project.internal.projectPath);
    }

    for (const [dataDir, sessionIds] of sessionGroups) {
      await deleteCrushSessions(dataDir, sessionIds);
    }

    const trackedProjects = await loadCrushProjects();
    const remainingProjects = trackedProjects.filter(
      (project) => !projectPathsToDelete.has(project.path),
    );

    if (await pathExists(CRUSH_PROJECTS_PATH)) {
      await writeJsonFile(CRUSH_PROJECTS_PATH, {
        projects: remainingProjects.map((project) => ({
          data_dir: project.dataDir ?? undefined,
          last_accessed: project.lastAccessed?.toISOString() ?? undefined,
          path: project.path,
        })),
      });
    }

    const remainingDataDirs = new Set(
      remainingProjects
        .map((project) => project.dataDir)
        .filter((path): path is string => Boolean(path)),
    );
    const removableDataDirs = new Set<string>();

    for (const project of result.projects) {
      if (
        project.internal.removeDataDir &&
        project.internal.dataDir &&
        !remainingDataDirs.has(project.internal.dataDir)
      ) {
        removableDataDirs.add(project.internal.dataDir);
      }
    }

    await Promise.all(
      Array.from(removableDataDirs, (path) => removePath(path)),
    );

    const notes = [
      "Crush session rows were deleted from tracked crush.db files, and orphaned entries were rewritten in ~/.local/share/crush/projects.json.",
    ];
    const warnings: string[] = [];

    if (options.compactSqlite) {
      const databasePaths = Array.from(sessionGroups.keys(), (dataDir) =>
        join(dataDir, "crush.db"),
      );
      const compacted = await compactSqliteFiles(databasePaths, warnings);

      if (compacted && databasePaths.length) {
        notes.push("Crush crush.db files were compacted with VACUUM.");
      }
    } else if (result.sessions.length) {
      warnings.push(
        "Reported size for Crush sessions is a logical estimate from SQLite content. crush.db files may not shrink without VACUUM (disabled via --no-compact-sqlite).",
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
  id: "crush",
  // beta: data layout not locally verified — based on public docs/source only.
  name: "Crush (beta)",
  async scan(
    options: CliOptions,
  ): Promise<ProviderScanResult<
    CrushSessionInternal,
    CrushProjectInternal
  > | null> {
    if (!(await pathExists(CRUSH_PROJECTS_PATH))) {
      return null;
    }

    const trackedProjects = await loadCrushProjects(
      options.ignoredProjectTerms,
    );
    const cutoffDate = getCutoffDate(options);
    const projects = await scanCrushProjects(trackedProjects, options);
    const { contexts, preservedSharedDataDir } =
      buildCrushDataDirContexts(trackedProjects);
    const sessions = await scanCrushSessions(contexts, cutoffDate, options);
    const notes = [
      "Crush projects are discovered from ~/.local/share/crush/projects.json and can point to project-local .crush directories or custom external data dirs.",
    ];

    if (preservedSharedDataDir) {
      notes.push(
        "Shared Crush data directories are preserved when another tracked project still references the same data dir.",
      );
    }

    return {
      notes,
      projects,
      providerId: "crush",
      providerName: "Crush",
      sessions,
      warnings: sessions.length
        ? [
            "Reported size for Crush sessions is a logical estimate from SQLite content. crush.db files may not shrink immediately without VACUUM.",
          ]
        : [],
    };
  },
};

function buildCrushDataDirContexts(trackedProjects: CrushTrackedProject[]): {
  contexts: CrushDataDirContext[];
  preservedSharedDataDir: boolean;
} {
  const projectsByDataDir = new Map<string, CrushTrackedProject[]>();
  let preservedSharedDataDir = false;

  for (const project of trackedProjects) {
    if (!project.dataDir) {
      continue;
    }

    const projects = projectsByDataDir.get(project.dataDir) ?? [];
    projects.push(project);
    projectsByDataDir.set(project.dataDir, projects);
  }

  const contexts: CrushDataDirContext[] = [];

  for (const [dataDir, projects] of projectsByDataDir) {
    const scannableProjects = projects.filter(
      (project) => project.projectExists && !project.ignored,
    );

    if (projects.length > 1 && scannableProjects.length) {
      preservedSharedDataDir = true;
    }

    contexts.push({
      dataDir,
      representativeProjectPath: scannableProjects[0]?.path ?? null,
    });
  }

  return {
    contexts,
    preservedSharedDataDir,
  };
}

function buildCrushSessionTree(rows: CrushSessionRow[]): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>();

  for (const row of rows) {
    if (!row.parentSessionId) {
      continue;
    }

    const children = childrenByParent.get(row.parentSessionId) ?? [];
    children.push(row.id);
    childrenByParent.set(row.parentSessionId, children);
  }

  return childrenByParent;
}

function collectDescendantSessionIds(
  sessionId: string,
  childrenByParent: Map<string, string[]>,
): string[] {
  const collectedIds = new Set<string>();
  const pendingIds = [sessionId];

  while (pendingIds.length) {
    const nextId = pendingIds.pop();

    if (!nextId || collectedIds.has(nextId)) {
      continue;
    }

    collectedIds.add(nextId);

    for (const childId of childrenByParent.get(nextId) ?? []) {
      pendingIds.push(childId);
    }
  }

  return Array.from(collectedIds);
}

function collectReasons(updatedAt: Date, cutoffDate: Date | null): string[] {
  if (!cutoffDate) {
    return [];
  }

  return updatedAt <= cutoffDate ? ["older than threshold"] : [];
}

async function deleteCrushSessions(
  dataDir: string,
  sessionIds: Set<string>,
): Promise<void> {
  const databasePath = join(dataDir, "crush.db");

  if (!(await pathExists(databasePath)) || !sessionIds.size) {
    return;
  }

  const database = new Database(databasePath, { timeout: 5000 });

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN");

    const deleteSession = database.prepare("DELETE FROM sessions WHERE id = ?");

    for (const sessionId of sessionIds) {
      deleteSession.run(sessionId);
    }

    database.exec("COMMIT");
    database.pragma("wal_checkpoint(TRUNCATE)");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function estimateCrushSessionBytes(
  descendantSessionIds: string[],
  rowsById: Map<string, CrushSessionRow>,
  messageBytesBySessionId: Map<string, number>,
  fileBytesBySessionId: Map<string, number>,
  readFileBytesBySessionId: Map<string, number>,
): number {
  let bytes = 0;

  for (const sessionId of descendantSessionIds) {
    const row = rowsById.get(sessionId);

    if (row) {
      bytes += row.title.length + (row.todos?.length ?? 0);
    }

    bytes += messageBytesBySessionId.get(sessionId) ?? 0;
    bytes += fileBytesBySessionId.get(sessionId) ?? 0;
    bytes += readFileBytesBySessionId.get(sessionId) ?? 0;
  }

  return bytes;
}

function getCutoffDate(options: CliOptions): Date | null {
  if (!options.olderThanDays) {
    return null;
  }

  const cutoff = new Date(options.now);
  cutoff.setDate(cutoff.getDate() - options.olderThanDays);
  return cutoff;
}

async function loadCrushProjects(
  ignoredProjectTerms: string[] = [],
): Promise<CrushTrackedProject[]> {
  const file = await readJsonFile<CrushProjectFile>(CRUSH_PROJECTS_PATH).catch(
    () => ({ projects: [] }),
  );
  const projects = file.projects ?? [];
  const trackedProjects = await Promise.all(
    projects.map(async (project) => {
      const projectPath = project.path?.trim() ?? "";
      const projectName = projectPath ? basename(projectPath) : null;

      return {
        dataDir: project.data_dir?.trim() ?? null,
        ignored: matchesIgnoredProject(
          projectPath || null,
          projectName,
          ignoredProjectTerms,
        ),
        lastAccessed: parseDate(project.last_accessed),
        path: projectPath,
        projectExists: projectPath ? await pathExists(projectPath) : false,
      };
    }),
  );

  return trackedProjects.filter((project) => project.path);
}

function mapCrushSizeRows(rows: unknown[]): Map<string, number> {
  const sizeRows = rows
    .map((row) => parseCrushSizeRow(row))
    .filter((row): row is CrushSizeRow => row !== null);
  const sizesBySessionId = new Map<string, number>();

  for (const row of sizeRows) {
    sizesBySessionId.set(row.sessionId, row.totalBytes);
  }

  return sizesBySessionId;
}

function parseCrushSessionRow(row: unknown): CrushSessionRow | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const rawRow = row as Record<string, unknown>;
  const createdAt = Number(rawRow.created_at);
  const id = typeof rawRow.id === "string" ? rawRow.id : null;
  const parentSessionId =
    typeof rawRow.parent_session_id === "string" && rawRow.parent_session_id
      ? rawRow.parent_session_id
      : null;
  const title = typeof rawRow.title === "string" ? rawRow.title : null;
  const todos = typeof rawRow.todos === "string" ? rawRow.todos : null;
  const updatedAt = Number(rawRow.updated_at);

  if (
    !id ||
    !title ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(updatedAt)
  ) {
    return null;
  }

  return {
    createdAt,
    id,
    parentSessionId,
    title,
    todos,
    updatedAt,
  };
}

function parseCrushSizeRow(row: unknown): CrushSizeRow | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const rawRow = row as Record<string, unknown>;
  const sessionId =
    typeof rawRow.session_id === "string" ? rawRow.session_id : null;
  const totalBytes = Number(rawRow.total_bytes ?? 0);

  if (!sessionId || !Number.isFinite(totalBytes)) {
    return null;
  }

  return {
    sessionId,
    totalBytes,
  };
}

async function scanCrushProjects(
  trackedProjects: CrushTrackedProject[],
  options: CliOptions,
): Promise<ProjectCandidate<CrushProjectInternal>[]> {
  const projects: ProjectCandidate<CrushProjectInternal>[] = [];
  let projectsFileStat: Date | null = null;

  for (const project of trackedProjects) {
    if (project.ignored || project.projectExists || !options.includeOrphaned) {
      continue;
    }

    const hasSharedExistingDataDir = trackedProjects.some(
      (otherProject) =>
        otherProject.path !== project.path &&
        otherProject.dataDir &&
        otherProject.dataDir === project.dataDir &&
        otherProject.projectExists,
    );
    const removeDataDir = Boolean(project.dataDir) && !hasSharedExistingDataDir;
    const bytes =
      removeDataDir && project.dataDir ? await getPathSize(project.dataDir) : 0;

    if (!matchesSizeThreshold(bytes, options.largerThanBytes)) {
      continue;
    }

    projectsFileStat ??= await safeStat(CRUSH_PROJECTS_PATH);

    projects.push({
      bytes,
      createdAt: null,
      displayName: basename(project.path),
      internal: {
        dataDir: project.dataDir,
        projectPath: project.path,
        removeDataDir,
      },
      key: project.path,
      projectPath: project.path,
      providerId: "crush",
      providerName: "Crush",
      reasons: ["missing project root"],
      updatedAt:
        project.lastAccessed ??
        (project.dataDir ? await safeStat(project.dataDir) : null) ??
        projectsFileStat,
    });
  }

  return projects;
}

async function scanCrushSessions(
  contexts: CrushDataDirContext[],
  cutoffDate: Date | null,
  options: CliOptions,
): Promise<SessionCandidate<CrushSessionInternal>[]> {
  const sessions: SessionCandidate<CrushSessionInternal>[] = [];

  for (const context of contexts) {
    if (!context.representativeProjectPath) {
      continue;
    }

    const databasePath = join(context.dataDir, "crush.db");

    if (!(await pathExists(databasePath))) {
      continue;
    }

    const database = new Database(databasePath, {
      readonly: true,
      timeout: 5000,
    });

    try {
      const sessionRows = database
        .prepare(
          [
            "SELECT id, parent_session_id, title, created_at, updated_at, todos",
            "FROM sessions",
            "ORDER BY updated_at DESC",
          ].join(" "),
        )
        .all()
        .map((row) => parseCrushSessionRow(row))
        .filter((row): row is CrushSessionRow => row !== null);

      if (!sessionRows.length) {
        continue;
      }

      const rowsById = new Map(sessionRows.map((row) => [row.id, row]));
      const childrenByParent = buildCrushSessionTree(sessionRows);
      const messageBytesBySessionId = mapCrushSizeRows(
        database
          .prepare(
            [
              "SELECT session_id,",
              "COALESCE(SUM(LENGTH(parts) + COALESCE(LENGTH(model), 0) + COALESCE(LENGTH(provider), 0)), 0) AS total_bytes",
              "FROM messages",
              "GROUP BY session_id",
            ].join(" "),
          )
          .all(),
      );
      const fileBytesBySessionId = mapCrushSizeRows(
        database
          .prepare(
            [
              "SELECT session_id,",
              "COALESCE(SUM(LENGTH(path) + LENGTH(content)), 0) AS total_bytes",
              "FROM files",
              "GROUP BY session_id",
            ].join(" "),
          )
          .all(),
      );
      const readFileBytesBySessionId = mapCrushSizeRows(
        database
          .prepare(
            [
              "SELECT session_id,",
              "COALESCE(SUM(LENGTH(path)), 0) AS total_bytes",
              "FROM read_files",
              "GROUP BY session_id",
            ].join(" "),
          )
          .all(),
      );
      const topLevelRows = sessionRows.filter((row) => !row.parentSessionId);

      for (const row of topLevelRows) {
        const descendantSessionIds = collectDescendantSessionIds(
          row.id,
          childrenByParent,
        );
        const updatedAt = resolveCrushSessionUpdatedAt(
          descendantSessionIds,
          rowsById,
        );
        const reasons = collectReasons(updatedAt, cutoffDate);

        if (!reasons.length) {
          continue;
        }

        const bytes = estimateCrushSessionBytes(
          descendantSessionIds,
          rowsById,
          messageBytesBySessionId,
          fileBytesBySessionId,
          readFileBytesBySessionId,
        );

        if (!matchesSizeThreshold(bytes, options.largerThanBytes)) {
          continue;
        }

        sessions.push({
          bytes,
          createdAt: parseDate(row.createdAt),
          current: false,
          id: row.id,
          internal: {
            dataDir: context.dataDir,
            sessionIds: descendantSessionIds,
          },
          projectName: basename(context.representativeProjectPath),
          projectPath: context.representativeProjectPath,
          providerId: "crush",
          providerName: "Crush",
          reasons,
          title: row.title,
          updatedAt,
        });
      }
    } finally {
      database.close();
    }
  }

  return sessions;
}

function resolveCrushSessionUpdatedAt(
  sessionIds: string[],
  rowsById: Map<string, CrushSessionRow>,
): Date {
  let timestamp = 0;

  for (const sessionId of sessionIds) {
    const session = rowsById.get(sessionId);

    if (session && session.updatedAt > timestamp) {
      timestamp = session.updatedAt;
    }
  }

  return parseDate(timestamp) ?? new Date(0);
}
