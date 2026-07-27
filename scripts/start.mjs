#!/usr/bin/env node
// Production entrypoint (docs/deployment.md §2, docs/architecture.md §13).
//
// Two steps, in this order, and the order is the point:
//
//   1. Run the idempotent migration runner. A no-op restart is safe; a
//      failure here is fatal. "A container that cannot migrate does not
//      start — the app never runs against a schema it does not expect."
//   2. Start the api in THIS process.
//
// Step 2 is an `import`, not a spawn, deliberately. The api installs a
// SIGTERM handler that drains in-flight workers before exiting (server.ts
// §7). If it ran as a child of this script, Docker's SIGTERM would arrive
// here at PID 1 and the api would never see it — jobs would be torn down
// mid-flight on every deploy and left for boot recovery to clean up. Loading
// it in-process makes the api itself PID 1's handler.
//
// The migration runner, by contrast, IS a child: it needs its own exit code
// checked before anything else happens, and it calls process.exit() on
// failure, which an in-process import would apply to the whole container
// before the error could be reported cleanly.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

console.log("[start] applying migrations ...");

// process.execPath, not "node": no PATH lookup, no shell, and therefore no
// quoting concerns on any platform.
const migrate = spawnSync(process.execPath, [path.join(root, "scripts", "migrate.mjs")], {
  cwd: root,
  stdio: "inherit",
});

if (migrate.error) {
  console.error("[start] could not run the migration runner:", migrate.error.message);
  process.exit(1);
}

if (migrate.status !== 0) {
  console.error(
    `[start] migrations failed with exit code ${migrate.status}; refusing to start the api ` +
      `against an unknown schema (docs/deployment.md §2).`
  );
  process.exit(migrate.status ?? 1);
}

console.log("[start] migrations applied; starting the api ...");

// pathToFileURL, not a bare path: ESM dynamic import requires a URL, and a
// Windows path without it is read as a protocol (cross-platform rule).
const serverEntry = path.join(root, "packages", "api", "dist", "server.js");
await import(pathToFileURL(serverEntry).href);
