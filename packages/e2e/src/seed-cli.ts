/**
 * Runs the real seed CLI (`scripts/seed.mjs`) as a child process against the
 * e2e test database — the seeds-smoke suite (test-plan.md §5.9) exercises the
 * seeder exactly as an operator would, then verifies the result through the
 * API only. Mirrors `db.ts`'s `runMigrations` (which spawns `migrate.mjs`):
 * setup tooling may spawn repo scripts; assertions still never touch the DB.
 *
 * Requires a prior `npm run build` — the seed script imports the compiled
 * engine/api modules. In every environment that runs the e2e suites the build
 * has already happened (the harness spawns `packages/api/dist/server.js`).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getE2eDatabaseUrl } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SEED_SCRIPT = path.join(REPO_ROOT, "scripts", "seed.mjs");

export interface SeedCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `node scripts/seed.mjs <args>` with `DATABASE_URL` pointed at the e2e
 * test database (overridable via `extraEnv`). Resolves with the exit code and
 * captured stdout/stderr — never rejects on a non-zero exit, so callers assert
 * on `code` directly.
 */
export async function runSeedCli(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<SeedCliResult> {
  return new Promise<SeedCliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [SEED_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: getE2eDatabaseUrl(), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(new Error(`runSeedCli: failed to spawn seed.mjs: ${err.message}`)));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
