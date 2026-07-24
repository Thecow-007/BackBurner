import { describe, expect, it } from "vitest";
import { deriveHandle, serializeTask, toIso } from "../src/serialize.js";
import type { TaskRow } from "../src/types.js";

const SPEC_FIELDS = [
  "handle",
  "lane",
  "params",
  "status",
  "result",
  "error",
  "created_at",
  "updated_at",
  "collected",
] as const;

const ADDITIVE_FIELDS = ["id", "attempts", "max_attempts", "seeded"] as const;

function baseRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "01981fa0-4b2d-7d31-9e5a-8c2f6b1d4e7a",
    user_id: "01981fa0-0000-7000-8000-000000000000",
    lane: "scrape",
    handle_num: 1,
    params: { duration_ms: 10000 },
    status: "queued",
    result: null,
    error: null,
    attempts: 0,
    max_attempts: 3,
    collected: false,
    seeded: false,
    enqueued_at: new Date("2026-07-21T18:00:00.000Z"),
    run_after: null,
    started_at: null,
    created_at: new Date("2026-07-21T18:00:00.000Z"),
    updated_at: new Date("2026-07-21T18:00:00.000Z"),
    ...overrides,
  };
}

describe("serializer (pure) — test-plan.md §6", () => {
  it("hides result unless status is ready, even when the column holds a historical value", () => {
    const stillHasOldResult = baseRow({ status: "queued", result: { message: "stale", slept_ms: 1 } });
    expect(serializeTask(stillHasOldResult).result).toBeNull();

    const running = baseRow({ status: "running", result: { message: "stale", slept_ms: 1 } });
    expect(serializeTask(running).result).toBeNull();

    const failed = baseRow({ status: "failed", result: { message: "stale", slept_ms: 1 }, error: { reason: "x", retryable: true } });
    expect(serializeTask(failed).result).toBeNull();

    const ready = baseRow({ status: "ready", result: { message: "scrape-1 completed", slept_ms: 10000 } });
    expect(serializeTask(ready).result).toEqual({ message: "scrape-1 completed", slept_ms: 10000 });
  });

  it("hides error unless status is failed, even when the column holds a historical value", () => {
    const queuedAfterRetry = baseRow({ status: "queued", error: { reason: "old failure", retryable: true } });
    expect(serializeTask(queuedAfterRetry).error).toBeNull();

    const ready = baseRow({ status: "ready", error: { reason: "old failure", retryable: true }, result: {} });
    expect(serializeTask(ready).error).toBeNull();

    const failed = baseRow({ status: "failed", error: { reason: "mock failure requested via params.fail", retryable: true } });
    expect(serializeTask(failed).error).toEqual({
      reason: "mock failure requested via params.fail",
      retryable: true,
    });
  });

  it("derives handle from lane + handle_num, never from storage", () => {
    const row = baseRow({ lane: "report", handle_num: 42 });
    expect(serializeTask(row).handle).toBe("report-42");
    expect(deriveHandle("report", 42)).toBe("report-42");
    // No field named "handle" exists on TaskRow at all (compile-time
    // guarantee) — serializeTask must compute it every time.
  });

  it("renders timestamps as ISO-8601 UTC with a Z suffix, millisecond precision", () => {
    const row = baseRow({
      created_at: new Date("2026-07-21T18:00:00.123Z"),
      updated_at: new Date("2026-07-21T18:00:01.000Z"),
    });
    const serialized = serializeTask(row);
    expect(serialized.created_at).toBe("2026-07-21T18:00:00.123Z");
    expect(serialized.updated_at).toBe("2026-07-21T18:00:01.000Z");
    expect(serialized.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(toIso(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
  });

  it("always includes all nine spec fields", () => {
    const serialized = serializeTask(baseRow());
    for (const field of SPEC_FIELDS) {
      expect(serialized).toHaveProperty(field);
    }
  });

  it("always includes the four documented additive fields", () => {
    const serialized = serializeTask(baseRow({ id: "test-id", attempts: 2, max_attempts: 5, seeded: true }));
    for (const field of ADDITIVE_FIELDS) {
      expect(serialized).toHaveProperty(field);
    }
    expect(serialized.id).toBe("test-id");
    expect(serialized.attempts).toBe(2);
    expect(serialized.max_attempts).toBe(5);
    expect(serialized.seeded).toBe(true);
  });

  it("echoes params and collected verbatim", () => {
    const serialized = serializeTask(baseRow({ params: { duration_ms: 5000, custom: "x" }, collected: true }));
    expect(serialized.params).toEqual({ duration_ms: 5000, custom: "x" });
    expect(serialized.collected).toBe(true);
  });
});
