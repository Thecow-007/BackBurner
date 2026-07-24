import { createHash } from "node:crypto";

/**
 * Test user fixtures (test-plan.md §3.3). Upserted directly by
 * `resetDatabase()` in `beforeEach` — the only permitted setup SQL besides
 * the truncation itself. All requests in the criteria/supplemental suites
 * authenticate as one of these two.
 */
export interface TestUser {
  /** Value stored in `users.name` — also the fixture's display name. */
  name: string;
  /** Raw `bb_`-prefixed API key. Send as `Authorization: Bearer <rawKey>`. */
  rawKey: string;
  /** `sha256(rawKey)` hex — the value actually stored in `users.api_key_hash`. */
  apiKeyHash: string;
}

/** `sha256(rawKey)` hex, matching the API's key storage scheme (api-contract §2). */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

function makeUser(name: string, rawKey: string): TestUser {
  return { name, rawKey, apiKeyHash: hashApiKey(rawKey) };
}

/** `bb_` + 40 hex chars (`a1` × 20) — default actor for every test. */
export const ALICE_RAW_KEY = "bb_" + "a1".repeat(20);

/** `bb_` + 40 hex chars (`b2` × 20) — cross-user isolation checks. */
export const BOB_RAW_KEY = "bb_" + "b2".repeat(20);

export const ALICE: TestUser = makeUser("e2e-alice", ALICE_RAW_KEY);
export const BOB: TestUser = makeUser("e2e-bob", BOB_RAW_KEY);

/** Both fixtures, in upsert order. */
export const TEST_USERS: readonly TestUser[] = [ALICE, BOB];
