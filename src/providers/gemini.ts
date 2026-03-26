import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AgentProvider,
  CliOptions,
  ProjectCandidate,
  ProviderApplyResult,
  ProviderScanResult,
  SessionCandidate,
} from "../types.js";
import {
  excerpt,
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

interface GeminiChatFile {
  lastUpdated?: string;
  messages?: GeminiMessage[];
  projectHash?: string;
  sessionId?: string;
  startTime?: string;
}

interface GeminiLogEntry {
  message?: string;
  sessionId?: string;
  timestamp?: string;
}

interface GeminiMessage {
  content?: string | GeminiMessagePart[];
  timestamp?: string;
  type?: string;
}

interface GeminiMessagePart {
  text?: string;
}

interface GeminiProjectInternal {
  configProjectPath: string | null;
  path: string | null;
}

interface GeminiSessionInternal {
  logPaths: string[];
  sessionFiles: string[];
  sessionId: string;
  toolOutputDirs: string[];
  topLevelDirs: string[];
}

interface MutableGeminiSession {
  bytes: number;
  createdAt: Date | null;
  id: string;
  logPaths: Set<string>;
  projectHash: string | null;
  projectPath: string | null;
  projectRoots: Set<string>;
  sessionFiles: Set<string>;
  title: string | null;
  toolOutputDirs: Set<string>;
  topLevelDirs: Set<string>;
  updatedAt: Date | null;
}

interface GeminiProjectsFile {
  projects?: Record<string, string>;
}

const GEMINI_ROOT = expandHome("~/.gemini");
const GEMINI_HISTORY_ROOT = join(GEMINI_ROOT, "history");
const GEMINI_PROJECTS_PATH = join(GEMINI_ROOT, "projects.json");
const GEMINI_TMP_ROOT = join(GEMINI_ROOT, "tmp");

export const geminiProvider: AgentProvider<
  GeminiSessionInternal,
  GeminiProjectInternal
> = {
  async apply(
    result: ProviderScanResult<GeminiSessionInternal, GeminiProjectInternal>,
    _options: CliOptions,
  ): Promise<ProviderApplyResult> {
    const deletedPaths = new Set<string>();
    const deletedConfigProjectPaths = new Set<string>();
    const deletedSessionIds = new Set(
      result.sessions.map((session) => session.id),
    );
    const logPaths = new Set<string>();
    const topLevelDirs = new Set<string>();

    for (const session of result.sessions) {
      const internal = session.internal;

      for (const path of internal.sessionFiles) {
        deletedPaths.add(path);
      }
      for (const path of internal.toolOutputDirs) {
        deletedPaths.add(path);
      }
      for (const path of internal.logPaths) {
        logPaths.add(path);
      }
      for (const path of internal.topLevelDirs) {
        topLevelDirs.add(path);
      }
    }

    for (const project of result.projects) {
      if (project.internal.path) {
        deletedPaths.add(project.internal.path);
      }

      if (project.internal.configProjectPath) {
        deletedConfigProjectPaths.add(project.internal.configProjectPath);
      }
    }

    await Promise.all(Array.from(deletedPaths, (path) => removePath(path)));

    for (const logPath of logPaths) {
      if (!(await pathExists(logPath))) {
        continue;
      }

      const logEntries = await readJsonFile<GeminiLogEntry[]>(logPath).catch(
        () => [],
      );
      const nextEntries = logEntries.filter((entry) => {
        const sessionId = entry.sessionId ?? "";
        return !deletedSessionIds.has(sessionId);
      });

      if (!nextEntries.length) {
        await removePath(logPath);
        continue;
      }

      await writeJsonFile(logPath, nextEntries);
    }

    await Promise.all(
      Array.from(topLevelDirs, (path) => cleanupGeminiTopLevelDir(path)),
    );
    await rewriteGeminiProjectsFile(deletedConfigProjectPaths);

    return {
      deletedBytes:
        result.sessions.reduce((sum, session) => sum + session.bytes, 0) +
        result.projects.reduce((sum, project) => sum + project.bytes, 0),
      deletedProjects: result.projects.length,
      deletedSessions: result.sessions.length,
      notes: [],
      providerId: result.providerId,
      providerName: result.providerName,
      warnings: [],
    };
  },
  id: "gemini",
  name: "Gemini",
  async scan(
    options: CliOptions,
  ): Promise<ProviderScanResult<
    GeminiSessionInternal,
    GeminiProjectInternal
  > | null> {
    if (!(await pathExists(GEMINI_TMP_ROOT))) {
      return null;
    }

    const cutoffDate = getCutoffDate(options);
    const sessionsById = new Map<string, MutableGeminiSession>();
    const { namedTmpDirs, projectHashToRoot } =
      await buildGeminiProjectContext();
    const topLevelEntries = await readdir(GEMINI_TMP_ROOT, {
      withFileTypes: true,
    });

    for (const topLevelEntry of topLevelEntries) {
      if (!topLevelEntry.isDirectory()) {
        continue;
      }

      await mergeGeminiTopLevelDir(
        join(GEMINI_TMP_ROOT, topLevelEntry.name),
        namedTmpDirs,
        projectHashToRoot,
        sessionsById,
      );
    }

    const sessions: SessionCandidate<GeminiSessionInternal>[] = [];

    for (const session of sessionsById.values()) {
      session.projectPath = resolveProjectPath(
        session.projectPath,
        session.projectHash,
        projectHashToRoot,
      );
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
          logPaths: Array.from(session.logPaths),
          sessionFiles: Array.from(session.sessionFiles),
          sessionId: session.id,
          toolOutputDirs: Array.from(session.toolOutputDirs),
          topLevelDirs: Array.from(session.topLevelDirs),
        },
        projectName,
        projectPath: session.projectPath,
        providerId: "gemini",
        providerName: "Gemini",
        reasons,
        title: session.title,
        updatedAt,
      });
    }

    const projects = await scanGeminiProjectContainers(options);

    return {
      notes: [
        "Gemini session files are grouped from ~/.gemini/tmp. Shared project logs are rewritten when matching sessions are deleted.",
      ],
      projects,
      providerId: "gemini",
      providerName: "Gemini",
      sessions,
      warnings: [],
    };
  },
};

async function buildNamedTmpProjectMap(): Promise<Map<string, string>> {
  const namedProjectRoots = new Map<string, string>();

  if (!(await pathExists(GEMINI_TMP_ROOT))) {
    return namedProjectRoots;
  }

  const entries = await readdir(GEMINI_TMP_ROOT, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectRootFile = join(GEMINI_TMP_ROOT, entry.name, ".project_root");

    if (!(await pathExists(projectRootFile))) {
      continue;
    }

    const projectRoot = (await readFile(projectRootFile, "utf8")).trim();

    if (!projectRoot) {
      continue;
    }

    namedProjectRoots.set(join(GEMINI_TMP_ROOT, entry.name), projectRoot);
  }

  return namedProjectRoots;
}

async function buildGeminiProjectContext(): Promise<{
  namedTmpDirs: Map<string, string>;
  projectHashToRoot: Map<string, string>;
}> {
  const namedTmpDirs = await buildNamedTmpProjectMap();
  const projectHashToRoot = new Map<string, string>();
  const projectRoots = new Set(namedTmpDirs.values());
  const historyEntries = await readdir(GEMINI_HISTORY_ROOT, {
    withFileTypes: true,
  }).catch(() => []);

  for (const entry of historyEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectRootFile = join(
      GEMINI_HISTORY_ROOT,
      entry.name,
      ".project_root",
    );

    if (!(await pathExists(projectRootFile))) {
      continue;
    }

    const projectRoot = (await readFile(projectRootFile, "utf8")).trim();

    if (!projectRoot) {
      continue;
    }

    projectRoots.add(projectRoot);
  }

  for (const projectRoot of projectRoots) {
    projectHashToRoot.set(hashProjectRoot(projectRoot), projectRoot);
  }

  return {
    namedTmpDirs,
    projectHashToRoot,
  };
}

async function cleanupGeminiTopLevelDir(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return;
  }

  const remainingEntries = await readdir(path).catch(() => []);

  if (!remainingEntries.length) {
    await removePath(path);
    return;
  }

  const significantEntries = remainingEntries.filter(
    (entry) => entry !== ".project_root",
  );

  if (!significantEntries.length) {
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

function createGeminiSession(sessionId: string): MutableGeminiSession {
  return {
    bytes: 0,
    createdAt: null,
    id: sessionId,
    logPaths: new Set<string>(),
    projectHash: null,
    projectPath: null,
    projectRoots: new Set<string>(),
    sessionFiles: new Set<string>(),
    title: null,
    toolOutputDirs: new Set<string>(),
    topLevelDirs: new Set<string>(),
    updatedAt: null,
  };
}

function hashProjectRoot(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex");
}

function extractGeminiTitle(chat: GeminiChatFile): string | null {
  const messages = chat.messages ?? [];

  for (const message of messages) {
    if (message.type !== "user") {
      continue;
    }

    if (typeof message.content === "string") {
      return excerpt(message.content);
    }

    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join(" ")
        .trim();

      return excerpt(text);
    }
  }

  return null;
}

function getCutoffDate(options: CliOptions): Date | null {
  if (!options.olderThanDays) {
    return null;
  }

  return new Date(
    options.now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000,
  );
}

async function mergeGeminiTopLevelDir(
  topLevelDir: string,
  namedTmpDirs: Map<string, string>,
  projectHashToRoot: Map<string, string>,
  sessionsById: Map<string, MutableGeminiSession>,
): Promise<void> {
  const chatsDir = join(topLevelDir, "chats");
  const logPath = join(topLevelDir, "logs.json");
  const projectPath = namedTmpDirs.get(topLevelDir) ?? null;

  if (!(await pathExists(chatsDir))) {
    return;
  }

  const chatFiles = await readdir(chatsDir);

  for (const chatFile of chatFiles) {
    if (!chatFile.endsWith(".json")) {
      continue;
    }

    const chatPath = join(chatsDir, chatFile);
    const chat = await readJsonFile<GeminiChatFile>(chatPath).catch(
      (): GeminiChatFile => ({}),
    );
    const sessionId = chat.sessionId;

    if (!sessionId) {
      continue;
    }

    const session =
      sessionsById.get(sessionId) ?? createGeminiSession(sessionId);
    const updatedAt =
      parseDate(chat.lastUpdated) ??
      parseDate(
        chat.messages?.find(
          (message: GeminiMessage) => typeof message.timestamp === "string",
        )?.timestamp ?? null,
      ) ??
      (await safeStat(chatPath));

    session.bytes += await getPathSize(chatPath);
    session.createdAt = chooseEarliestDate(
      session.createdAt,
      parseDate(chat.startTime),
    );
    session.projectHash = session.projectHash ?? chat.projectHash ?? null;
    session.projectPath = session.projectPath ?? projectPath;
    session.title = session.title ?? extractGeminiTitle(chat);
    session.updatedAt = chooseLatestDate(session.updatedAt, updatedAt);
    session.sessionFiles.add(chatPath);
    session.topLevelDirs.add(topLevelDir);

    if (projectPath) {
      session.projectRoots.add(projectPath);
    }

    if (chat.projectHash && projectPath) {
      projectHashToRoot.set(chat.projectHash, projectPath);
    }

    if (await pathExists(logPath)) {
      session.logPaths.add(logPath);
    }

    const toolOutputDir = join(
      topLevelDir,
      "tool-outputs",
      `session-${sessionId}`,
    );
    if (await pathExists(toolOutputDir)) {
      session.bytes += await getPathSize(toolOutputDir);
      session.toolOutputDirs.add(toolOutputDir);
    }

    sessionsById.set(sessionId, session);
  }
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

function resolveProjectPath(
  projectPath: string | null,
  projectHash: string | null,
  projectHashToRoot: Map<string, string>,
): string | null {
  if (projectPath) {
    return projectPath;
  }

  if (!projectHash) {
    return null;
  }

  return projectHashToRoot.get(projectHash) ?? null;
}

async function scanGeminiProjectContainers(
  options: CliOptions,
): Promise<ProjectCandidate<GeminiProjectInternal>[]> {
  if (!options.includeOrphaned) {
    return [];
  }

  const projects: ProjectCandidate<GeminiProjectInternal>[] = [];
  const historyEntries = await readdir(GEMINI_HISTORY_ROOT, {
    withFileTypes: true,
  }).catch(() => []);

  for (const entry of historyEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectDir = join(GEMINI_HISTORY_ROOT, entry.name);
    const projectRootFile = join(projectDir, ".project_root");

    if (!(await pathExists(projectRootFile))) {
      continue;
    }

    const projectPath = (await readFile(projectRootFile, "utf8")).trim();

    if (projectPath && (await pathExists(projectPath))) {
      continue;
    }

    if (
      matchesIgnoredProject(
        projectPath || null,
        entry.name,
        options.ignoredProjectTerms,
      )
    ) {
      continue;
    }

    const bytes = await getPathSize(projectDir);

    if (!matchesSizeThreshold(bytes, options.largerThanBytes)) {
      continue;
    }

    projects.push({
      bytes,
      createdAt: null,
      displayName: entry.name,
      internal: {
        configProjectPath: null,
        path: projectDir,
      },
      key: projectDir,
      projectPath: projectPath || null,
      providerId: "gemini",
      providerName: "Gemini",
      reasons: ["missing project root"],
      updatedAt: await safeStat(projectDir),
    });
  }

  const configProjects = await scanGeminiProjectsFile(options);

  return [...projects, ...configProjects];
}

async function rewriteGeminiProjectsFile(
  projectPaths: Set<string>,
): Promise<void> {
  if (!projectPaths.size || !(await pathExists(GEMINI_PROJECTS_PATH))) {
    return;
  }

  const file = await readJsonFile<GeminiProjectsFile>(
    GEMINI_PROJECTS_PATH,
  ).catch((): GeminiProjectsFile => ({}));
  const existingProjects = file.projects ?? {};
  const nextProjects: Record<string, string> = {};

  for (const [projectPath, projectName] of Object.entries(existingProjects)) {
    if (!projectPaths.has(projectPath)) {
      nextProjects[projectPath] = projectName;
    }
  }

  if (
    Object.keys(nextProjects).length === Object.keys(existingProjects).length
  ) {
    return;
  }

  await writeJsonFile(GEMINI_PROJECTS_PATH, {
    ...file,
    projects: nextProjects,
  });
}

async function scanGeminiProjectsFile(
  options: CliOptions,
): Promise<ProjectCandidate<GeminiProjectInternal>[]> {
  if (!options.includeOrphaned || !(await pathExists(GEMINI_PROJECTS_PATH))) {
    return [];
  }

  const file = await readJsonFile<GeminiProjectsFile>(
    GEMINI_PROJECTS_PATH,
  ).catch((): GeminiProjectsFile => ({}));
  const updatedAt = await safeStat(GEMINI_PROJECTS_PATH);
  const projects: ProjectCandidate<GeminiProjectInternal>[] = [];

  for (const [projectPath, projectName] of Object.entries(
    file.projects ?? {},
  )) {
    if (await pathExists(projectPath)) {
      continue;
    }

    if (
      matchesIgnoredProject(
        projectPath,
        projectName || basename(projectPath),
        options.ignoredProjectTerms,
      )
    ) {
      continue;
    }

    if (!matchesSizeThreshold(0, options.largerThanBytes)) {
      continue;
    }

    projects.push({
      bytes: 0,
      createdAt: null,
      displayName: projectName || basename(projectPath),
      internal: {
        configProjectPath: projectPath,
        path: null,
      },
      key: `gemini-projects:${projectPath}`,
      projectPath,
      providerId: "gemini",
      providerName: "Gemini",
      reasons: ["missing project root", "global project metadata"],
      updatedAt,
    });
  }

  return projects;
}
