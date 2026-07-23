import { defineConfig } from "vitest/config";

// Engine unit tests (test-plan.md §6): pure suites run in-process, DB-backed
// suites run serially against backburner_test_engine. No test files exist yet
// in Phase 0 — `--passWithNoTests` (package.json script) keeps this green.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
