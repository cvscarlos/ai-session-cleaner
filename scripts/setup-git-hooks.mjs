import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");

  if (!existsSync(resolve(repoRoot, ".git"))) {
    return;
  }

  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    process.stderr.write("Warning: failed to configure git hooks path.\n");
  }
}

main();
