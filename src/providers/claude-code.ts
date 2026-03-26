import { readdir } from "node:fs/promises";
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

interface ClaudeIndexEntry {
  created?: number | string;
  customTitle?: string;
  fileMtime?: number;
  firstPrompt?: string;
  fullPath?: string;
  modified?: number | string;
  projectPath?: string;
  sessionId?: string;
  summary?: string;
}

interface ClaudeIndexFile {
  entries?: ClaudeIndexEntry[];
  version?: number;
}

interface ClaudeGlobalConfigFile {
  projects?: Record<string, Record<string, unknown>>;
}

interface ClaudeProjectInternal {
  configProjectPath: string | null;
  projectDir: string | null;
}

interface ClaudeSessionInternal {
  indexPath: string;
  projectDir: string;
  relatedPaths: string[];
  sessionId: string;
  todoFiles: string[];
}

const CLAUDE_ROOT = expandHome("~/.claude");
const CLAUDE_CONFIG_PATH = expandHome("~/.claude.json");
const DEBUG_ROOT = join(CLAUDE_ROOT, "debug");
const FILE_HISTORY_ROOT = join(CLAUDE_ROOT, "file-history");
const PROJECTS_ROOT = join(CLAUDE_ROOT, "projects");
const SESSION_ENV_ROOT = join(CLAUDE_ROOT, "session-env");
const TASKS_ROOT = join(CLAUDE_ROOT, "tasks");
const TODOS_ROOT = join(CLAUDE_ROOT, "todos");

export const claudeCodeProvider: AgentProvider<
  ClaudeSessionInternal,
  ClaudeProjectInternal
> = {
  async apply(
    result: ProviderScanResult<ClaudeSessionInternal, ClaudeProjectInternal>,
    _options: CliOptions,
  ): Promise<ProviderApplyResult> {
    const deletedPaths = new Set<string>();
    const deletedConfigProjectPaths = new Set<string>();
    const sessionIdsByIndex = new Map<string, Set<string>>();
    const projectDirsByIndex = new Map<string, string>();

    for (const session of result.sessions) {
      const internal = session.internal;

      projectDirsByIndex.set(internal.indexPath, internal.projectDir);

      const sessionIds =
        sessionIdsByIndex.get(internal.indexPath) ?? new Set<string>();
      sessionIds.add(internal.sessionId);
      sessionIdsByIndex.set(internal.indexPath, sessionIds);

      for (const path of [...internal.relatedPaths, ...internal.todoFiles]) {
        deletedPaths.add(path);
      }
    }

    for (const project of result.projects) {
      if (project.internal.projectDir) {
        deletedPaths.add(project.internal.projectDir);
      }

      if (project.internal.configProjectPath) {
        deletedConfigProjectPaths.add(project.internal.configProjectPath);
      }
    }

    await Promise.all(Array.from(deletedPaths, (path) => removePath(path)));

    for (const [indexPath, sessionIds] of sessionIdsByIndex) {
      const index = await readJsonFile<ClaudeIndexFile>(indexPath).catch(
        () => ({ entries: [] }),
      );
      const remainingEntries = (index.entries ?? []).filter((entry) => {
        const sessionId = entry.sessionId ?? "";
        return !sessionIds.has(sessionId);
      });

      if (!remainingEntries.length) {
        const projectDir = projectDirsByIndex.get(indexPath);
        if (projectDir) {
          await removePath(projectDir);
        } else {
          await removePath(indexPath);
        }
        continue;
      }

      await writeJsonFile(indexPath, {
        ...index,
        entries: remainingEntries,
      });
    }

    await rewriteClaudeGlobalProjects(deletedConfigProjectPaths);

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
  id: "claude-code",
  name: "Claude Code",
  async scan(
    options: CliOptions,
  ): Promise<ProviderScanResult<
    ClaudeSessionInternal,
    ClaudeProjectInternal
  > | null> {
    if (!(await pathExists(PROJECTS_ROOT))) {
      return null;
    }

    const cutoffDate = getCutoffDate(options);
    const todoFilesBySession = await buildTodoFileMap();
    const sessions: SessionCandidate<ClaudeSessionInternal>[] = [];
    const projects: ProjectCandidate<ClaudeProjectInternal>[] =
      await scanClaudeGlobalProjects(options);
    const projectEntries = await readdir(PROJECTS_ROOT, {
      withFileTypes: true,
    });

    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) {
        continue;
      }

      const projectDir = join(PROJECTS_ROOT, projectEntry.name);
      const indexPath = join(projectDir, "sessions-index.json");

      if (!(await pathExists(indexPath))) {
        continue;
      }

      const index = await readJsonFile<ClaudeIndexFile>(indexPath).catch(
        () => ({ entries: [] }),
      );
      const entries = index.entries ?? [];
      const projectPath =
        entries.find((entry) => entry.projectPath)?.projectPath ?? null;
      const projectName = projectPath
        ? basename(projectPath)
        : basename(projectDir);

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

      if (!entries.length) {
        const bytes = await getPathSize(projectDir);
        const updatedAt =
          (await safeStat(indexPath)) ?? (await safeStat(projectDir));

        if (!matchesSizeThreshold(bytes, options.largerThanBytes)) {
          continue;
        }

        projects.push({
          bytes,
          createdAt: null,
          displayName: basename(projectDir),
          internal: {
            configProjectPath: null,
            projectDir,
          },
          key: projectDir,
          projectPath,
          providerId: "claude-code",
          providerName: "Claude Code",
          reasons: ["empty project container"],
          updatedAt,
        });
        continue;
      }

      for (const entry of entries) {
        const sessionId = entry.sessionId;

        if (!sessionId) {
          continue;
        }

        const sessionFile =
          entry.fullPath ?? join(projectDir, `${sessionId}.jsonl`);
        const updatedAt =
          parseDate(entry.modified) ??
          parseDate(entry.fileMtime) ??
          (await safeStat(sessionFile)) ??
          (await safeStat(indexPath)) ??
          new Date(0);
        const reasons = collectReasons(updatedAt, cutoffDate, projectMissing);

        if (!reasons.length) {
          continue;
        }

        const relatedPaths = [
          sessionFile,
          join(DEBUG_ROOT, `${sessionId}.txt`),
          join(SESSION_ENV_ROOT, sessionId),
          join(TASKS_ROOT, sessionId),
          join(FILE_HISTORY_ROOT, sessionId),
        ];
        const todoFiles = todoFilesBySession.get(sessionId) ?? [];
        const bytes = await sumPathSizes([...relatedPaths, ...todoFiles]);

        if (!matchesSizeThreshold(bytes, options.largerThanBytes)) {
          continue;
        }

        sessions.push({
          bytes,
          createdAt: parseDate(entry.created),
          current: false,
          id: sessionId,
          internal: {
            indexPath,
            projectDir,
            relatedPaths,
            sessionId,
            todoFiles,
          },
          projectName,
          projectPath,
          providerId: "claude-code",
          providerName: "Claude Code",
          reasons,
          title: excerpt(
            entry.customTitle ?? entry.summary ?? entry.firstPrompt,
          ),
          updatedAt,
        });
      }
    }

    return {
      notes: [],
      projects,
      providerId: "claude-code",
      providerName: "Claude Code",
      sessions,
      warnings: [],
    };
  },
};

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

async function buildTodoFileMap(): Promise<Map<string, string[]>> {
  const todoFilesBySession = new Map<string, string[]>();

  if (!(await pathExists(TODOS_ROOT))) {
    return todoFilesBySession;
  }

  const todoFiles = await readdir(TODOS_ROOT);

  for (const file of todoFiles) {
    const match = /^([0-9a-f-]{36})-/iu.exec(file);

    if (!match?.[1]) {
      continue;
    }

    const sessionId = match[1];
    const sessionFiles = todoFilesBySession.get(sessionId) ?? [];
    sessionFiles.push(join(TODOS_ROOT, file));
    todoFilesBySession.set(sessionId, sessionFiles);
  }

  return todoFilesBySession;
}

async function rewriteClaudeGlobalProjects(
  projectPaths: Set<string>,
): Promise<void> {
  if (!projectPaths.size || !(await pathExists(CLAUDE_CONFIG_PATH))) {
    return;
  }

  const config = await readJsonFile<ClaudeGlobalConfigFile>(
    CLAUDE_CONFIG_PATH,
  ).catch((): ClaudeGlobalConfigFile => ({}));
  const existingProjects = config.projects ?? {};
  const nextProjects: Record<string, Record<string, unknown>> = {};

  for (const [projectPath, value] of Object.entries(existingProjects)) {
    if (!projectPaths.has(projectPath)) {
      nextProjects[projectPath] = value;
    }
  }

  if (
    Object.keys(nextProjects).length === Object.keys(existingProjects).length
  ) {
    return;
  }

  await writeJsonFile(CLAUDE_CONFIG_PATH, {
    ...config,
    projects: nextProjects,
  });
}

async function scanClaudeGlobalProjects(
  options: CliOptions,
): Promise<ProjectCandidate<ClaudeProjectInternal>[]> {
  if (!options.includeOrphaned || !(await pathExists(CLAUDE_CONFIG_PATH))) {
    return [];
  }

  const config = await readJsonFile<ClaudeGlobalConfigFile>(
    CLAUDE_CONFIG_PATH,
  ).catch((): ClaudeGlobalConfigFile => ({}));
  const updatedAt = await safeStat(CLAUDE_CONFIG_PATH);
  const projects: ProjectCandidate<ClaudeProjectInternal>[] = [];

  for (const projectPath of Object.keys(config.projects ?? {})) {
    if (await pathExists(projectPath)) {
      continue;
    }

    if (
      matchesIgnoredProject(
        projectPath,
        basename(projectPath),
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
      displayName: basename(projectPath),
      internal: {
        configProjectPath: projectPath,
        projectDir: null,
      },
      key: `claude-config:${projectPath}`,
      projectPath,
      providerId: "claude-code",
      providerName: "Claude Code",
      reasons: ["missing project root", "global project metadata"],
      updatedAt,
    });
  }

  return projects;
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
