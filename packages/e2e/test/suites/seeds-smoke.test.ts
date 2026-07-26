import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALICE,
  BOB,
  EventCapture,
  listTasks,
  resetDatabase,
  runSeedCli,
  settle,
  spawnServer,
  stopServer,
  submit,
  type ServerHandle,
  type TaskListResponse,
  type TaskObject,
} from "../../src/index.js";

/**
 * Supplemental suite 5.9 — seeds smoke (test-plan.md §5.9; architecture.md
 * §12). Runs the real seed CLI (`scripts/seed.mjs`) as a child process
 * against the shared e2e test database via `runSeedCli`, then verifies the
 * result through the API only — seeded-corpus shape and bucket presence,
 * live-data coexistence, and the `--reset` lifecycle.
 *
 * ── Canonical supplemental-suite lifecycle (test-plan.md §3.1-§3.2) ──
 * One server per FILE (spawned in `beforeAll`, stopped in `afterAll`) —
 * unlike the criteria suite's fresh-server-per-test. Between tests, `settle()`
 * cancels every `queued`/`running` task through the API so the worker pool is
 * provably idle, and only THEN is the database truncated.
 *
 * Because `beforeEach` truncates `tasks`/`task_transitions`, the seed run
 * itself happens inside the single `it()` below — the seed CLI is
 * self-contained (a full seed clears prior seeded rows, then inserts fresh
 * ones), so there is nothing useful to pre-seed in a hook.
 */
describe("seeds-smoke", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await spawnServer();
  });

  afterAll(async () => {
    await stopServer(server);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    for (const user of [ALICE, BOB]) {
      const cap = new EventCapture(server.baseUrl, user.rawKey, { server });
      await cap.ready;
      await settle(server.baseUrl, user.rawKey, cap, { server });
      cap.close();
    }
  });

  const KEY_LINE_RE = /^(daniel|reviewer): (bb_[0-9a-f]{40})$/gm;

  /** Parses both `daniel:`/`reviewer:` key lines out of a seed run's stdout
   * and returns the `reviewer` key. Fails loudly (with the full stdout) if
   * either line is missing or malformed. */
  function parseReviewerKey(stdout: string, label: string): string {
    const found = new Map<string, string>();
    for (const m of stdout.matchAll(KEY_LINE_RE)) {
      found.set(m[1]!, m[2]!);
    }
    expect(found.size, `${label}: expected both daniel and reviewer key lines in stdout:\n${stdout}`).toBe(2);
    const reviewerKey = found.get("reviewer");
    expect(reviewerKey, `${label}: missing reviewer key line in stdout:\n${stdout}`).toBeDefined();
    return reviewerKey as string;
  }

  it("seeds a full corpus, exposes it through the API in every bucket, coexists with live data, and survives --reset", async () => {
    const b = server.baseUrl;

    // 1. Full seed over a fixed window; parse both printed raw keys.
    const fullSeed = await runSeedCli(["--tasks", "50", "--from", "2026-04-01", "--to", "2026-07-01"]);
    expect(fullSeed.code, `full seed failed:\n${fullSeed.stderr}`).toBe(0);
    const reviewerKey = parseReviewerKey(fullSeed.stdout, "full seed");

    // 2. Seeded-corpus shape, through the reviewer's own list.
    const listRes = await listTasks(b, reviewerKey, { limit: 200 });
    expect(listRes.status, `listTasks failed: ${JSON.stringify(listRes.body)}`).toBe(200);
    const seededTasks = (listRes.body as TaskListResponse).tasks;
    expect(seededTasks.length).toBeGreaterThan(0);

    const windowFrom = new Date("2026-04-01T00:00:00Z").getTime();
    const windowTo = new Date("2026-07-01T00:00:00Z").getTime();
    const allowedStatuses = new Set(["ready", "failed", "cancelled"]);

    const buckets = {
      readyCollected: false,
      readyUncollected: false,
      failedCollected: false,
      failedUncollected: false,
      cancelled: false,
    };

    for (const task of seededTasks) {
      expect(task.seeded, `task ${task.handle} should be seeded`).toBe(true);
      expect(allowedStatuses.has(task.status), `task ${task.handle} has disallowed status ${task.status}`).toBe(
        true
      );
      const createdAt = new Date(task.created_at).getTime();
      expect(
        createdAt,
        `task ${task.handle} created_at ${task.created_at} is before window start`
      ).toBeGreaterThanOrEqual(windowFrom);
      expect(createdAt, `task ${task.handle} created_at ${task.created_at} is at/after window end`).toBeLessThan(
        windowTo
      );

      if (task.status === "ready" && task.collected) buckets.readyCollected = true;
      if (task.status === "ready" && !task.collected) buckets.readyUncollected = true;
      if (task.status === "failed" && task.collected) buckets.failedCollected = true;
      if (task.status === "failed" && !task.collected) buckets.failedUncollected = true;
      if (task.status === "cancelled") buckets.cancelled = true;
    }

    for (const [bucket, present] of Object.entries(buckets)) {
      expect(present, `missing at least one seeded task in bucket "${bucket}"`).toBe(true);
    }

    // 3. Live-data coexistence: a real submit still works for the reviewer,
    // proving the real handle allocator tolerates the seeded rows.
    const liveRes = await submit(b, reviewerKey, { lane: "scrape", params: { duration_ms: 1000 } });
    expect(liveRes.status, `live submit failed: ${JSON.stringify(liveRes.body)}`).toBe(201);
    const liveTask = liveRes.body as TaskObject;
    expect(liveTask.seeded).toBe(false);
    expect(typeof liveTask.handle).toBe("string");
    expect(liveTask.handle.length).toBeGreaterThan(0);

    // 4. --reset: seeded rows gone, the real task survives, and the same
    // reviewer key (captured in step 1) is still valid — reset does not rotate.
    const resetResult = await runSeedCli(["--reset"]);
    expect(resetResult.code, `--reset failed:\n${resetResult.stderr}`).toBe(0);

    const afterResetRes = await listTasks(b, reviewerKey, { limit: 200 });
    expect(afterResetRes.status, `listTasks after reset failed: ${JSON.stringify(afterResetRes.body)}`).toBe(200);
    const afterResetTasks = (afterResetRes.body as TaskListResponse).tasks;

    const survivor = afterResetTasks.find((t) => t.id === liveTask.id);
    expect(survivor, "the live task from step 3 should survive --reset").toBeDefined();
    expect((survivor as TaskObject).seeded).toBe(false);
    expect(afterResetTasks.some((t) => t.seeded === true), "no task should remain seeded after --reset").toBe(
      false
    );

    // Re-seeding after reset is a normal full seed: succeeds and prints (and
    // rotates) both keys again.
    const reseed = await runSeedCli(["--tasks", "20"]);
    expect(reseed.code, `re-seed after reset failed:\n${reseed.stderr}`).toBe(0);
    parseReviewerKey(reseed.stdout, "re-seed after reset");
  });
});
