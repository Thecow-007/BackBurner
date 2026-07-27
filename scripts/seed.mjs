#!/usr/bin/env node
// Seed CLI — docs/architecture.md §12, docs/test-plan.md §5.9. Composes the
// engine's internal seed module (writes tasks/task_transitions through the
// real allocator) with the api's user-provisioning module (writes users),
// honoring the package table-ownership rules even for seeding.
//
// Requires a prior `npm run build`: this script imports the compiled
// packages/engine/dist and packages/api/dist modules directly by path (the
// engine seed module is deliberately off the public runtime surface, so it is
// never re-exported from an entrypoint — only this script composes it).
//
// Usage:
//   npm run seed -- --tasks 300 --from 2026-04-01 --to 2026-07-21
//   npm run seed -- --reset
// Flags: --tasks N (default 300), --from DATE, --to DATE (defaults: to=now,
// from=to-90d), --reset (delete seeded rows only; upsert — never rotate —
// seed users), --database-url=<conn> (else DATABASE_URL).
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { seedTasks, resetSeeded, defaultWindow } from "../packages/engine/dist/seed.js";
import { upsertSeedUser, ensureSeedUser } from "../packages/api/dist/users.js";

// Every seed user is provisioned and has its key printed. Only the users in
// TASK_SEED_USERS receive tasks: `newcomer` is deliberately left with an
// empty register so every empty state in the dashboard can be demonstrated on
// demand, against a real key, without deleting anybody's data.
const SEED_USERS = ["daniel", "reviewer", "newcomer"];
const TASK_SEED_USERS = ["daniel", "reviewer"];

function parseArgs(argv) {
  const out = { tasks: 300, from: undefined, to: undefined, reset: false, databaseUrl: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--reset") {
      out.reset = true;
    } else if (arg === "--tasks") {
      out.tasks = Number.parseInt(argv[++i], 10);
    } else if (arg.startsWith("--tasks=")) {
      out.tasks = Number.parseInt(arg.slice("--tasks=".length), 10);
    } else if (arg === "--from") {
      out.from = argv[++i];
    } else if (arg.startsWith("--from=")) {
      out.from = arg.slice("--from=".length);
    } else if (arg === "--to") {
      out.to = argv[++i];
    } else if (arg.startsWith("--to=")) {
      out.to = arg.slice("--to=".length);
    } else if (arg === "--database-url") {
      out.databaseUrl = argv[++i];
    } else if (arg.startsWith("--database-url=")) {
      out.databaseUrl = arg.slice("--database-url=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function parseDate(input, label) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid ${label} date: "${input}" (use YYYY-MM-DD or an ISO-8601 timestamp)`);
  }
  return d;
}

function newRawKey() {
  return "bb_" + randomBytes(20).toString("hex"); // 40 lowercase hex chars
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[seed] DATABASE_URL is required (set the env var or pass --database-url=<conn>).");
    process.exit(1);
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    if (args.reset) {
      // Delete seeded rows only; ensure seed users exist without rotating keys.
      await resetSeeded(pool);
      for (const name of SEED_USERS) {
        await ensureSeedUser(pool, name, newRawKey());
      }
      console.log("[seed] reset: seeded tasks removed; seed users preserved.");
      return;
    }

    if (!Number.isInteger(args.tasks) || args.tasks < 1) {
      throw new Error(`--tasks must be a positive integer (got ${args.tasks})`);
    }

    const now = new Date();
    const to = args.to !== undefined ? parseDate(args.to, "--to") : now;
    const from =
      args.from !== undefined ? parseDate(args.from, "--from") : defaultWindow(to).from;

    // Provision (rotate + print) every seed user, capturing the ids of the
    // ones that get tasks.
    const userIds = [];
    for (const name of SEED_USERS) {
      const rawKey = newRawKey();
      const id = await upsertSeedUser(pool, name, rawKey);
      if (TASK_SEED_USERS.includes(name)) userIds.push(id);
      // The one place raw keys are ever printed (api-contract §2).
      console.log(`${name}: ${rawKey}`);
    }

    const summary = await seedTasks(pool, { userIds, total: args.tasks, from, to });
    const byCat = Object.entries(summary.byCategory)
      .map(([c, n]) => `${c}=${n}`)
      .join(", ");
    console.log(
      `[seed] inserted ${summary.inserted} tasks across ${userIds.length} users ` +
        `in [${from.toISOString()}, ${to.toISOString()}). ${byCat}`
    );
    console.log(
      `[seed] newcomer intentionally has zero tasks — use its key to demo the empty states.`
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[seed] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
