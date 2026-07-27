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

  const KEY_LINE_RE = /^(daniel|reviewer|newcomer): (bb_[0-9a-f]{40})$/gm;
  /** All three seed users are provisioned and printed; only the first two
   * receive tasks (architecture §12). `newcomer` exists precisely so every
   * empty state can be demonstrated against a real key. */
  const SEED_USERS = ["daniel", "reviewer", "newcomer"] as const;

  /** Parses all three key lines out of a seed run's stdout. Fails loudly
   * (with the full stdout) if any line is missing or malformed. */
  function parseSeedKeys(stdout: string, label: string): Map<string, string> {
    const found = new Map<string, string>();
    for (const m of stdout.matchAll(KEY_LINE_RE)) {
      found.set(m[1]!, m[2]!);
    }
    expect(
      [...found.keys()].sort(),
      `${label}: expected a key line for every seed user in stdout:\n${stdout}`
    ).toEqual([...SEED_USERS].sort());
    return found;
  }

  function parseReviewerKey(stdout: string, label: string): string {
    return parseSeedKeys(stdout, label).get("reviewer") as string;
  }

  it("seeds a full corpus, exposes it through the API in every bucket, coexists with live data, and survives --reset", async () => {
    const b = server.baseUrl;

    // 1. Full seed over a fixed window; parse both printed raw keys.
    const fullSeed = await runSeedCli(["--tasks", "50", "--from", "2026-04-01", "--to", "2026-07-01"]);
    expect(fullSeed.code, `full seed failed:\n${fullSeed.stderr}`).toBe(0);
    const seedKeys = parseSeedKeys(fullSeed.stdout, "full seed");
    const reviewerKey = seedKeys.get("reviewer") as string;
    const newcomerKey = seedKeys.get("newcomer") as string;

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

    // Seeded history exercises every registered lane, not just the first two.
    const seededLanes = new Set(seededTasks.map((t) => t.lane));
    for (const lane of ["scrape", "report", "convert", "build", "test"]) {
      expect(seededLanes.has(lane), `no seeded task in lane "${lane}"`).toBe(true);
    }
    // `build` is the long lane live; its seeded durations must agree, or the
    // seeded corpus would teach a reviewer the wrong thing about it.
    for (const task of seededTasks.filter((t) => t.lane === "build")) {
      const d = task.params.duration_ms as number;
      expect(d, `seeded build ${task.handle} duration ${d}`).toBeGreaterThanOrEqual(20000);
      expect(d, `seeded build ${task.handle} duration ${d}`).toBeLessThanOrEqual(90000);
    }

    // 2b. `newcomer` is provisioned with a working key and ZERO tasks — the
    // empty-state demo account. Its register is empty while still carrying
    // the full registered-lane list, exactly like any new user's.
    const newcomerRes = await listTasks(b, newcomerKey, { limit: 200 });
    expect(newcomerRes.status, `newcomer list failed: ${JSON.stringify(newcomerRes.body)}`).toBe(200);
    const newcomerBody = newcomerRes.body as TaskListResponse;
    expect(newcomerBody.tasks, "newcomer must have no tasks at all").toEqual([]);
    expect(newcomerBody.counts.all).toBe(0);
    expect(newcomerBody.counts.matching).toBe(0);
    expect(newcomerBody.counts.uncollected).toBe(0);
    expect(newcomerBody.counts.lanes).toEqual(["scrape", "report", "convert", "build", "test"]);

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

    // `--reset` ensures all three seed users exist without rotating any key,
    // so the empty-state account survives it too.
    const newcomerAfterReset = await listTasks(b, newcomerKey, { limit: 200 });
    expect(newcomerAfterReset.status, "newcomer key still valid after --reset").toBe(200);
    expect((newcomerAfterReset.body as TaskListResponse).tasks).toEqual([]);

    // Re-seeding after reset is a normal full seed: succeeds and prints (and
    // rotates) both keys again.
    const reseed = await runSeedCli(["--tasks", "20"]);
    expect(reseed.code, `re-seed after reset failed:\n${reseed.stderr}`).toBe(0);
    parseReviewerKey(reseed.stdout, "re-seed after reset");
  });
});
