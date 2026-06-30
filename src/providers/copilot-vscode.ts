import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentProvider,
  CliOptions,
  ProviderApplyResult,
  ProviderScanResult,
  SessionCandidate,
} from "../types.js";
import {
  excerpt,
  getPathSize,
  getVsCodeWorkspaceStorageDirectory,
  matchesIgnoredProject,
  matchesSizeThreshold,
  pathExists,
  readJsonFile,
  removePath,
  safeStat,
} from "../utils.js";

// VS Code Copilot Chat stores per-workspace conversations under
// workspaceStorage/<hash>/chatSessions/<sessionId>.json, with the matching
// edit history under chatEditingSessions/<sessionId>/. workspace.json maps the
// hash to the project folder. We only ever touch these chat directories — never
// state.vscdb (shared editor state) or the rebuildable embeddings caches in
// globalStorage.
const WORKSPACE_STORAGE_ROOT = getVsCodeWorkspaceStorageDirectory();

interface VsCodeChatFile {
  creationDate?: number;
  lastMessageDate?: number;
  requests?: Array<{ message?: { text?: string } | string }>;
  sessionId?: string;
}

interface WorkspaceJsonFile {
  folder?: string;
}

interface CopilotVscodeSessionInternal {
  chatFilePath: string;
  editingSessionDir: string | null;
}

function extractChatTitle(chat: VsCodeChatFile): string | null {
  const first = chat.requests?.[0]?.message;
  const text =
    typeof first === "string"
      ? first
      : typeof first?.text === "string"
        ? first.text
        : null;

  return excerpt(text);
}

function resolveWorkspaceFolder(file: WorkspaceJsonFile): string | null {
  if (!file.folder || !file.folder.startsWith("file://")) {
    return null;
  }

  try {
    return fileURLToPath(file.folder);
  } catch {
    return null;
  }
}

function getCutoffDate(options: CliOptions): Date | null {
  if (!options.olderThanDays) {
    return null;
  }

  return new Date(
    options.now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000,
  );
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

export const copilotVscodeProvider: AgentProvider<CopilotVscodeSessionInternal> =
  {
    async apply(
      result: ProviderScanResult<CopilotVscodeSessionInternal>,
    ): Promise<ProviderApplyResult> {
      const paths = new Set<string>();

      for (const session of result.sessions) {
        paths.add(session.internal.chatFilePath);
        if (session.internal.editingSessionDir) {
          paths.add(session.internal.editingSessionDir);
        }
      }

      await Promise.all(Array.from(paths, (path) => removePath(path)));

      return {
        deletedBytes: result.sessions.reduce(
          (sum, session) => sum + session.bytes,
          0,
        ),
        deletedProjects: 0,
        deletedSessions: result.sessions.length,
        notes: [
          "Removed VS Code Copilot chat sessions only. Editor state (state.vscdb) and rebuildable embeddings caches were left untouched.",
        ],
        providerId: result.providerId,
        providerName: result.providerName,
        warnings: [],
      };
    },
    id: "copilot-vscode",
    // beta: VS Code chat storage format is internal and can change between
    // releases; only the stable "Code" build is scanned.
    name: "Copilot VS Code (beta)",
    async scan(
      options: CliOptions,
    ): Promise<ProviderScanResult<CopilotVscodeSessionInternal> | null> {
      if (!(await pathExists(WORKSPACE_STORAGE_ROOT))) {
        return null;
      }

      const cutoffDate = getCutoffDate(options);
      const sessions: SessionCandidate<CopilotVscodeSessionInternal>[] = [];
      const hashDirs = await readdir(WORKSPACE_STORAGE_ROOT, {
        withFileTypes: true,
      });

      for (const hashDir of hashDirs) {
        if (!hashDir.isDirectory()) {
          continue;
        }

        const workspaceDir = join(WORKSPACE_STORAGE_ROOT, hashDir.name);
        const chatSessionsDir = join(workspaceDir, "chatSessions");

        if (!(await pathExists(chatSessionsDir))) {
          continue;
        }

        const projectPath = await readJsonFile<WorkspaceJsonFile>(
          join(workspaceDir, "workspace.json"),
        )
          .then(resolveWorkspaceFolder)
          .catch(() => null);
        const projectName = projectPath ? basename(projectPath) : null;

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

        const chatFiles = await readdir(chatSessionsDir).catch(() => []);

        for (const chatFile of chatFiles) {
          if (!chatFile.endsWith(".json")) {
            continue;
          }

          const chatFilePath = join(chatSessionsDir, chatFile);
          const chat = await readJsonFile<VsCodeChatFile>(chatFilePath).catch(
            (): VsCodeChatFile => ({}),
          );
          const sessionId =
            chat.sessionId ?? chatFile.slice(0, -".json".length);
          const updatedAt =
            (chat.lastMessageDate ? new Date(chat.lastMessageDate) : null) ??
            (chat.creationDate ? new Date(chat.creationDate) : null) ??
            (await safeStat(chatFilePath)) ??
            new Date(0);
          const reasons = collectReasons(updatedAt, cutoffDate, projectMissing);

          if (!reasons.length) {
            continue;
          }

          const editingSessionDir = join(
            workspaceDir,
            "chatEditingSessions",
            sessionId,
          );
          const hasEditingDir = await pathExists(editingSessionDir);
          const bytes =
            (await getPathSize(chatFilePath)) +
            (hasEditingDir ? await getPathSize(editingSessionDir) : 0);

          if (!matchesSizeThreshold(bytes, options.largerThanBytes)) {
            continue;
          }

          sessions.push({
            bytes,
            createdAt: chat.creationDate ? new Date(chat.creationDate) : null,
            current: false,
            id: sessionId,
            internal: {
              chatFilePath,
              editingSessionDir: hasEditingDir ? editingSessionDir : null,
            },
            projectName,
            projectPath,
            providerId: "copilot-vscode",
            providerName: "Copilot VS Code (beta)",
            reasons,
            title: extractChatTitle(chat),
            updatedAt,
          });
        }
      }

      return {
        notes: [],
        projects: [],
        providerId: "copilot-vscode",
        providerName: "Copilot VS Code (beta)",
        sessions,
        warnings: [],
      };
    },
  };
