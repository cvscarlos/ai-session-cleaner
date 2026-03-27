import { Chalk } from "chalk";
import type { ProviderId } from "./types.js";

type TextFormatter = (value: string) => string;

export interface OutputTheme {
  accent: TextFormatter;
  agent: (providerId: ProviderId, value: string) => string;
  dim: TextFormatter;
  heading: TextFormatter;
  strong: TextFormatter;
  success: TextFormatter;
  title: TextFormatter;
  warning: TextFormatter;
}

export function createOutputTheme(color: boolean): OutputTheme {
  const chalk = new Chalk({ level: color ? 1 : 0 });
  const agentFormatters: Record<ProviderId, TextFormatter> = {
    "claude-code": chalk.magenta,
    codex: chalk.cyan,
    copilot: chalk.blue,
    gemini: chalk.yellow,
    opencode: chalk.green,
  };

  return {
    accent: chalk.cyan,
    agent: (providerId, value) => agentFormatters[providerId](value),
    dim: chalk.dim,
    heading: chalk.bold.blue,
    strong: chalk.bold,
    success: chalk.green,
    title: chalk.bold.cyan,
    warning: chalk.yellow,
  };
}
