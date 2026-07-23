#!/usr/bin/env node
// Cross-platform build orchestrator. Builds workspaces in explicit dependency
// order (engine, then api, then web) rather than relying on
// `npm run build --workspaces`, whose ordering is not guaranteed to match the
// dependency graph (CLAUDE.md: "engine builds before api").
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const BUILD_ORDER = ["engine", "api", "web"];

function readPackageJson(dir) {
  const pkgJsonPath = path.join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  return JSON.parse(readFileSync(pkgJsonPath, "utf8"));
}

for (const name of BUILD_ORDER) {
  const pkgDir = path.join(root, "packages", name);
  const pkg = readPackageJson(pkgDir);

  if (!pkg) {
    console.log(`[build] skip packages/${name}: no package.json`);
    continue;
  }

  if (!pkg.scripts || !pkg.scripts.build) {
    console.log(`[build] skip ${pkg.name} (packages/${name}): no "build" script yet`);
    continue;
  }

  console.log(`[build] ${pkg.name} ...`);
  // `shell: true` is required for npm's .cmd shim to run on Windows (a plain
  // spawnSync of "npm.cmd" fails with EINVAL there). Args are program-
  // controlled (package names from our own package.json, no untrusted
  // input), so the shell-quoting caveat Node warns about does not apply.
  const result = spawnSync("npm", ["run", "build", "--workspace=" + pkg.name], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(`[build] failed to spawn npm for ${pkg.name}:`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[build] ${pkg.name} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log("[build] done");
