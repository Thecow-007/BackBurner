import { defineConfig } from "vitest/config";

// Black-box e2e harness (test-plan.md §2-3): spawns the real API server as a
// child process and drives it over fetch/EventSource. Both suites live under
// one config; `test:criteria` / `test:supplemental` (package.json) filter to
// one directory each via a CLI path argument, and `scripts/run-e2e.mjs`
// forwards extra args (e.g. `criterion-09`) to filter further.
//
// fileParallelism: false and generous timeouts are normative per test-plan.md
// §2 / §3.6 (criteria 06 and 09 legitimately run ~37s and ~55s) — set here
// now so Phase 1 does not have to remember to add them.
export default defineConfig({
  test: {
    include: ["test/criteria/**/*.test.ts", "test/suites/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    retry: 0,
    // test-plan.md §3.2: ensures backburner_test_e2e exists and is migrated
    // before any test file runs. Idempotent.
    globalSetup: "./src/globalSetup.ts",
  },
});
