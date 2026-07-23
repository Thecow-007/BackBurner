#!/usr/bin/env node
// Runs the full e2e matrix (criteria + supplemental) from packages/e2e,
// forwarding any extra CLI args as vitest filter patterns — so
// `npm run test:e2e -- criterion-09` runs only that criterion. See
// packages/e2e/vitest.config.ts for the include globs covering both suites.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = path.join(__dirname, "..", "packages", "e2e");
const extraArgs = process.argv.slice(2);

// See scripts/build.mjs for why shell: true is needed (and safe) here.
const result = spawnSync("npx", ["vitest", "run", "--passWithNoTests", ...extraArgs], {
  cwd: e2eDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error("[test:e2e] failed to spawn vitest:", result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
