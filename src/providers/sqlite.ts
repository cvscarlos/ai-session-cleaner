import Database from "libsql";

import { pathExists } from "../utils.js";

/** Names of every table in an open database (for schema-drift–safe queries). */
export function listTables(
  database: InstanceType<typeof Database>,
): Set<string> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;

  return new Set(rows.map((row) => row.name));
}

export async function vacuumDatabase(path: string): Promise<void> {
  const database = new Database(path, { timeout: 5000 });

  try {
    database.exec("VACUUM");
  } finally {
    database.close();
  }
}

/**
 * Run VACUUM on each existing database path, collecting a warning per failure.
 * Returns true only if every attempted compaction succeeded.
 */
export async function compactSqliteFiles(
  paths: string[],
  warnings: string[],
): Promise<boolean> {
  let ok = true;

  for (const path of paths) {
    if (!(await pathExists(path))) {
      continue;
    }

    try {
      await vacuumDatabase(path);
    } catch (error) {
      ok = false;
      const message = error instanceof Error ? error.message : "Unknown error";
      warnings.push(`SQLite compaction failed for ${path}: ${message}`);
    }
  }

  return ok;
}
