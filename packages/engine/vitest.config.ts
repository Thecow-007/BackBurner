import { defineConfig } from "vitest/config";

// Engine unit tests (test-plan.md §6): pure suites run in-process, DB-backed
// suites run serially against backburner_test_engine. globalSetup creates
// (if missing) and migrates that database once before any test file runs;
// per-test truncation + a fresh test user happen in each DB-backed file's
// own beforeEach (test/db.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/globalSetup.ts"],
  },
});
