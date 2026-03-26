import type { AgentProvider } from "../types.js";
import { claudeCodeProvider } from "./claude-code.js";
import { codexProvider } from "./codex.js";
import { copilotProvider } from "./copilot.js";
import { geminiProvider } from "./gemini.js";

export const providers: AgentProvider[] = [
  claudeCodeProvider,
  codexProvider,
  copilotProvider,
  geminiProvider,
];
