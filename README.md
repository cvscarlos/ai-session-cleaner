# AI Session Cleaner

Keep local AI agent session data tidy across the CLIs you already use.

`ai-session-cleaner` is a terminal-first cleanup tool for multi-agent developers. It scans agent-specific session stores, shows exactly what would be removed, and lets you apply the same cleanup from one command.

Built for:

- [Claude Code](https://github.com/anthropics/claude-code)
- [Codex](https://github.com/openai/codex)
- [GitHub Copilot CLI](https://github.com/github/copilot-cli)
- [GitHub Copilot Chat in VS Code](https://github.com/microsoft/vscode) (beta)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Opencode](https://github.com/anomalyco/opencode) (beta)
- [Crush](https://github.com/charmbracelet/crush) (beta)

Requires Node 18 or newer.

## Why use it

- One cleanup command across multiple AI coding CLIs
- Colorized terminal output by default, with `--no-color` when you want plain text
- Safe preview mode with `--safe-run`
- Sensible defaults: `45` days and all supported agents
- Human-readable tables for manual runs and `--json` for automation
- Agent-aware cleanup instead of generic file deletion

## Quick start

Run instantly with `npx`:

```bash
# preview everything older than 45 days across all supported tools
npx ai-session-cleaner --safe-run

# apply interactively
npx ai-session-cleaner

# apply without prompts
npx ai-session-cleaner --yes
```

## Examples

```bash
# preview everything with the default settings
npx ai-session-cleaner --safe-run

# clean only Claude Code and Codex sessions older than 30 days
npx ai-session-cleaner --agent claude-code,codex --older-than-days 30

# only match candidates with at least 1 MB of measurable reclaimable size
npx ai-session-cleaner --safe-run --larger-than 1MB

# ignore any project whose name or path contains "foo-bar"
npx ai-session-cleaner --safe-run --ignore-project foo-bar

# clean Codex but skip the default VACUUM compaction
npx ai-session-cleaner --agent codex --no-compact-sqlite --yes

# machine-readable output for scripts
npx ai-session-cleaner --safe-run --json

# disable ANSI colors in human-readable output
npx ai-session-cleaner --safe-run --no-color

# disable orphaned project detection and only use age-based cleanup
npx ai-session-cleaner --safe-run --no-orphaned
```

## Local development

If you are working from this repository:

```bash
npm install
npm run build
npm run start -- --safe-run
```

Or run directly with `tsx`:

```bash
npm run dev -- --safe-run
```

## What it cleans

The CLI focuses on cleanup that is both useful and safe to preview:

- sessions older than the configured age threshold
- orphaned session or project metadata whose original project root no longer exists

## Supported tools

| Tool                         | Agent id         | Coverage                                                                                                                                           |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                  | `claude-code`    | `~/.claude/projects`, `~/.claude/session-env`, `~/.claude/tasks`, `~/.claude/file-history`, `~/.claude/todos`, `~/.claude/debug`, `~/.claude.json` |
| Codex                        | `codex`          | `~/.codex/state_*.sqlite`, `~/.codex/logs_*.sqlite`, `~/.codex/history.jsonl`, `~/.codex/shell_snapshots`                                          |
| GitHub Copilot CLI           | `copilot`        | `~/.copilot/session-state`, `~/.copilot/logs/session-*`, platform-specific VS Code globalStorage metadata                                          |
| Copilot Chat (VS Code, beta) | `copilot-vscode` | VS Code `workspaceStorage/<hash>/chatSessions` and matching `chatEditingSessions` (editor state and embeddings caches are left untouched)          |
| Crush (beta)                 | `crush`          | `~/.local/share/crush/projects.json`, tracked project-local `.crush/crush.db` files, and tracked external Crush data dirs                          |
| Gemini CLI                   | `gemini`         | `~/.gemini/tmp`, `~/.gemini/history`, `~/.gemini/projects.json`                                                                                    |
| Opencode (beta)              | `opencode`       | `~/.local/share/opencode/opencode.db`, `~/.local/share/opencode/storage`, `~/.local/share/opencode/snapshot`                                       |

## Behavior

- `--older-than-days` defaults to `45`.
- Omitting `--agent` scans all supported tools: `claude-code`, `codex`, `copilot`, `copilot-vscode`, `crush`, `gemini`, and `opencode`.
- `--agent` is the primary public flag. `--provider` is still supported as a compatibility alias.
- `--ignore-project` ignores matching project names or paths with a case-insensitive substring match. Repeat it to ignore multiple projects.
- `--larger-than` filters candidates by measurable reclaimable size, using values like `500KB`, `1MB`, or `2GiB`.
- SQLite-backed tools (Codex, Opencode, Crush) run `VACUUM` after cleanup by default to reclaim file space. Use `--no-compact-sqlite` to skip it (`--compact-sqlite` is still accepted as an explicit opt-in).
- Human-readable output is colorized by default. Use `--no-color` to disable ANSI colors. JSON output stays uncolored.
- `--safe-run` is the recommended preview mode. `--dry-run` is still supported as an alias.
- Orphaned project detection is enabled by default. Use `--no-orphaned` if you only want age-based cleanup.

## Tooling

- `npm run format` formats the repository with Prettier.
- `npm run lint` runs ESLint and checks formatting with Prettier.
- `npm run typecheck` runs TypeScript type checking.
- `npm run clean` uses Node's built-in filesystem APIs and works across macOS, Linux, and Windows.
- `npm install` configures local git hooks for contributors in this repo.
- `pre-commit` formats staged files with Prettier and lints staged code with ESLint.
- `pre-push` runs `npm run typecheck` and `npm run build`.

## Notes

- Claude orphaned-project cleanup also removes matching entries from `~/.claude.json`.
- Claude per-session debug logs in `~/.claude/debug/<session-id>.txt` are cleaned with the matching session.
- Codex cleanup uses `libsql` so local SQLite access still works on Node 18. It removes database rows, shell snapshots, and history entries, and only touches tables the database actually has so it survives Codex schema changes between versions. `VACUUM` runs by default to reclaim file space (disable with `--no-compact-sqlite`).
- Size filtering only applies to measurable reclaimable bytes. Metadata-only items and candidates whose reclaimable size cannot be estimated remain `0 B` and will not match a positive `--larger-than` threshold.
- Copilot metadata cleanup uses the platform-specific VS Code `globalStorage/github.copilot-chat` directory instead of assuming a macOS-only path.
- The `copilot` (CLI) provider intentionally avoids deleting VS Code `workspaceStorage`, because that data is shared with other extensions. The separate `copilot-vscode` (beta) provider cleans VS Code Copilot Chat surgically: it removes only `chatSessions` and matching `chatEditingSessions`, never `state.vscdb` or the rebuildable embeddings caches in `globalStorage`. Only the stable "Code" build is scanned.
- Crush cleanup reads tracked project metadata from `~/.local/share/crush/projects.json`, removes old session rows from tracked `crush.db` files, and only deletes a shared `.crush` directory when no remaining tracked project still references it.
- Gemini project roots are recovered from both `~/.gemini/tmp/*/.project_root` and `~/.gemini/history/*/.project_root`, then matched to hashed temp directories.
- Gemini orphaned-project cleanup also removes matching entries from `~/.gemini/projects.json`.
- Once a Gemini project's last chat is cleaned, its whole `~/.gemini/tmp/<project>` directory is removed, including `/chat save` checkpoints and `logs/` that would otherwise be orphaned. Directories that still hold a live chat are left intact.
- Opencode cleanup removes matching SQLite rows from `~/.local/share/opencode/opencode.db` plus mapped session/project files under `storage` and `snapshot`. `VACUUM` runs by default to reclaim file space (disable with `--no-compact-sqlite`).
- Some provider-owned files are intentionally skipped when they cannot be mapped safely to a previewable session or project candidate.
