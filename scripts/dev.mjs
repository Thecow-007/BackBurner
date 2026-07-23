#!/usr/bin/env node
// Cross-platform dev orchestrator. Spawns whichever workspace "dev" scripts
// already exist. In Phase 0 neither @backburner/api nor @backburner/web has
// one yet, so this just reports that and exits cleanly; Phase 3/5 add them
// (api's Fastify dev server, web's Vite dev server with its /tasks, /events,
// /health proxy).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const CANDIDATES = ["api", "web"];

function readPackageJson(dir) {
  const pkgJsonPath = path.join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  return JSON.parse(readFileSync(pkgJsonPath, "utf8"));
}

const runnable = [];
for (const name of CANDIDATES) {
  const pkg = readPackageJson(path.join(root, "packages", name));
  if (pkg && pkg.scripts && pkg.scripts.dev) {
    runnable.push(pkg.name);
  }
}

if (runnable.length === 0) {
  console.log("[dev] @backburner/api and @backburner/web have no \"dev\" script yet.");
  console.log("[dev] api's dev server lands in Phase 3, web's in Phase 5 (docs/build-plan.md).");
  console.log("[dev] nothing to run — exiting 0.");
  process.exit(0);
}

for (const name of runnable) {
  console.log(`[dev] starting ${name} ...`);
  // See scripts/build.mjs for why shell: true is needed (and safe) here.
  const result = spawnSync("npm", ["run", "dev", "--workspace=" + name], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
