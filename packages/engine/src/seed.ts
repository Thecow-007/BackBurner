/**
 * Engine-internal seed module — docs/architecture.md §12. **Not** on the
 * public runtime surface (index.ts); only the seed CLI (scripts/seed.mjs)
 * composes it, by importing this compiled module directly by path.
 *
 * It inserts backdated synthetic tasks with coherent transition timelines and
 * realistic per-lane params. Handles are allocated **through the real
 * allocator** (`lockAllocator` + `nextHandleNum`), so seeded active tasks can
 * never violate `one_active_handle`: the invariant holds for synthetic data
 * by the same mechanism that holds for real data. Every seeded row carries
 * `seeded = true`.
 *
 * Target distribution (architecture §12, normative): ≈70% ready+collected,
 * 10% cancelled, 10% failed+collected (older, acknowledged), 5%
 * ready+uncollected, 5% failed+uncollected (recent, actionable) — and **zero
 * queued or running rows**. A seeded in-flight job would be a lie the boot
 * recovery path (architecture §11) would immediately expose.
 *
 * Lanes and durations track the live registry (ADR 0021): all five registered
 * lanes appear, and `build` tasks are drawn from the long 20-90 s range so a
 * reviewer reading seeded history sees the same durations a live `build`
 * submit produces.
 */
import { lockAllocator, nextHandleNum } from "./allocator.js";
import { withTransaction } from "./db.js";
import { MOCK_DEFAULT_DURATION_RANGE, MOCK_LONG_DURATION_RANGE } from "./worker.js";
import type { Pool, PoolClient } from "pg";

/** Every registered lane (api-contract §1), so the seeded history exercises
 * all of them rather than only the first two. */
const LANES = ["scrape", "report", "convert", "build", "test"] as const;
/** The long-running lane: its seeded durations come from the same 20-90 s
 * range live submits draw from, so the corpus is coherent with what a
 * reviewer sees when they submit one (ADR 0021). */
const LONG_LANES: ReadonlySet<string> = new Set(["build"]);
const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Share of the two `ready` buckets that get a flaky (fail-then-succeed)
 * history instead of a clean first-attempt one. Purely a *shape* within
 * those buckets — the normative 70/10/10/5/5 category split in architecture
 * §12 is untouched. */
const FLAKY_SHARE = 0.2;

/** The five seeded outcome buckets. No `queued`/`running` — see file header. */
type Category =
  | "ready_collected"
  | "cancelled"
  | "failed_collected"
  | "ready_uncollected"
  | "failed_uncollected";

export interface SeedOptions {
  /** User ids to seed tasks for (their share of `total` is split evenly). */
  userIds: string[];
  /** Total tasks across all users. */
  total: number;
  /** Inclusive lower bound for `created_at`. */
  from: Date;
  /** Exclusive upper bound for `created_at` (and every transition `at`). */
  to: Date;
  /** Injectable RNG for reproducibility; defaults to `Math.random`. */
  rng?: () => number;
}

export interface SeedSummary {
  inserted: number;
  byCategory: Record<Category, number>;
}

interface TransitionSpec {
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  /** Offset in ms from the task's `created_at`. */
  offsetMs: number;
  meta: Record<string, unknown>;
}

interface TaskSpec {
  status: "ready" | "failed" | "cancelled";
  collected: boolean;
  attempts: number;
  params: Record<string, unknown>;
  result: unknown | null;
  error: { reason: string; retryable: boolean } | null;
  transitions: TransitionSpec[];
}

/**
 * Split `total` across the five categories at the normative ratios via the
 * largest-remainder (Hamilton) method, so the shares stay close to
 * 70/10/10/5/5 and the sum is exact. When `n >= 5`, every category is
 * guaranteed at least one row (so the seeded corpus always exercises all five
 * outcomes); the per-user shares handed here are always well above 5 for the
 * documented `--tasks` values.
 */
export function categoryCounts(n: number): Record<Category, number> {
  const order: Category[] = [
    "ready_collected",
    "cancelled",
    "failed_collected",
    "ready_uncollected",
    "failed_uncollected",
  ];
  const ratios: Record<Category, number> = {
    ready_collected: 0.7,
    cancelled: 0.1,
    failed_collected: 0.1,
    ready_uncollected: 0.05,
    failed_uncollected: 0.05,
  };

  const counts: Record<Category, number> = {
    ready_collected: 0,
    cancelled: 0,
    failed_collected: 0,
    ready_uncollected: 0,
    failed_uncollected: 0,
  };
  if (n <= 0) return counts;

  const guaranteeMin = n >= 5;

  // Base allocation: floor of the ideal share, bumped to at least 1 when we
  // can afford a min-per-category guarantee.
  const ideal = order.map((c) => ({ c, raw: ratios[c] * n }));
  for (const { c, raw } of ideal) {
    counts[c] = Math.max(guaranteeMin ? 1 : 0, Math.floor(raw));
  }

  let assigned = order.reduce((sum, c) => sum + counts[c], 0);

  // Distribute any shortfall to the largest fractional remainders (ties break
  // toward the larger ideal share, then the canonical order).
  if (assigned < n) {
    const byRemainder = ideal
      .map(({ c, raw }) => ({ c, raw, frac: raw - Math.floor(raw) }))
      .sort((a, b) => b.frac - a.frac || b.raw - a.raw);
    let i = 0;
    while (assigned < n) {
      counts[byRemainder[i % byRemainder.length]!.c] += 1;
      assigned += 1;
      i += 1;
    }
  } else if (assigned > n) {
    // Only reachable when the min-1 guarantee overshoots a tiny n; trim from
    // the smallest categories without dropping below 1.
    const bySize = [...order].sort((a, b) => counts[a] - counts[b]);
    let i = 0;
    while (assigned > n) {
      const c = bySize[i % bySize.length]!;
      if (counts[c] > 1) {
        counts[c] -= 1;
        assigned -= 1;
      }
      i += 1;
      if (i > order.length * (assigned + 1)) break; // safety valve
    }
  }

  return counts;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Random integer in `[min, max]`. */
function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * A `created_at` within `[from, to)`, biased by category: `failed_uncollected`
 * is "recent, actionable" (last ~15% of the window); `failed_collected` is
 * "older, acknowledged" (first ~40%); everything else spans the full window.
 * A one-hour tail is reserved so a task's whole transition timeline stays
 * strictly inside `[from, to)`.
 */
function createdAtFor(category: Category, from: Date, to: Date, rng: () => number): Date {
  const lo = from.getTime();
  const hi = Math.max(lo + 1, to.getTime() - 60 * 60 * 1000);
  const span = hi - lo;
  let t: number;
  if (category === "failed_uncollected") {
    t = hi - rng() * span * 0.15;
  } else if (category === "failed_collected") {
    t = lo + rng() * span * 0.4;
  } else {
    t = lo + rng() * span;
  }
  return new Date(Math.floor(t));
}

/**
 * Build the full task + transition spec for one seeded task. `lane` decides
 * only which duration range the synthetic `duration_ms` is drawn from — the
 * outcome shapes themselves are lane-independent.
 */
function buildTaskSpec(category: Category, rng: () => number, lane: string): TaskSpec {
  const range = LONG_LANES.has(lane) ? MOCK_LONG_DURATION_RANGE : MOCK_DEFAULT_DURATION_RANGE;
  const durationMs = randInt(rng, range.min, range.max);
  const claimDelay = randInt(rng, 200, 1500); // queued -> running
  const runningMeta = { attempt: 1, max_attempts: MAX_ATTEMPTS };

  switch (category) {
    case "ready_collected":
    case "ready_uncollected": {
      const collected = category === "ready_collected";
      // A minority of ready tasks are flaky: one retryable failure, a
      // backoff hop, then success on attempt 2 — the history a live
      // `params.fail_times: 1` submit produces. Same bucket, same status,
      // same collected-ness; only the journal and `attempts` differ, so the
      // normative category distribution is untouched.
      const flaky = rng() < FLAKY_SHARE;
      const attempts = flaky ? 2 : 1;
      const flakyReason =
        "mock flaky failure: attempt 1 of 1 scheduled to fail via params.fail_times";
      const backoffMs = 100;

      const transitions: TransitionSpec[] = [
        { eventType: "accepted", fromStatus: null, toStatus: "queued", offsetMs: 0, meta: { summary: "queued" } },
        { eventType: "running", fromStatus: "queued", toStatus: "running", offsetMs: claimDelay, meta: runningMeta },
      ];
      let readyAt = claimDelay + durationMs;
      if (flaky) {
        transitions.push({
          eventType: "retrying",
          fromStatus: "running",
          toStatus: "queued",
          offsetMs: readyAt,
          meta: {
            attempt: 1,
            max_attempts: MAX_ATTEMPTS,
            reason: flakyReason,
            run_after: new Date(0).toISOString(), // resolved at insert time
          },
        });
        readyAt += backoffMs;
        transitions.push({
          eventType: "running",
          fromStatus: "queued",
          toStatus: "running",
          offsetMs: readyAt,
          meta: { attempt: 2, max_attempts: MAX_ATTEMPTS },
        });
        readyAt += durationMs;
      }
      transitions.push({
        eventType: "ready",
        fromStatus: "running",
        toStatus: "ready",
        offsetMs: readyAt,
        meta: { summary: `finished in ${(durationMs / 1000).toFixed(1)}s` },
      });
      if (collected) {
        transitions.push({
          eventType: "collected",
          fromStatus: "ready",
          toStatus: "ready",
          offsetMs: readyAt + randInt(rng, 5000, 20 * 60 * 1000),
          meta: {},
        });
      }
      return {
        status: "ready",
        collected,
        attempts,
        params: flaky ? { duration_ms: durationMs, fail_times: 1 } : { duration_ms: durationMs },
        result: { message: "completed", slept_ms: durationMs },
        error: null,
        transitions,
      };
    }

    case "cancelled": {
      // Half cancelled from queued, half mid-run — both hold no handle after.
      const fromRunning = rng() < 0.5;
      if (fromRunning) {
        return {
          status: "cancelled",
          collected: false,
          attempts: 1,
          params: { duration_ms: durationMs },
          result: null,
          error: null,
          transitions: [
            { eventType: "accepted", fromStatus: null, toStatus: "queued", offsetMs: 0, meta: { summary: "queued" } },
            { eventType: "running", fromStatus: "queued", toStatus: "running", offsetMs: claimDelay, meta: runningMeta },
            {
              eventType: "cancelled",
              fromStatus: "running",
              toStatus: "cancelled",
              offsetMs: claimDelay + randInt(rng, 500, durationMs),
              meta: {},
            },
          ],
        };
      }
      return {
        status: "cancelled",
        collected: false,
        attempts: 0,
        params: { duration_ms: durationMs },
        result: null,
        error: null,
        transitions: [
          { eventType: "accepted", fromStatus: null, toStatus: "queued", offsetMs: 0, meta: { summary: "queued" } },
          {
            eventType: "cancelled",
            fromStatus: "queued",
            toStatus: "cancelled",
            offsetMs: randInt(rng, 1000, 30000),
            meta: {},
          },
        ],
      };
    }

    case "failed_collected": {
      // Older, acknowledged: a non-retryable (permanent) failure, then
      // collected — attempts stops at 1, retryable false. Handle already freed.
      const failedAt = claimDelay + durationMs;
      const reason = "mock permanent failure requested via params.fail_permanent";
      return {
        status: "failed",
        collected: true,
        attempts: 1,
        params: { duration_ms: durationMs, fail_permanent: true },
        result: null,
        error: { reason, retryable: false },
        transitions: [
          { eventType: "accepted", fromStatus: null, toStatus: "queued", offsetMs: 0, meta: { summary: "queued" } },
          { eventType: "running", fromStatus: "queued", toStatus: "running", offsetMs: claimDelay, meta: runningMeta },
          {
            eventType: "failed",
            fromStatus: "running",
            toStatus: "failed",
            offsetMs: failedAt,
            meta: { reason, retryable: false },
          },
          {
            eventType: "collected",
            fromStatus: "failed",
            toStatus: "failed",
            offsetMs: failedAt + randInt(rng, 60 * 1000, 6 * 60 * 60 * 1000),
            meta: {},
          },
        ],
      };
    }

    case "failed_uncollected": {
      // Recent, actionable: a retryable failure that exhausted its budget
      // over three attempts and is awaiting an operator decision. Holds its
      // handle (active). Coherent attempt chain:
      //   running(1) -> retrying(1) -> running(2) -> retrying(2) -> running(3) -> failed
      const reason = "mock failure requested via params.fail";
      const transitions: TransitionSpec[] = [
        { eventType: "accepted", fromStatus: null, toStatus: "queued", offsetMs: 0, meta: { summary: "queued" } },
      ];
      let offset = claimDelay;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        transitions.push({
          eventType: "running",
          fromStatus: "queued",
          toStatus: "running",
          offsetMs: offset,
          meta: { attempt, max_attempts: MAX_ATTEMPTS },
        });
        offset += durationMs;
        if (attempt < MAX_ATTEMPTS) {
          const backoff = 100 * 2 ** (attempt - 1);
          const runAfter = new Date(0); // filled in at insert time relative to at
          transitions.push({
            eventType: "retrying",
            fromStatus: "running",
            toStatus: "queued",
            offsetMs: offset,
            meta: { attempt, max_attempts: MAX_ATTEMPTS, reason, run_after: runAfter.toISOString() },
          });
          offset += backoff;
        }
      }
      transitions.push({
        eventType: "failed",
        fromStatus: "running",
        toStatus: "failed",
        offsetMs: offset,
        meta: { reason, retryable: true },
      });
      return {
        status: "failed",
        collected: false,
        attempts: MAX_ATTEMPTS,
        params: { duration_ms: durationMs, fail: true },
        result: null,
        error: { reason, retryable: true },
        transitions,
      };
    }
  }
}

async function insertSeededTask(
  client: PoolClient,
  userId: string,
  lane: string,
  createdAt: Date,
  spec: TaskSpec
): Promise<void> {
  await lockAllocator(client, userId, lane);
  const handleNum = await nextHandleNum(client, userId, lane);

  const at = (offsetMs: number): Date => new Date(createdAt.getTime() + offsetMs);
  const running = spec.transitions.find((t) => t.eventType === "running");
  const last = spec.transitions[spec.transitions.length - 1]!;
  const startedAt = running ? at(running.offsetMs) : null;
  const updatedAt = at(last.offsetMs);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO tasks
       (user_id, lane, handle_num, params, status, result, error, attempts,
        max_attempts, collected, seeded, enqueued_at, run_after, started_at,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,NULL,$12,$13,$14)
     RETURNING id`,
    [
      userId,
      lane,
      handleNum,
      spec.params,
      spec.status,
      spec.result,
      spec.error,
      spec.attempts,
      MAX_ATTEMPTS,
      spec.collected,
      createdAt, // enqueued_at
      startedAt,
      createdAt,
      updatedAt,
    ]
  );
  const taskId = rows[0]!.id;

  for (const tr of spec.transitions) {
    const atDate = at(tr.offsetMs);
    // For retrying rows, resolve run_after to an absolute time near `at`.
    const meta =
      tr.eventType === "retrying" && typeof tr.meta.run_after === "string"
        ? { ...tr.meta, run_after: new Date(atDate.getTime() + 200).toISOString() }
        : tr.meta;
    await client.query(
      `INSERT INTO task_transitions
         (task_id, user_id, event_type, from_status, to_status, at, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [taskId, userId, tr.eventType, tr.fromStatus, tr.toStatus, atDate, meta]
    );
  }
}

/**
 * Delete all seeded tasks and their transitions — and **only** those. Real
 * (non-seeded) rows and every user row are left untouched. Backs `--reset`
 * and is also run at the start of a full seed so re-seeding is idempotent
 * (no accumulation) rather than additive.
 */
export async function resetSeeded(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      "DELETE FROM task_transitions WHERE task_id IN (SELECT id FROM tasks WHERE seeded = true)"
    );
    await client.query("DELETE FROM tasks WHERE seeded = true");
  });
}

/**
 * Seed synthetic tasks. Clears existing seeded rows first (idempotent), then
 * inserts `total` tasks split evenly across `userIds`, each user's share
 * distributed across the five categories. One transaction per task, so each
 * `nextHandleNum` sees prior committed active rows — active seeded tasks
 * therefore receive collision-free handles exactly as real submits do.
 */
export async function seedTasks(pool: Pool, options: SeedOptions): Promise<SeedSummary> {
  const rng = options.rng ?? Math.random;
  const { userIds, total, from, to } = options;

  if (to.getTime() <= from.getTime()) {
    throw new Error(`seedTasks: --to (${to.toISOString()}) must be after --from (${from.toISOString()})`);
  }

  await resetSeeded(pool);

  const summary: SeedSummary = {
    inserted: 0,
    byCategory: {
      ready_collected: 0,
      cancelled: 0,
      failed_collected: 0,
      ready_uncollected: 0,
      failed_uncollected: 0,
    },
  };

  const nUsers = userIds.length;
  for (let u = 0; u < nUsers; u++) {
    const userId = userIds[u]!;
    // First user absorbs the remainder so the grand total is exact.
    const base = Math.floor(total / nUsers);
    const share = u === 0 ? total - base * (nUsers - 1) : base;
    const counts = categoryCounts(share);

    // Build a flat, shuffled list of categories for this user so handle
    // numbers interleave the way real traffic would.
    const plan: Category[] = [];
    for (const [category, count] of Object.entries(counts) as [Category, number][]) {
      for (let i = 0; i < count; i++) plan.push(category);
    }
    for (let i = plan.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [plan[i], plan[j]] = [plan[j]!, plan[i]!];
    }

    for (const category of plan) {
      const lane = pick(rng, LANES);
      const createdAt = createdAtFor(category, from, to, rng);
      const spec = buildTaskSpec(category, rng, lane);
      await withTransaction(pool, (client) => insertSeededTask(client, userId, lane, createdAt, spec));
      summary.inserted += 1;
      summary.byCategory[category] += 1;
    }
  }

  return summary;
}

/** Default window helpers for the CLI (architecture §12: 3 months back). */
export function defaultWindow(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - 90 * DAY_MS), to: now };
}
