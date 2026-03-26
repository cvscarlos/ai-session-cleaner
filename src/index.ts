#!/usr/bin/env node

import process from "node:process";
import { providers } from "./providers/index.js";
import type {
  AgentProvider,
  CliOptions,
  ProjectCandidate,
  ProviderApplyResult,
  ProviderExecution,
  ProviderScanResult,
  SessionCandidate,
} from "./types.js";
import { confirm, formatBytes, formatDate, parseArgs } from "./utils.js";

void main();

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
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
      printScanReport(options, executions);
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

    printApplyReport(applyResults);
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

function collectCandidateRows(executions: ProviderExecution[]): string[][] {
  const sessionRows = executions.flatMap((execution) =>
    execution.result.sessions.map((session) => sessionCandidateToRow(session)),
  );
  const projectRows = executions.flatMap((execution) =>
    execution.result.projects.map((project) => projectCandidateToRow(project)),
  );

  return [...sessionRows, ...projectRows].sort((left, right) =>
    `${left[0]}-${left[2]}`.localeCompare(`${right[0]}-${right[2]}`),
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

function printApplyReport(applyResults: ProviderApplyResult[]): void {
  process.stdout.write("\nApplied cleanup:\n");
  process.stdout.write(
    `${renderTable(
      ["Agent", "Sessions", "Projects", "Bytes"],
      applyResults.map((result) => [
        result.providerName,
        String(result.deletedSessions),
        String(result.deletedProjects),
        formatBytes(result.deletedBytes),
      ]),
    )}\n`,
  );

  const warnings = Array.from(
    new Set(applyResults.flatMap((result) => result.warnings)),
  );
  const notes = Array.from(
    new Set(applyResults.flatMap((result) => result.notes)),
  );

  if (warnings.length) {
    process.stdout.write("\nWarnings:\n");
    for (const warning of warnings) {
      process.stdout.write(`- ${warning}\n`);
    }
  }

  if (notes.length) {
    process.stdout.write("\nNotes:\n");
    for (const note of notes) {
      process.stdout.write(`- ${note}\n`);
    }
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printScanReport(
  options: CliOptions,
  executions: ProviderExecution[],
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

  process.stdout.write("AI session cleanup\n");
  process.stdout.write(
    `Mode: ${options.dryRun ? "safe-run" : "interactive apply"} | Agents: ${
      options.providerIds?.join(", ") ?? "all"
    } | Older than days: ${options.olderThanDays ?? "-"} | Orphaned: ${
      options.includeOrphaned ? "yes" : "no"
    } | Compact SQLite: ${options.compactSqlite ? "yes" : "no"}\n`,
  );
  process.stdout.write(
    `Matches: ${totalSessions} session(s), ${totalProjects} project item(s), ${formatBytes(totalBytes)}\n\n`,
  );

  process.stdout.write(
    `${renderTable(
      ["Agent", "Sessions", "Projects", "Bytes"],
      executions.map((execution) => [
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
      ]),
    )}\n`,
  );

  if (candidateRows.length) {
    process.stdout.write("\nCandidates:\n");
    process.stdout.write(
      `${renderTable(
        ["Agent", "Type", "Updated", "Size", "Reasons", "Project", "Label"],
        candidateRows,
      )}\n`,
    );
  }

  if (messages.warnings.length) {
    process.stdout.write("\nWarnings:\n");
    for (const warning of messages.warnings) {
      process.stdout.write(`- ${warning}\n`);
    }
  }

  if (options.dryRun) {
    process.stdout.write("\nSafe Run:\n");
    process.stdout.write(
      "- Nothing was deleted. The candidates above are exactly what apply mode would remove.\n",
    );
  }

  if (messages.notes.length) {
    process.stdout.write("\nNotes:\n");
    for (const note of messages.notes) {
      process.stdout.write(`- ${note}\n`);
    }
  }
}

function projectCandidateToRow(project: ProjectCandidate): string[] {
  return [
    project.providerName,
    "project",
    formatDate(project.updatedAt),
    formatBytes(project.bytes),
    clip(project.reasons.join(", "), 30),
    clip(project.projectPath ?? "-", 36),
    clip(project.displayName, 42),
  ];
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const divider = widths.map((width) => "-".repeat(width)).join("-+-");
  const headerLine = headers
    .map((header, index) => header.padEnd(widths[index] ?? header.length))
    .join(" | ");
  const rowLines = rows.map((row) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join(" | "),
  );

  return [headerLine, divider, ...rowLines].join("\n");
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

function sessionCandidateToRow(session: SessionCandidate): string[] {
  return [
    session.providerName,
    "session",
    formatDate(session.updatedAt),
    formatBytes(session.bytes),
    clip(session.reasons.join(", "), 30),
    clip(session.projectPath ?? "-", 36),
    clip(session.title ?? session.id, 42),
  ];
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
      displayName: project.displayName,
      projectPath: project.projectPath,
      reasons: project.reasons,
      updatedAt: project.updatedAt?.toISOString() ?? null,
    })),
    providerId: result.providerId,
    providerName: result.providerName,
    sessions: result.sessions.map((session) => ({
      bytes: session.bytes,
      createdAt: session.createdAt?.toISOString() ?? null,
      current: session.current,
      id: session.id,
      projectPath: session.projectPath,
      reasons: session.reasons,
      title: session.title,
      updatedAt: session.updatedAt.toISOString(),
    })),
    warnings: result.warnings,
  };
}

function summarizeOptions(options: CliOptions): Record<string, unknown> {
  return {
    agentIds: options.providerIds,
    compactSqlite: options.compactSqlite,
    dryRun: options.dryRun,
    includeOrphaned: options.includeOrphaned,
    mode: options.dryRun ? "safe-run" : "apply",
    olderThanDays: options.olderThanDays,
    providerIds: options.providerIds,
    yes: options.yes,
  };
}
