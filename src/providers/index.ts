import type { AgentProvider } from "../types.js";
import { claudeCodeProvider } from "./claude-code.js";
import { codexProvider } from "./codex.js";
import { copilotProvider } from "./copilot.js";
import { copilotVscodeProvider } from "./copilot-vscode.js";
import { crushProvider } from "./crush.js";
import { geminiProvider } from "./gemini.js";
import { opencodeProvider } from "./opencode.js";

export const providers: AgentProvider[] = [
  claudeCodeProvider,
  codexProvider,
  copilotProvider,
  copilotVscodeProvider,
  crushProvider,
  geminiProvider,
  opencodeProvider,
];
