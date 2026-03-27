#!/usr/bin/env node

import process from "node:process";
import type { OutputTheme } from "./output-theme.js";
import { createOutputTheme } from "./output-theme.js";
import { providers } from "./providers/index.js";
import type {
  AgentProvider,
  CliOptions,
  ProjectCandidate,
  ProviderApplyResult,
  ProviderExecution,
  ProviderId,
  ProviderScanResult,
  SessionCandidate,
} from "./types.js";
import {
  abbreviateHomePath,
  confirm,
  formatBytes,
  formatDateTime,
  parseArgs,
} from "./utils.js";

void main();

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const theme = createOutputTheme(options.color);
    const selectedProviders = selectProviders(options);
    const executions = await scanProviders(selectedProviders, options);
    const hasCandidates = executions.some(
      (execution) =>
        execution.result.sessions.length || execution.result.projects.length,
    );

    if (options.json && (!hasCandidates || options.dryRun)) {
      printJson({
        applyResults: [],
        cancelled: false,
        options: summarizeOptions(options),
        providers: executions.map((execution) =>
          summarizeExecution(execution.result),
        ),
      });
      return;
    }

    if (!options.json) {
      printScanReport(options, executions, theme);
    }

    if (!hasCandidates || options.dryRun) {
      return;
    }

    const shouldApply =
      options.yes ||
      (process.stdout.isTTY &&
        (await confirm(buildConfirmationMessage(executions))));

    if (!shouldApply) {
      if (options.json) {
        printJson({
          applyResults: [],
          cancelled: true,
          options: summarizeOptions(options),
          providers: executions.map((execution) =>
            summarizeExecution(execution.result),
          ),
        });
      } else {
        process.stdout.write("Cleanup cancelled.\n");
      }
      return;
    }

    const applyResults = await applyExecutions(executions, options);

    if (options.json) {
      printJson({
        applyResults,
        cancelled: false,
        options: summarizeOptions(options),
        providers: executions.map((execution) =>
          summarizeExecution(execution.result),
        ),
      });
      return;
    }

    printApplyReport(applyResults, theme);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}

async function applyExecutions(
  executions: ProviderExecution[],
  options: CliOptions,
): Promise<ProviderApplyResult[]> {
  const applyResults: ProviderApplyResult[] = [];

  for (const execution of executions) {
    if (
      !execution.result.sessions.length &&
      !execution.result.projects.length
    ) {
      continue;
    }

    const applyResult = await execution.provider.apply(
      execution.result,
      options,
    );
    applyResults.push(applyResult);
  }

  return applyResults;
}

function buildConfirmationMessage(executions: ProviderExecution[]): string {
  const sessionCount = executions.reduce(
    (sum, execution) => sum + execution.result.sessions.length,
    0,
  );
  const projectCount = executions.reduce(
    (sum, execution) => sum + execution.result.projects.length,
    0,
  );

  return `Delete ${sessionCount} session(s) and ${projectCount} project item(s)?`;
}

function clip(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, Math.max(0, length - 3)).trim()}...`;
}

interface TableRow {
  agentId: ProviderId | null;
  cells: string[];
}

function collectCandidateRows(executions: ProviderExecution[]): TableRow[] {
  const sessionRows = executions.flatMap((execution) =>
    execution.result.sessions.map((session) => sessionCandidateToRow(session)),
  );
  const projectRows = executions.flatMap((execution) =>
    execution.result.projects.map((project) => projectCandidateToRow(project)),
  );

  return [...sessionRows, ...projectRows].sort((left, right) =>
    `${left.cells[0] ?? ""}-${left.cells[2] ?? ""}`.localeCompare(
      `${right.cells[0] ?? ""}-${right.cells[2] ?? ""}`,
    ),
  );
}

function collectMessages(executions: ProviderExecution[]): {
  notes: string[];
  warnings: string[];
} {
  const notes = executions.flatMap((execution) => execution.result.notes);
  const warnings = executions.flatMap((execution) => execution.result.warnings);

  return {
    notes: Array.from(new Set(notes)),
    warnings: Array.from(new Set(warnings)),
  };
}

function printApplyReport(
  applyResults: ProviderApplyResult[],
  theme: OutputTheme,
): void {
  process.stdout.write(`\n${theme.success("Applied cleanup:")}\n`);
  process.stdout.write(
    `${renderTable(
      ["Agent", "Sessions", "Projects", "Bytes"],
      applyResults.map((result) => ({
        agentId: result.providerId,
        cells: [
          result.providerName,
          String(result.deletedSessions),
          String(result.deletedProjects),
          formatBytes(result.deletedBytes),
        ],
      })),
      theme,
    )}\n`,
  );

  const warnings = Array.from(
    new Set(applyResults.flatMap((result) => result.warnings)),
  );
  const notes = Array.from(
    new Set(applyResults.flatMap((result) => result.notes)),
  );

  if (warnings.length) {
    process.stdout.write(`\n${theme.warning("Warnings:")}\n`);
    for (const warning of warnings) {
      process.stdout.write(`${theme.warning(`- ${warning}`)}\n`);
    }
  }

  if (notes.length) {
    process.stdout.write(`\n${theme.heading("Notes:")}\n`);
    for (const note of notes) {
      process.stdout.write(`${theme.accent(`- ${note}`)}\n`);
    }
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printScanReport(
  options: CliOptions,
  executions: ProviderExecution[],
  theme: OutputTheme,
): void {
  const totalSessions = executions.reduce(
    (sum, execution) => sum + execution.result.sessions.length,
    0,
  );
  const totalProjects = executions.reduce(
    (sum, execution) => sum + execution.result.projects.length,
    0,
  );
  const totalBytes = executions.reduce(
    (sum, execution) =>
      sum +
      execution.result.sessions.reduce(
        (sessionSum, session) => sessionSum + session.bytes,
        0,
      ) +
      execution.result.projects.reduce(
        (projectSum, project) => projectSum + project.bytes,
        0,
      ),
    0,
  );
  const candidateRows = collectCandidateRows(executions);
  const messages = collectMessages(executions);

  process.stdout.write(`${theme.title("AI session cleanup")}\n`);
  process.stdout.write(
    `${[
      formatSetting(
        theme,
        "Mode",
        options.dryRun ? "safe-run" : "interactive apply",
      ),
      formatSetting(theme, "Agents", options.providerIds?.join(", ") ?? "all"),
      formatSetting(
        theme,
        "Older than days",
        String(options.olderThanDays ?? "-"),
      ),
      formatSetting(theme, "Orphaned", options.includeOrphaned ? "yes" : "no"),
      formatSetting(
        theme,
        "Ignore project",
        options.ignoredProjectTerms.length
          ? clip(options.ignoredProjectTerms.join(", "), 30)
          : "-",
      ),
      formatSetting(
        theme,
        "Larger than",
        options.largerThanBytes === null
          ? "-"
          : formatBytes(options.largerThanBytes),
      ),
      formatSetting(
        theme,
        "Compact SQLite",
        options.compactSqlite ? "yes" : "no",
      ),
    ].join(theme.dim(" | "))}\n`,
  );
  process.stdout.write(
    `${theme.strong("Matches:")} ${theme.success(
      `${totalSessions} session(s), ${totalProjects} project item(s), ${formatBytes(totalBytes)}`,
    )}\n\n`,
  );

  process.stdout.write(
    `${renderTable(
      ["Agent", "Sessions", "Projects", "Bytes"],
      executions.map((execution) => ({
        agentId: execution.result.providerId,
        cells: [
          execution.result.providerName,
          String(execution.result.sessions.length),
          String(execution.result.projects.length),
          formatBytes(
            execution.result.sessions.reduce(
              (sum, session) => sum + session.bytes,
              0,
            ) +
              execution.result.projects.reduce(
                (sum, project) => sum + project.bytes,
                0,
              ),
          ),
        ],
      })),
      theme,
    )}\n`,
  );

  if (candidateRows.length) {
    process.stdout.write(`\n${theme.heading("Candidates:")}\n`);
    process.stdout.write(
      `${renderTable(
        [
          "Agent",
          "Type",
          "Last use",
          "Size",
          "Reasons",
          "Project",
          "Session id",
          "Label",
        ],
        candidateRows,
        theme,
      )}\n`,
    );
  }

  if (messages.warnings.length) {
    process.stdout.write(`\n${theme.warning("Warnings:")}\n`);
    for (const warning of messages.warnings) {
      process.stdout.write(`${theme.warning(`- ${warning}`)}\n`);
    }
  }

  if (options.dryRun) {
    process.stdout.write(`\n${theme.success("Safe Run:")}\n`);
    process.stdout.write(
      `${theme.success(
        "- Nothing was deleted. The candidates above are exactly what apply mode would remove.",
      )}\n`,
    );
  }

  if (messages.notes.length) {
    process.stdout.write(`\n${theme.heading("Notes:")}\n`);
    for (const note of messages.notes) {
      process.stdout.write(`${theme.accent(`- ${note}`)}\n`);
    }
  }
}

function formatSetting(
  theme: OutputTheme,
  label: string,
  value: string,
): string {
  return `${theme.dim(`${label}:`)} ${theme.strong(value)}`;
}

function projectCandidateToRow(project: ProjectCandidate): TableRow {
  return {
    agentId: project.providerId,
    cells: [
      project.providerName,
      "project",
      formatDateTime(project.updatedAt),
      formatBytes(project.bytes),
      clip(project.reasons.join(", "), 30),
      clip(abbreviateHomePath(project.projectPath) ?? "-", 36),
      "-",
      clip(project.displayName, 42),
    ],
  };
}

function renderTable(
  headers: string[],
  rows: TableRow[],
  theme?: OutputTheme,
): string {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => (row.cells[index] ?? "").length),
    ),
  );
  const divider = widths.map((width) => "-".repeat(width)).join("-+-");
  const headerLine = headers
    .map((header, index) => header.padEnd(widths[index] ?? header.length))
    .join(" | ");
  const rowLines = rows.map((row) => formatTableRow(row, widths, theme));

  return [
    theme ? theme.strong(headerLine) : headerLine,
    theme ? theme.dim(divider) : divider,
    ...rowLines,
  ].join("\n");
}

function formatTableCell(
  row: TableRow,
  index: number,
  width: number,
  theme?: OutputTheme,
): string {
  const paddedCell = (row.cells[index] ?? "").padEnd(width);

  if (index !== 0 || !theme || !row.agentId) {
    return paddedCell;
  }

  return theme.agent(row.agentId, paddedCell);
}

function formatTableRow(
  row: TableRow,
  widths: number[],
  theme?: OutputTheme,
): string {
  return row.cells
    .map((_, index) => formatTableCell(row, index, widths[index] ?? 0, theme))
    .join(" | ");
}

async function scanProviders(
  selectedProviders: AgentProvider[],
  options: CliOptions,
): Promise<ProviderExecution[]> {
  const executions: ProviderExecution[] = [];

  for (const provider of selectedProviders) {
    const result = await provider.scan(options);

    if (!result) {
      continue;
    }

    executions.push({
      provider,
      result,
    });
  }

  return executions;
}

function selectProviders(options: CliOptions): AgentProvider[] {
  if (!options.providerIds) {
    return providers;
  }

  return providers.filter((provider) =>
    options.providerIds?.includes(provider.id),
  );
}

function sessionCandidateToRow(session: SessionCandidate): TableRow {
  return {
    agentId: session.providerId,
    cells: [
      session.providerName,
      "session",
      formatDateTime(session.updatedAt),
      formatBytes(session.bytes),
      clip(session.reasons.join(", "), 30),
      clip(abbreviateHomePath(session.projectPath) ?? "-", 36),
      session.id,
      clip(session.title ?? session.id, 42),
    ],
  };
}

function summarizeExecution(
  result: ProviderScanResult,
): Record<string, unknown> {
  return {
    agentId: result.providerId,
    agentName: result.providerName,
    notes: result.notes,
    projects: result.projects.map((project) => ({
      bytes: project.bytes,
      createdAt: project.createdAt?.toISOString() ?? null,
      displayName: project.displayName,
      lastUsedAt: project.updatedAt?.toISOString() ?? null,
      projectPath: project.projectPath,
      reasons: project.reasons,
    })),
    providerId: result.providerId,
    providerName: result.providerName,
    sessions: result.sessions.map((session) => ({
      bytes: session.bytes,
      createdAt: session.createdAt?.toISOString() ?? null,
      current: session.current,
      id: session.id,
      lastUsedAt: session.updatedAt.toISOString(),
      projectPath: session.projectPath,
      reasons: session.reasons,
      title: session.title,
    })),
    warnings: result.warnings,
  };
}

function summarizeOptions(options: CliOptions): Record<string, unknown> {
  return {
    agentIds: options.providerIds,
    compactSqlite: options.compactSqlite,
    color: options.color,
    dryRun: options.dryRun,
    ignoredProjectTerms: options.ignoredProjectTerms,
    includeOrphaned: options.includeOrphaned,
    largerThanBytes: options.largerThanBytes,
    mode: options.dryRun ? "safe-run" : "apply",
    olderThanDays: options.olderThanDays,
    providerIds: options.providerIds,
    yes: options.yes,
  };
}
