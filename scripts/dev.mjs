#!/usr/bin/env node
// Cross-platform dev orchestrator. Spawns whichever workspace "dev" scripts
// exist, CONCURRENTLY — the api's Fastify server and web's Vite dev server are
// both long-running, so they cannot be run one after another. Vite proxies
// /tasks, /events and /health through to the api, so the SPA uses the same
// relative URLs in dev as it does in production (docs/api-contract.md §9).
//
// Lifecycle: the first child to exit takes the whole group down with it, so a
// crashed api never leaves an orphaned Vite server behind (and Ctrl-C stops
// both). On Windows the children are npm shims that spawn further processes,
// so teardown goes through `taskkill /T` to reach the whole tree.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const isWindows = process.platform === "win32";

const CANDIDATES = ["api", "web"];

function readPackageJson(dir) {
  const pkgJsonPath = path.join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  return JSON.parse(readFileSync(pkgJsonPath, "utf8"));
}

const runnable = [];
for (const name of CANDIDATES) {
  const pkg = readPackageJson(path.join(root, "packages", name));
  if (pkg && pkg.scripts && pkg.scripts.dev) runnable.push(pkg.name);
}

if (runnable.length === 0) {
  console.log('[dev] no workspace has a "dev" script — nothing to run, exiting 0.');
  process.exit(0);
}

const children = new Map(); // workspace name -> ChildProcess
let shuttingDown = false;

function killAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (isWindows && child.pid !== undefined) {
        // The child is an npm shim; SIGTERM would orphan its descendants.
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // Already gone — nothing to clean up.
    }
  }
}

for (const name of runnable) {
  console.log(`[dev] starting ${name} ...`);
  // See scripts/build.mjs for why shell: true is needed (and safe) here.
  const child = spawn("npm", ["run", "dev", "--workspace=" + name], {
    cwd: root,
    stdio: "inherit",
    shell: isWindows,
  });
  children.set(name, child);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`[dev] ${name} exited (${signal ?? `code ${code}`}) — stopping the rest.`);
    process.exitCode = code ?? 1;
    killAll();
  });

  child.on("error", (err) => {
    console.error(`[dev] failed to start ${name}:`, err.message);
    process.exitCode = 1;
    killAll();
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n[dev] ${signal} — shutting down.`);
    killAll();
  });
}
