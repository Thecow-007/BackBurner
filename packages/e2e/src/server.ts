import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { getE2eDatabaseUrl } from "./db.js";
import { T_BOOT, T_STOP } from "./timing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "packages", "api", "dist", "server.js");
const LOG_DIR = path.join(REPO_ROOT, "packages", "e2e", ".logs");

const READY_LINE = /^BACKBURNER_READY\s+(\{.*\})\s*$/;

export interface ServerHandle {
  proc: ChildProcess;
  port: number;
  baseUrl: string;
  logPath: string;
}

function baselineEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: getE2eDatabaseUrl(),
    PORT: "0",
    WORKER_CONCURRENCY: "4",
    BACKOFF_BASE_MS: "100",
    DRAIN_TIMEOUT_MS: "1000",
    SSE_HEARTBEAT_MS: "20000",
    NODE_ENV: "test",
    ...overrides,
  };
}

function sanitizeForFilename(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "unnamed";
}

/** Best-effort current test name, for the per-test log file (test-plan.md
 * §3.1). Falls back to a pid/timestamp label when called outside a running
 * vitest test (e.g. a scratch smoke script). */
function currentTestLabel(): string {
  try {
    const state = expect.getState();
    if (state?.currentTestName) return state.currentTestName;
  } catch {
    // not running inside vitest
  }
  return `adhoc-${process.pid}-${Date.now()}`;
}

let logFileCounter = 0;

function tailLines(text: string, lines: number): string {
  const all = text.split("\n");
  return all.slice(-lines).join("\n");
}

/**
 * Reads the tail of a spawned server's log file — used by every wait
 * helper's timeout error (test-plan.md §9 rule 5: failures must be
 * diagnosable from the buffered events plus the log tail).
 */
export function logTail(handle: ServerHandle, lines = 200): string {
  try {
    const content = readFileSync(handle.logPath, "utf8");
    return tailLines(content, lines);
  } catch (err) {
    return `(could not read log file ${handle.logPath}: ${(err as Error).message})`;
  }
}

/**
 * Spawns the real API server as a child process (test-plan.md §3.1):
 * `node packages/api/dist/server.js` with `PORT=0` and the baseline test env
 * (§3.4), merged with `envOverrides`. Waits for the single machine-readable
 * `BACKBURNER_READY {"port":<number>}` stdout line (bounded by `T_BOOT`),
 * then confirms `GET /health` once.
 *
 * Today (Phase 1) `packages/api/dist/server.js` does not exist, so the child
 * exits immediately — this fails fast with the exit code, the stderr/stdout
 * tail, and an explicit "no server implementation" note, rather than hanging
 * until `T_BOOT`.
 */
export async function spawnServer(
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<ServerHandle> {
  mkdirSync(LOG_DIR, { recursive: true });

  const label = sanitizeForFilename(currentTestLabel());
  logFileCounter += 1;
  const logPath = path.join(LOG_DIR, `${label}.${logFileCounter}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  const env = baselineEnv(envOverrides);

  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Pipe stdout+stderr to the log file for the entire life of the process
  // (test-plan.md §3.1 point 4), independent of the boot-line scan below.
  proc.stdout?.on("data", (chunk: Buffer) => logStream.write(chunk));
  proc.stderr?.on("data", (chunk: Buffer) => logStream.write(chunk));
  proc.once("exit", () => logStream.end());

  let bootLog = "";
  let stdoutTail = "";

  const readyPromise = new Promise<number>((resolve, reject) => {
    let settled = false;

    const onStdoutData = (chunk: Buffer) => {
      if (settled) return;
      const text = chunk.toString("utf8");
      bootLog += text;
      stdoutTail += text;
      let newlineIndex: number;
      while ((newlineIndex = stdoutTail.indexOf("\n")) !== -1) {
        const line = stdoutTail.slice(0, newlineIndex);
        stdoutTail = stdoutTail.slice(newlineIndex + 1);
        const match = READY_LINE.exec(line.trim());
        if (match) {
          try {
            const parsed = JSON.parse(match[1]!) as { port?: unknown };
            if (typeof parsed.port === "number") {
              settled = true;
              cleanup();
              resolve(parsed.port);
              return;
            }
          } catch {
            // Malformed ready-shaped line; keep scanning. If nothing valid
            // ever arrives, the T_BOOT timeout below still fires.
          }
        }
      }
    };
    const onStderrData = (chunk: Buffer) => {
      if (!settled) bootLog += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          `spawnServer: the server process exited before printing BACKBURNER_READY ` +
            `(code=${code}, signal=${signal}). No API server implementation exists yet ` +
            `at ${SERVER_ENTRY} — expected until Phase 3 lands packages/api.\n` +
            `--- child stdout/stderr tail ---\n${tailLines(bootLog, 80)}`
        )
      );
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`spawnServer: failed to spawn child process: ${err.message}`));
    };

    const cleanup = () => {
      proc.stdout?.off("data", onStdoutData);
      proc.stderr?.off("data", onStderrData);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };

    proc.stdout?.on("data", onStdoutData);
    proc.stderr?.on("data", onStderrData);
    proc.once("exit", onExit);
    proc.once("error", onError);
  });

  let port: number;
  try {
    port = await Promise.race([
      readyPromise,
      delay(T_BOOT).then((): never => {
        throw new Error(
          `spawnServer: timed out after T_BOOT=${T_BOOT}ms waiting for BACKBURNER_READY.\n` +
            `--- child stdout/stderr tail ---\n${tailLines(bootLog, 80)}`
        );
      }),
    ]);
  } catch (err) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
    }
    throw err;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const handle: ServerHandle = { proc, port, baseUrl, logPath };

  // Confirm GET /health once (test-plan.md §3.1 step 3).
  const healthRes = await fetch(`${baseUrl}/health`);
  if (healthRes.status !== 200) {
    throw new Error(
      `spawnServer: GET /health returned ${healthRes.status}, expected 200.\n` +
        logTail(handle)
    );
  }
  const healthBody = (await healthRes.json().catch(() => undefined)) as
    | { status?: unknown }
    | undefined;
  if (!healthBody || healthBody.status !== "ok") {
    throw new Error(
      `spawnServer: GET /health body was not {"status":"ok"}: ${JSON.stringify(healthBody)}`
    );
  }

  return handle;
}

function isExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForExit(proc: ChildProcess): Promise<void> {
  if (isExited(proc)) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once("exit", () => resolve());
  });
}

/**
 * Graceful stop (test-plan.md §3.1 step 5): SIGTERM, wait up to `T_STOP` for
 * exit, then SIGKILL. Safe to call twice (a no-op if the process has already
 * exited).
 *
 * Windows note (test-plan.md §8): on win32, `child.kill('SIGTERM')` is an
 * unconditional hard kill — Node cannot deliver a catchable SIGTERM to a
 * child process there — so the graceful-drain path is only genuinely
 * exercised on POSIX (CI/Linux). This function does not branch on platform;
 * it always sends SIGTERM first, matching the doc's instruction to document
 * the discrepancy rather than special-case it.
 */
export async function stopServer(handle: ServerHandle): Promise<void> {
  if (isExited(handle.proc)) return;

  const exited = waitForExit(handle.proc);
  handle.proc.kill("SIGTERM");

  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(T_STOP).then(() => true),
  ]);

  if (timedOut && !isExited(handle.proc)) {
    handle.proc.kill("SIGKILL");
  }

  await exited;
}

/**
 * Hard kill (test-plan.md §3.1 step 5): `child.kill('SIGKILL')` — a hard
 * kill on POSIX and `TerminateProcess` on Windows, exactly the crash
 * semantics criterion 09 requires. Safe to call twice.
 */
export async function killServer(handle: ServerHandle): Promise<void> {
  if (isExited(handle.proc)) return;
  const exited = waitForExit(handle.proc);
  handle.proc.kill("SIGKILL");
  await exited;
}
