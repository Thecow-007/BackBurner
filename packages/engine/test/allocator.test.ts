import { beforeEach, describe, expect, it } from "vitest";
import { nextHandleNum } from "../src/allocator.js";
import type { TaskStatus } from "../src/types.js";
import { getTestPool, insertTestUser, resetEngineTestDb, type TestUser } from "./db.js";

const pool = getTestPool();

async function insertFixtureTask(opts: {
  userId: string;
  lane: string;
  handleNum: number;
  status: TaskStatus;
  collected?: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO tasks (user_id, lane, handle_num, status, collected, max_attempts)
     VALUES ($1, $2, $3, $4, $5, 3)`,
    [opts.userId, opts.lane, opts.handleNum, opts.status, opts.collected ?? false]
  );
}

let user: TestUser;

beforeEach(async () => {
  user = await resetEngineTestDb();
});

describe("allocator: lowest-free handle_num (DB-backed) — test-plan.md §6", () => {
  it("empty lane -> 1", async () => {
    await expect(nextHandleNum(pool, user.id, "scrape")).resolves.toBe(1);
  });

  it("dense {1..5} active -> 6", async () => {
    for (let n = 1; n <= 5; n++) {
      await insertFixtureTask({ userId: user.id, lane: "scrape", handleNum: n, status: "queued" });
    }
    await expect(nextHandleNum(pool, user.id, "scrape")).resolves.toBe(6);
  });

  it("gapped {1,3,4} active -> 2", async () => {
    for (const n of [1, 3, 4]) {
      await insertFixtureTask({ userId: user.id, lane: "scrape", handleNum: n, status: "queued" });
    }
    await expect(nextHandleNum(pool, user.id, "scrape")).resolves.toBe(2);
  });

  it("collect frees 2 in {1,2,3} -> next is 2", async () => {
    await insertFixtureTask({ userId: user.id, lane: "scrape", handleNum: 1, status: "queued" });
    await insertFixtureTask({
      userId: user.id,
      lane: "scrape",
      handleNum: 2,
      status: "ready",
      collected: true, // collected -> inactive -> freed
    });
    await insertFixtureTask({ userId: user.id, lane: "scrape", handleNum: 3, status: "running" });
    await expect(nextHandleNum(pool, user.id, "scrape")).resolves.toBe(2);
  });

  it("same lane, two users -> each gets 1 independently", async () => {
    const other = await insertTestUser("allocator-other-user");
    await insertFixtureTask({ userId: user.id, lane: "scrape", handleNum: 1, status: "queued" });

    await expect(nextHandleNum(pool, user.id, "scrape")).resolves.toBe(2);
    await expect(nextHandleNum(pool, other.id, "scrape")).resolves.toBe(1);
  });

  it("same user, two lanes -> each numbered independently", async () => {
    await insertFixtureTask({ userId: user.id, lane: "scrape", handleNum: 1, status: "queued" });

    await expect(nextHandleNum(pool, user.id, "scrape")).resolves.toBe(2);
    await expect(nextHandleNum(pool, user.id, "report")).resolves.toBe(1);
  });

  it("ready+collected and cancelled rows are invisible to allocation", async () => {
    await insertFixtureTask({ userId: user.id, lane: "scrape", handleNum: 1, status: "ready", collected: true });
    await insertFixtureTask({ userId: user.id, lane: "scrape", handleNum: 2, status: "cancelled" });
    await expect(nextHandleNum(pool, user.id, "scrape")).resolves.toBe(1);
  });

  it("failed {1} uncollected -> next is 2 (finished-but-uncollected holds its handle)", async () => {
    await insertFixtureTask({ userId: user.id, lane: "scrape", handleNum: 1, status: "failed", collected: false });
    await expect(nextHandleNum(pool, user.id, "scrape")).resolves.toBe(2);
  });

  it("failed {1} collected -> next is 1 (collecting a failed task frees its handle)", async () => {
    await insertFixtureTask({ userId: user.id, lane: "scrape", handleNum: 1, status: "failed", collected: true });
    await expect(nextHandleNum(pool, user.id, "scrape")).resolves.toBe(1);
  });
});
