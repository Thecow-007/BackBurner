#!/usr/bin/env node
// Cross-platform migration runner (docs/architecture.md §3, §13;
// docs/build-plan.md Phase 0). No dependency beyond `pg` (hoisted from
// @backburner/engine's dependency). Applies numbered .sql files from root
// migrations/ in filename order, each in its own transaction, tracked in
// schema_migrations by version + sha256 checksum. Idempotent: an
// already-applied version is skipped unless its checksum has changed, which
// is a fail-fast error — migrations are append-only (CLAUDE.md).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

function parseArgs(argv) {
  let databaseUrl;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--database-url") {
      databaseUrl = argv[i + 1];
      i++;
    } else if (arg.startsWith("--database-url=")) {
      databaseUrl = arg.slice("--database-url=".length);
    }
  }
  return { databaseUrl };
}

async function main() {
  const { databaseUrl: cliDatabaseUrl } = parseArgs(process.argv.slice(2));
  const databaseUrl = cliDatabaseUrl ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error(
      "[migrate] DATABASE_URL is required (set the env var or pass --database-url=<connection-string>)."
    );
    process.exit(1);
    return;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.join(__dirname, "..", "migrations");

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let applied = 0;
  let skipped = 0;

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version      text PRIMARY KEY,
        applied_at   timestamptz NOT NULL DEFAULT now(),
        checksum     text NOT NULL
      )
    `);

    for (const file of files) {
      const fullPath = path.join(migrationsDir, file);
      const sql = readFileSync(fullPath, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");

      const { rows } = await client.query(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [file]
      );

      if (rows.length > 0) {
        const existing = rows[0];
        if (existing.checksum !== checksum) {
          throw new Error(
            `checksum mismatch for already-applied migration "${file}": ` +
              `migrations are append-only and must never be edited after being applied ` +
              `(CLAUDE.md, docs/architecture.md §3). Add a new numbered migration instead.`
          );
        }
        skipped++;
        continue;
      }

      console.log(`[migrate] applying ${file} ...`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [file, checksum]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      applied++;
    }

    console.log(
      `[migrate] ${applied} applied, ${skipped} skipped, ${files.length} total.`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
