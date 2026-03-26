import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { CliOptions, ProviderId } from "./types.js";

const AGENT_IDS: ProviderId[] = ["claude-code", "codex", "copilot", "gemini"];

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (!path.startsWith("~/") && !path.startsWith("~\\")) {
    return path;
  }

  return join(homedir(), path.slice(2));
}

export function getAppDataDirectory(): string {
  const osPlatform = platform();

  if (osPlatform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }

  if (osPlatform === "win32") {
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  }

  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

export function getVsCodeGlobalStorageDirectory(
  extensionId: string,
  productName = "Code",
): string {
  return join(
    getAppDataDirectory(),
    productName,
    "User",
    "globalStorage",
    extensionId,
  );
}

export function excerpt(
  value: string | null | undefined,
  length = 72,
): string | null {
  const normalized = value?.replaceAll(/\s+/g, " ").trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length <= length) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, length - 3)).trim()}...`;
}

export function formatDate(value: Date | null): string {
  if (!value) {
    return "-";
  }

  return value.toISOString().slice(0, 10);
}

export function formatBytes(bytes: number): string {
  if (!bytes) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const fixed = size >= 10 || unitIndex === 0 ? 0 : 1;

  return `${size.toFixed(fixed)} ${units[unitIndex]}`;
}

export async function getPathSize(path: string): Promise<number> {
  try {
    const pathStat = await lstat(path);

    if (pathStat.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      const sizes = await Promise.all(
        entries.map((entry) => getPathSize(join(path, entry.name))),
      );

      return sizes.reduce((sum, value) => sum + value, 0);
    }

    return pathStat.size;
  } catch {
    return 0;
  }
}

export async function pathExists(
  path: string | null | undefined,
): Promise<boolean> {
  if (!path) {
    return false;
  }

  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function parseDate(
  value: number | string | null | undefined,
): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
    const parsed = new Date(milliseconds);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseFlatYaml(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

export function parseAgentIds(
  value: string,
  flagName = "--agent",
): ProviderId[] {
  const requestedIds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!requestedIds.length) {
    throw new Error(`Expected at least one agent id after ${flagName}`);
  }

  const providerIds = requestedIds.map((entry) => {
    if (AGENT_IDS.includes(entry as ProviderId)) {
      return entry as ProviderId;
    }

    throw new Error(
      `Unsupported agent "${entry}". Expected one of: ${AGENT_IDS.join(", ")}`,
    );
  });

  return Array.from(new Set(providerIds));
}

export function parseArgs(argv: string[]): CliOptions {
  let compactSqlite = false;
  let dryRun = false;
  let includeOrphaned = true;
  let json = false;
  let olderThanDays = 45;
  let providerIds: ProviderId[] | null = null;
  let yes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }

    if (arg === "--dry-run" || arg === "--safe-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--yes") {
      yes = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--compact-sqlite") {
      compactSqlite = true;
      continue;
    }

    if (arg === "--no-orphaned") {
      includeOrphaned = false;
      continue;
    }

    if (arg.startsWith("--older-than-days=")) {
      olderThanDays = parsePositiveInteger(
        arg.split("=", 2)[1] ?? "",
        "--older-than-days",
      );
      continue;
    }

    if (arg === "--older-than-days") {
      const nextValue = argv[index + 1];
      olderThanDays = parsePositiveInteger(
        nextValue ?? "",
        "--older-than-days",
      );
      index += 1;
      continue;
    }

    if (arg.startsWith("--agent=")) {
      providerIds = parseAgentIds(arg.split("=", 2)[1] ?? "", "--agent");
      continue;
    }

    if (arg === "--agent" || arg === "-a") {
      const nextValue = argv[index + 1];
      providerIds = parseAgentIds(nextValue ?? "", arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--provider=")) {
      providerIds = parseAgentIds(arg.split("=", 2)[1] ?? "", "--provider");
      continue;
    }

    if (arg === "--provider") {
      const nextValue = argv[index + 1];
      providerIds = parseAgentIds(nextValue ?? "", "--provider");
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  const options: CliOptions = {
    compactSqlite,
    dryRun,
    includeOrphaned,
    json,
    now: new Date(),
    olderThanDays,
    providerIds,
    yes,
  };

  if (!process.stdout.isTTY && !options.yes) {
    options.dryRun = true;
  }

  return options;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${flag} expects a positive integer`);
  }

  return parsedValue;
}

export function printHelpAndExit(): never {
  process.stdout.write(
    [
      "ai-session-cleanup",
      "",
      "Inspect and clean local AI agent session data.",
      "",
      "Usage:",
      "  ai-session-cleanup [--older-than-days 45] [--agent claude-code,codex] [--safe-run]",
      "",
      "Options:",
      "  --older-than-days <days>  Delete sessions older than this many days (default: 45)",
      `  -a, --agent <ids>         Comma-separated agent ids: ${AGENT_IDS.join(", ")} (default: all)`,
      "  --provider <ids>          Alias for --agent",
      "  --compact-sqlite          Run VACUUM on cleaned Codex SQLite databases after apply",
      "  --safe-run                Preview everything that would be deleted",
      "  --dry-run                 Alias for --safe-run",
      "  --yes                     Skip interactive confirmation",
      "  --json                    Print machine-readable JSON",
      "  --no-orphaned             Skip orphaned-project detection",
      "  --help, -h                Show this help",
      "",
      "Agents:",
      `  ${AGENT_IDS.join(", ")}`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, "utf8");
  return JSON.parse(content) as T;
}

export async function readJsonLines(path: string): Promise<unknown[]> {
  const content = await readFile(path, "utf8");

  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

export async function rewriteJsonLines(
  path: string,
  keepLine: (parsed: Record<string, unknown>, rawLine: string) => boolean,
): Promise<void> {
  const content = await readFile(path, "utf8");
  const keptLines: string[] = [];

  for (const rawLine of content.split(/\r?\n/u)) {
    if (!rawLine.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawLine) as Record<string, unknown>;
      if (keepLine(parsed, rawLine)) {
        keptLines.push(rawLine);
      }
    } catch {
      keptLines.push(rawLine);
    }
  }

  await writeFile(
    path,
    keptLines.length ? `${keptLines.join("\n")}\n` : "",
    "utf8",
  );
}

export async function safeStat(path: string): Promise<Date | null> {
  try {
    const fileStat = await stat(path);
    return fileStat.mtime;
  } catch {
    return null;
  }
}

export async function writeJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await ensureDirectory(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeTextFile(
  path: string,
  value: string,
): Promise<void> {
  await ensureDirectory(dirname(path));
  await writeFile(path, value, "utf8");
}

export async function confirm(message: string): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await readline.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    readline.close();
  }
}
