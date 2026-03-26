import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
  getPathSize,
  getVsCodeGlobalStorageDirectory,
  matchesIgnoredProject,
  matchesSizeThreshold,
  parseDate,
  parseFlatYaml,
  pathExists,
  removePath,
  safeStat,
  writeJsonFile,
  writeTextFile,
} from "../utils.js";

interface CopilotJsonlInfo {
  createdAt: Date | null;
  projectPath: string | null;
  title: string | null;
  updatedAt: Date | null;
}

interface CopilotSessionInternal {
  directoryPath: string | null;
  logPath: string | null;
  rootJsonlPath: string | null;
  sessionId: string;
}

interface MutableCopilotSession {
  bytes: number;
  createdAt: Date | null;
  directoryPath: string | null;
  id: string;
  logPath: string | null;
  projectPath: string | null;
  rootJsonlPath: string | null;
  title: string | null;
  updatedAt: Date | null;
}

const COPILOT_ROOT = expandHome("~/.copilot");
const COPILOT_LOGS_ROOT = join(COPILOT_ROOT, "logs");
const COPILOT_SESSION_ROOT = join(COPILOT_ROOT, "session-state");
const COPILOT_GLOBAL_STORAGE_ROOT = getVsCodeGlobalStorageDirectory(
  "github.copilot-chat",
);
const COPILOT_OLD_SESSIONS_PATH = join(
  COPILOT_GLOBAL_STORAGE_ROOT,
  "copilot.cli.oldGlobalSessions.json",
);
const COPILOT_SESSION_METADATA_PATH = join(
  COPILOT_GLOBAL_STORAGE_ROOT,
  "copilotCli",
  "copilotcli.session.metadata.json",
);

export const copilotProvider: AgentProvider<CopilotSessionInternal> = {
  async apply(
    result: ProviderScanResult<CopilotSessionInternal>,
    _options: CliOptions,
  ): Promise<ProviderApplyResult> {
    const sessionIds = new Set(result.sessions.map((session) => session.id));
    const deletedPaths = new Set<string>();

    for (const session of result.sessions) {
      const internal = session.internal;

      if (internal.directoryPath) {
        deletedPaths.add(internal.directoryPath);
      }
      if (internal.rootJsonlPath) {
        deletedPaths.add(internal.rootJsonlPath);
      }
      if (internal.logPath) {
        deletedPaths.add(internal.logPath);
      }
    }

    await Promise.all(Array.from(deletedPaths, (path) => removePath(path)));
    await cleanupSessionMetadata(sessionIds);

    return {
      deletedBytes: result.sessions.reduce(
        (sum, session) => sum + session.bytes,
        0,
      ),
      deletedProjects: 0,
      deletedSessions: result.sessions.length,
      notes: [
        "Only Copilot CLI session-state data was removed. VS Code workspaceStorage data was left untouched.",
      ],
      providerId: result.providerId,
      providerName: result.providerName,
      warnings: [],
    };
  },
  id: "copilot",
  name: "Copilot",
  async scan(
    options: CliOptions,
  ): Promise<ProviderScanResult<CopilotSessionInternal> | null> {
    if (!(await pathExists(COPILOT_SESSION_ROOT))) {
      return null;
    }

    const cutoffDate = getCutoffDate(options);
    const sessionsById = new Map<string, MutableCopilotSession>();
    const entries = await readdir(COPILOT_SESSION_ROOT, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await mergeDirectorySession(sessionsById, entry.name);
      }
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const sessionId = entry.name.slice(0, -".jsonl".length);
      await mergeRootJsonlSession(sessionsById, sessionId);
    }

    const sessions: SessionCandidate<CopilotSessionInternal>[] = [];

    for (const session of sessionsById.values()) {
      const updatedAt = session.updatedAt ?? new Date(0);
      const projectName = session.projectPath
        ? basename(session.projectPath)
        : null;

      if (
        matchesIgnoredProject(
          session.projectPath,
          projectName,
          options.ignoredProjectTerms,
        )
      ) {
        continue;
      }

      const projectMissing =
        options.includeOrphaned && session.projectPath
          ? !(await pathExists(session.projectPath))
          : false;
      const reasons = collectReasons(updatedAt, cutoffDate, projectMissing);

      if (!reasons.length) {
        continue;
      }

      if (!matchesSizeThreshold(session.bytes, options.largerThanBytes)) {
        continue;
      }

      sessions.push({
        bytes: session.bytes,
        createdAt: session.createdAt,
        current: false,
        id: session.id,
        internal: {
          directoryPath: session.directoryPath,
          logPath: session.logPath,
          rootJsonlPath: session.rootJsonlPath,
          sessionId: session.id,
        },
        projectName,
        projectPath: session.projectPath,
        providerId: "copilot",
        providerName: "Copilot",
        reasons,
        title: session.title,
        updatedAt,
      });
    }

    return {
      notes: [],
      projects: [],
      providerId: "copilot",
      providerName: "Copilot",
      sessions,
      warnings: [],
    };
  },
};

async function cleanupSessionMetadata(sessionIds: Set<string>): Promise<void> {
  if (await pathExists(COPILOT_SESSION_METADATA_PATH)) {
    const metadata = await readMetadataObject(COPILOT_SESSION_METADATA_PATH);

    for (const sessionId of sessionIds) {
      delete metadata[sessionId];
    }

    await writeJsonFile(COPILOT_SESSION_METADATA_PATH, metadata);
  }

  if (await pathExists(COPILOT_OLD_SESSIONS_PATH)) {
    const trimmedContent = (
      await readFile(COPILOT_OLD_SESSIONS_PATH, "utf8")
    ).trim();

    if (!trimmedContent) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmedContent) as unknown;

      if (typeof parsed === "string") {
        const nextValue = sessionIds.has(parsed) ? "" : parsed;
        await writeTextFile(COPILOT_OLD_SESSIONS_PATH, nextValue);
        return;
      }

      if (Array.isArray(parsed)) {
        const nextValue = parsed.filter(
          (value): value is unknown =>
            !(typeof value === "string" && sessionIds.has(value)),
        );
        await writeJsonFile(COPILOT_OLD_SESSIONS_PATH, nextValue);
        return;
      }

      if (parsed && typeof parsed === "object") {
        const nextValue = { ...(parsed as Record<string, unknown>) };
        for (const sessionId of sessionIds) {
          delete nextValue[sessionId];
        }
        await writeJsonFile(COPILOT_OLD_SESSIONS_PATH, nextValue);
        return;
      }
    } catch {
      if (sessionIds.has(trimmedContent)) {
        await writeTextFile(COPILOT_OLD_SESSIONS_PATH, "");
      }
    }
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

function createMutableSession(sessionId: string): MutableCopilotSession {
  return {
    bytes: 0,
    createdAt: null,
    directoryPath: null,
    id: sessionId,
    logPath: null,
    projectPath: null,
    rootJsonlPath: null,
    title: null,
    updatedAt: null,
  };
}

function getCutoffDate(options: CliOptions): Date | null {
  if (!options.olderThanDays) {
    return null;
  }

  return new Date(
    options.now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000,
  );
}

async function mergeDirectorySession(
  sessionsById: Map<string, MutableCopilotSession>,
  sessionId: string,
): Promise<void> {
  const directoryPath = join(COPILOT_SESSION_ROOT, sessionId);
  const workspaceYamlPath = join(directoryPath, "workspace.yaml");
  const rootJsonlPath = join(COPILOT_SESSION_ROOT, `${sessionId}.jsonl`);
  const logPath = join(COPILOT_LOGS_ROOT, `session-${sessionId}.log`);
  const session =
    sessionsById.get(sessionId) ?? createMutableSession(sessionId);

  session.directoryPath = directoryPath;
  session.logPath = (await pathExists(logPath)) ? logPath : session.logPath;
  session.rootJsonlPath = (await pathExists(rootJsonlPath))
    ? rootJsonlPath
    : session.rootJsonlPath;
  session.bytes =
    (await getPathSize(directoryPath)) +
    (await getPathSize(rootJsonlPath)) +
    (await getPathSize(logPath));

  if (await pathExists(workspaceYamlPath)) {
    const yaml = parseFlatYaml(await readFile(workspaceYamlPath, "utf8"));
    session.projectPath = yaml.cwd ?? session.projectPath;
    session.title = excerpt(yaml.summary ?? session.title);
    session.updatedAt = chooseLatestDate(
      session.updatedAt,
      parseDate(yaml.updated_at),
    );
    session.createdAt = chooseEarliestDate(
      session.createdAt,
      parseDate(yaml.created_at),
    );
  }

  if (!session.updatedAt || !session.title) {
    const jsonlInfo = await readCopilotJsonlInfo(rootJsonlPath);
    session.createdAt = chooseEarliestDate(
      session.createdAt,
      jsonlInfo.createdAt,
    );
    session.projectPath = session.projectPath ?? jsonlInfo.projectPath;
    session.title = session.title ?? jsonlInfo.title;
    session.updatedAt = chooseLatestDate(
      session.updatedAt,
      jsonlInfo.updatedAt,
    );
  }

  session.updatedAt =
    session.updatedAt ??
    (await safeStat(directoryPath)) ??
    (await safeStat(rootJsonlPath));

  sessionsById.set(sessionId, session);
}

async function mergeRootJsonlSession(
  sessionsById: Map<string, MutableCopilotSession>,
  sessionId: string,
): Promise<void> {
  const rootJsonlPath = join(COPILOT_SESSION_ROOT, `${sessionId}.jsonl`);
  const logPath = join(COPILOT_LOGS_ROOT, `session-${sessionId}.log`);
  const session =
    sessionsById.get(sessionId) ?? createMutableSession(sessionId);
  const jsonlInfo = await readCopilotJsonlInfo(rootJsonlPath);

  session.rootJsonlPath = rootJsonlPath;
  session.logPath = (await pathExists(logPath)) ? logPath : session.logPath;
  session.bytes =
    session.bytes +
    (await getPathSize(rootJsonlPath)) +
    (await getPathSize(logPath));
  session.createdAt = chooseEarliestDate(
    session.createdAt,
    jsonlInfo.createdAt,
  );
  session.projectPath = session.projectPath ?? jsonlInfo.projectPath;
  session.title = session.title ?? jsonlInfo.title;
  session.updatedAt = chooseLatestDate(session.updatedAt, jsonlInfo.updatedAt);

  if (!session.updatedAt) {
    session.updatedAt = await safeStat(rootJsonlPath);
  }

  sessionsById.set(sessionId, session);
}

function chooseEarliestDate(
  current: Date | null,
  candidate: Date | null,
): Date | null {
  if (!candidate) {
    return current;
  }

  if (!current || candidate < current) {
    return candidate;
  }

  return current;
}

function chooseLatestDate(
  current: Date | null,
  candidate: Date | null,
): Date | null {
  if (!candidate) {
    return current;
  }

  if (!current || candidate > current) {
    return candidate;
  }

  return current;
}

async function readCopilotJsonlInfo(path: string): Promise<CopilotJsonlInfo> {
  if (!(await pathExists(path))) {
    return {
      createdAt: null,
      projectPath: null,
      title: null,
      updatedAt: null,
    };
  }

  const content = await readFile(path, "utf8");
  let createdAt: Date | null = null;
  let projectPath: string | null = null;
  let title: string | null = null;
  let updatedAt: Date | null = null;

  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const timestamp = parseDate(
        typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      );
      createdAt = chooseEarliestDate(createdAt, timestamp);
      updatedAt = chooseLatestDate(updatedAt, timestamp);

      const type = typeof parsed.type === "string" ? parsed.type : null;
      const data =
        parsed.data && typeof parsed.data === "object"
          ? (parsed.data as Record<string, unknown>)
          : null;

      if (!title && type === "user.message") {
        title = excerpt(
          typeof data?.content === "string" ? data.content : null,
        );
      }

      if (!projectPath && type === "session.info") {
        const message = typeof data?.message === "string" ? data.message : null;
        const match = message?.match(
          /Folder (.+) has been added to trusted folders\./u,
        );
        projectPath = match?.[1] ?? projectPath;
      }
    } catch {}
  }

  return {
    createdAt,
    projectPath,
    title,
    updatedAt,
  };
}

async function readMetadataObject(
  path: string,
): Promise<Record<string, unknown>> {
  const content = await readFile(path, "utf8");
  const parsed = JSON.parse(content) as unknown;

  return parsed && typeof parsed === "object"
    ? { ...(parsed as Record<string, unknown>) }
    : {};
}
