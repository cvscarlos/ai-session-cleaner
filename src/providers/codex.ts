import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import Database from "libsql";
import type {
  AgentProvider,
  CliOptions,
  ProviderApplyResult,
  ProviderScanResult,
  SessionCandidate,
} from "../types.js";
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
  rewriteJsonLines,
} from "../utils.js";

interface CodexSessionInternal {
  historyPath: string;
  logsDbPath: string | null;
  shellSnapshotPaths: string[];
  stateDbPath: string;
  threadId: string;
}

interface ThreadRow {
  archived: number;
  created_at: number;
  cwd: string;
  id: string;
  title: string;
  updated_at: number;
}

const CODEX_ROOT = expandHome("~/.codex");
const HISTORY_PATH = join(CODEX_ROOT, "history.jsonl");
const SHELL_SNAPSHOTS_ROOT = join(CODEX_ROOT, "shell_snapshots");

export const codexProvider: AgentProvider<CodexSessionInternal> = {
  async apply(
    result: ProviderScanResult<CodexSessionInternal>,
    options: CliOptions,
  ): Promise<ProviderApplyResult> {
    const stateDbPath = result.sessions[0]?.internal.stateDbPath;

    if (!stateDbPath) {
      return {
        deletedBytes: 0,
        deletedProjects: 0,
        deletedSessions: 0,
        notes: [],
        providerId: result.providerId,
        providerName: result.providerName,
        warnings: [],
      };
    }

    const sessionIds = result.sessions.map((session) => session.id);
    const sessionIdSet = new Set(sessionIds);
    const logsDbPath = result.sessions[0]?.internal.logsDbPath ?? null;
    const shellSnapshotPaths = result.sessions.flatMap(
      (session) => session.internal.shellSnapshotPaths,
    );
    const notes = [
      "SQLite rows were deleted from Codex state databases. Physical database files may not shrink until SQLite runs VACUUM.",
    ];
    const warnings: string[] = [];

    await rewriteJsonLines(HISTORY_PATH, (parsed) => {
      const sessionId = parsed.session_id;
      return typeof sessionId !== "string" || !sessionIdSet.has(sessionId);
    });
    await Promise.all(shellSnapshotPaths.map((path) => removePath(path)));

    const stateDb = new Database(stateDbPath, { timeout: 5000 });

    try {
      stateDb.exec("BEGIN");

      const deleteThreadDynamicTools = stateDb.prepare(
        "DELETE FROM thread_dynamic_tools WHERE thread_id = ?",
      );
      const deleteStage1Outputs = stateDb.prepare(
        "DELETE FROM stage1_outputs WHERE thread_id = ?",
      );
      const deleteLogs = stateDb.prepare(
        "DELETE FROM logs WHERE thread_id = ?",
      );
      const deleteSpawnEdges = stateDb.prepare(
        "DELETE FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ?",
      );
      const clearAgentJobAssignments = stateDb.prepare(
        "UPDATE agent_job_items SET assigned_thread_id = NULL WHERE assigned_thread_id = ?",
      );
      const deleteThread = stateDb.prepare("DELETE FROM threads WHERE id = ?");

      for (const sessionId of sessionIds) {
        deleteThreadDynamicTools.run(sessionId);
        deleteStage1Outputs.run(sessionId);
        deleteLogs.run(sessionId);
        deleteSpawnEdges.run(sessionId, sessionId);
        clearAgentJobAssignments.run(sessionId);
        deleteThread.run(sessionId);
      }

      stateDb.exec("COMMIT");
      stateDb.pragma("wal_checkpoint(TRUNCATE)");
    } catch (error) {
      stateDb.exec("ROLLBACK");
      throw error;
    } finally {
      stateDb.close();
    }

    if (logsDbPath && (await pathExists(logsDbPath))) {
      const logsDb = new Database(logsDbPath, { timeout: 5000 });

      try {
        logsDb.exec("BEGIN");
        const deleteLogs = logsDb.prepare(
          "DELETE FROM logs WHERE thread_id = ?",
        );

        for (const sessionId of sessionIds) {
          deleteLogs.run(sessionId);
        }

        logsDb.exec("COMMIT");
        logsDb.pragma("wal_checkpoint(TRUNCATE)");
      } catch (error) {
        logsDb.exec("ROLLBACK");
        throw error;
      } finally {
        logsDb.close();
      }
    }

    if (options.compactSqlite) {
      const sqlitePaths = [stateDbPath, ...(logsDbPath ? [logsDbPath] : [])];

      for (const sqlitePath of sqlitePaths) {
        if (!(await pathExists(sqlitePath))) {
          continue;
        }

        try {
          await vacuumDatabase(sqlitePath);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          warnings.push(
            `SQLite compaction failed for ${sqlitePath}: ${message}`,
          );
        }
      }

      if (!warnings.length) {
        notes.push("Codex SQLite databases were compacted with VACUUM.");
      }
    }

    return {
      deletedBytes: result.sessions.reduce(
        (sum, session) => sum + session.bytes,
        0,
      ),
      deletedProjects: 0,
      deletedSessions: result.sessions.length,
      notes,
      providerId: result.providerId,
      providerName: result.providerName,
      warnings,
    };
  },
  id: "codex",
  name: "Codex",
  async scan(
    options: CliOptions,
  ): Promise<ProviderScanResult<CodexSessionInternal> | null> {
    if (!(await pathExists(CODEX_ROOT))) {
      return null;
    }

    const stateDbPath = await findLatestDatabase(/^state_(\d+)\.sqlite$/u);

    if (!stateDbPath) {
      return null;
    }

    const logsDbPath = await findLatestDatabase(/^logs_(\d+)\.sqlite$/u);
    const shellSnapshotsByThread = await buildShellSnapshotMap();
    const historyBytesByThread = await buildHistoryByteMap();
    const currentThreadId = process.env.CODEX_THREAD_ID ?? null;
    const cutoffDate = getCutoffDate(options);
    const stateDb = new Database(stateDbPath, {
      readonly: true,
      timeout: 5000,
    });
    const rows = stateDb
      .prepare(
        "SELECT id, title, cwd, created_at, updated_at, archived FROM threads ORDER BY updated_at DESC",
      )
      .all() as unknown as ThreadRow[];

    stateDb.close();

    const sessions: SessionCandidate<CodexSessionInternal>[] = [];

    for (const row of rows) {
      if (row.id === currentThreadId) {
        continue;
      }

      const updatedAt = parseDate(row.updated_at) ?? new Date(0);
      const projectName = row.cwd ? basename(row.cwd) : null;

      if (
        matchesIgnoredProject(
          row.cwd || null,
          projectName,
          options.ignoredProjectTerms,
        )
      ) {
        continue;
      }

      const projectMissing =
        options.includeOrphaned && row.cwd
          ? !(await pathExists(row.cwd))
          : false;
      const reasons = collectReasons(updatedAt, cutoffDate, projectMissing);

      if (!reasons.length) {
        continue;
      }

      const shellSnapshotPaths = shellSnapshotsByThread.get(row.id) ?? [];
      const shellSnapshotBytes = await sumPathSizes(shellSnapshotPaths);
      const historyBytes = historyBytesByThread.get(row.id) ?? 0;
      const bytes = shellSnapshotBytes + historyBytes;

      if (!matchesSizeThreshold(bytes, options.largerThanBytes)) {
        continue;
      }

      sessions.push({
        bytes,
        createdAt: parseDate(row.created_at),
        current: false,
        id: row.id,
        internal: {
          historyPath: HISTORY_PATH,
          logsDbPath,
          shellSnapshotPaths,
          stateDbPath,
          threadId: row.id,
        },
        projectName,
        projectPath: row.cwd || null,
        providerId: "codex",
        providerName: "Codex",
        reasons,
        title: excerpt(row.title),
        updatedAt,
      });
    }

    const warnings = sessions.length
      ? [
          `Reported size excludes SQLite free pages. Only history entries and ${formatBytes(
            sessions.reduce((sum, session) => sum + session.bytes, 0),
          )} of shell snapshot/history bytes are directly reclaimable.`,
        ]
      : [];

    return {
      notes: [],
      projects: [],
      providerId: "codex",
      providerName: "Codex",
      sessions,
      warnings,
    };
  },
};

async function buildHistoryByteMap(): Promise<Map<string, number>> {
  const historyBytesByThread = new Map<string, number>();

  if (!(await pathExists(HISTORY_PATH))) {
    return historyBytesByThread;
  }

  const content = await readFile(HISTORY_PATH, "utf8");

  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }

    const match = /"session_id":"([^"]+)"/u.exec(line);

    if (!match?.[1]) {
      continue;
    }

    const currentBytes = historyBytesByThread.get(match[1]) ?? 0;
    historyBytesByThread.set(
      match[1],
      currentBytes + Buffer.byteLength(`${line}\n`),
    );
  }

  return historyBytesByThread;
}

async function buildShellSnapshotMap(): Promise<Map<string, string[]>> {
  const shellSnapshotsByThread = new Map<string, string[]>();

  if (!(await pathExists(SHELL_SNAPSHOTS_ROOT))) {
    return shellSnapshotsByThread;
  }

  const shellSnapshots = await readdir(SHELL_SNAPSHOTS_ROOT);

  for (const shellSnapshot of shellSnapshots) {
    const threadId = shellSnapshot.split(".", 1)[0];

    if (!threadId) {
      continue;
    }

    const snapshots = shellSnapshotsByThread.get(threadId) ?? [];
    snapshots.push(join(SHELL_SNAPSHOTS_ROOT, shellSnapshot));
    shellSnapshotsByThread.set(threadId, snapshots);
  }

  return shellSnapshotsByThread;
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

async function findLatestDatabase(pattern: RegExp): Promise<string | null> {
  const entries = await readdir(CODEX_ROOT);
  let latestPath: string | null = null;
  let latestIndex = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const match = pattern.exec(entry);

    if (!match?.[1]) {
      continue;
    }

    const index = Number(match[1]);

    if (index > latestIndex) {
      latestIndex = index;
      latestPath = join(CODEX_ROOT, entry);
    }
  }

  return latestPath;
}

function getCutoffDate(options: CliOptions): Date | null {
  if (!options.olderThanDays) {
    return null;
  }

  return new Date(
    options.now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000,
  );
}

async function sumPathSizes(paths: string[]): Promise<number> {
  const sizes = await Promise.all(paths.map((path) => getPathSize(path)));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function vacuumDatabase(path: string): Promise<void> {
  const database = new Database(path, { timeout: 5000 });

  try {
    database.exec("VACUUM");
  } finally {
    database.close();
  }
}
