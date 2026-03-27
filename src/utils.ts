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
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { createOutputTheme } from "./output-theme.js";
import type { CliOptions, ProviderId } from "./types.js";

const AGENT_IDS: ProviderId[] = [
  "claude-code",
  "codex",
  "copilot",
  "gemini",
  "opencode",
];

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

export function abbreviateHomePath(
  path: string | null | undefined,
): string | null {
  if (!path) {
    return null;
  }

  const homePath = homedir();

  if (path === homePath) {
    return "~";
  }

  const relativePath = relative(homePath, path);

  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return path;
  }

  return `~${sep}${relativePath}`;
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

export function formatDateTime(value: Date | null): string {
  if (!value) {
    return "-";
  }

  const year = String(value.getFullYear());
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}`;
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

export function matchesSizeThreshold(
  bytes: number,
  largerThanBytes: number | null,
): boolean {
  if (largerThanBytes === null) {
    return true;
  }

  return bytes >= largerThanBytes;
}

export function matchesIgnoredProject(
  projectPath: string | null,
  projectName: string | null,
  ignoredProjectTerms: string[],
): boolean {
  if (!ignoredProjectTerms.length) {
    return false;
  }

  const haystacks = new Set<string>();

  if (projectName) {
    haystacks.add(normalizeProjectMatchValue(projectName));
  }

  if (projectPath) {
    haystacks.add(normalizeProjectMatchValue(projectPath));
    haystacks.add(normalizeProjectMatchValue(abbreviateHomePath(projectPath)));
    haystacks.add(normalizeProjectMatchValue(basename(projectPath)));
  }

  if (!haystacks.size) {
    return false;
  }

  return ignoredProjectTerms.some((term) =>
    Array.from(haystacks).some((value) => value.includes(term)),
  );
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
  const color = !argv.includes("--no-color");
  let compactSqlite = false;
  let dryRun = false;
  const ignoredProjectTerms: string[] = [];
  let includeOrphaned = true;
  let json = false;
  let largerThanBytes: number | null = null;
  let olderThanDays = 45;
  let providerIds: ProviderId[] | null = null;
  let yes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelpAndExit(color);
    }

    if (arg === "--dry-run" || arg === "--safe-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--yes") {
      yes = true;
      continue;
    }

    if (arg === "--no-color") {
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

    if (arg.startsWith("--ignore-project=")) {
      ignoredProjectTerms.push(
        ...parseIgnoreProjectTerms(
          arg.split("=", 2)[1] ?? "",
          "--ignore-project",
        ),
      );
      continue;
    }

    if (arg === "--ignore-project") {
      const nextValue = argv[index + 1];
      ignoredProjectTerms.push(
        ...parseIgnoreProjectTerms(nextValue ?? "", "--ignore-project"),
      );
      index += 1;
      continue;
    }

    if (arg.startsWith("--larger-than=")) {
      largerThanBytes = parseSizeThreshold(
        arg.split("=", 2)[1] ?? "",
        "--larger-than",
      );
      continue;
    }

    if (arg === "--larger-than") {
      const nextValue = argv[index + 1];
      largerThanBytes = parseSizeThreshold(nextValue ?? "", "--larger-than");
      index += 1;
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
    color,
    compactSqlite,
    dryRun,
    ignoredProjectTerms: Array.from(new Set(ignoredProjectTerms)),
    includeOrphaned,
    json,
    largerThanBytes,
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

function parseIgnoreProjectTerms(value: string, flag: string): string[] {
  const terms = value
    .split(",")
    .map((entry) => normalizeProjectMatchValue(entry))
    .filter(Boolean);

  if (!terms.length) {
    throw new Error(`Expected at least one project search term after ${flag}`);
  }

  return terms;
}

function parseSizeThreshold(value: string, flag: string): number {
  const normalized = value.trim();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|kib|mib|gib|tib)?$/iu.exec(
    normalized,
  );

  if (!match?.[1]) {
    throw new Error(`${flag} expects a size like 1048576, 500KB, 1MB, or 2GiB`);
  }

  const amount = Number(match[1]);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${flag} expects a positive size`);
  }

  const unit = (match[2] ?? "b").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  const multiplier = multipliers[unit];

  if (!multiplier) {
    throw new Error(`${flag} expects a size like 1048576, 500KB, 1MB, or 2GiB`);
  }

  return Math.ceil(amount * multiplier);
}

function normalizeProjectMatchValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replaceAll("\\", "/") ?? "";
}

export function printHelpAndExit(color = true): never {
  const theme = createOutputTheme(color);

  process.stdout.write(
    [
      theme.title("ai-session-cleaner"),
      "",
      "Inspect and clean local AI agent session data.",
      "",
      theme.heading("Usage:"),
      `  ${theme.strong(
        "ai-session-cleaner [--older-than-days 45] [--agent claude-code,codex] [--safe-run]",
      )}`,
      "",
      theme.heading("Options:"),
      formatHelpOption(
        theme.accent("--older-than-days <days>").padEnd(30),
        "Delete sessions older than this many days (default: 45)",
      ),
      formatHelpOption(
        theme.accent("-a, --agent <ids>").padEnd(30),
        `Comma-separated agent ids: ${AGENT_IDS.join(", ")} (default: all)`,
      ),
      formatHelpOption(
        theme.accent("--provider <ids>").padEnd(30),
        "Alias for --agent",
      ),
      formatHelpOption(
        theme.accent("--ignore-project <term>").padEnd(30),
        "Ignore matching project names or paths (repeatable, substring match)",
      ),
      formatHelpOption(
        theme.accent("--larger-than <size>").padEnd(30),
        "Only match items at or above this measurable size (for example: 1MB)",
      ),
      formatHelpOption(
        theme.accent("--compact-sqlite").padEnd(30),
        "Run VACUUM on cleaned Codex SQLite databases after apply",
      ),
      formatHelpOption(
        theme.accent("--safe-run").padEnd(30),
        "Preview everything that would be deleted",
      ),
      formatHelpOption(
        theme.accent("--dry-run").padEnd(30),
        "Alias for --safe-run",
      ),
      formatHelpOption(
        theme.accent("--yes").padEnd(30),
        "Skip interactive confirmation",
      ),
      formatHelpOption(
        theme.accent("--json").padEnd(30),
        "Print machine-readable JSON",
      ),
      formatHelpOption(
        theme.accent("--no-color").padEnd(30),
        "Disable ANSI colors in human-readable output",
      ),
      formatHelpOption(
        theme.accent("--no-orphaned").padEnd(30),
        "Skip orphaned-project detection",
      ),
      formatHelpOption(theme.accent("--help, -h").padEnd(30), "Show this help"),
      "",
      theme.heading("Agents:"),
      `  ${theme.strong(AGENT_IDS.join(", "))}`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

function formatHelpOption(label: string, description: string): string {
  return `  ${label} ${description}`;
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
