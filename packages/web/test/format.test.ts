import { describe, expect, it } from "vitest";

import {
  durationBetween,
  formatAttempts,
  formatDuration,
  formatRelative,
  humanizeMs,
  maskKey,
} from "../src/lib/format.js";

describe("formatDuration", () => {
  it("reads sub-minute durations to one decimal, as the design does", () => {
    expect(formatDuration(9800)).toBe("9.8s");
    expect(formatDuration(31_600)).toBe("31.6s");
    expect(formatDuration(0)).toBe("0.0s");
  });

  it("switches to M:SS at a minute and H:MM:SS at an hour", () => {
    expect(formatDuration(60_000)).toBe("1:00");
    expect(formatDuration(124_000)).toBe("2:04");
    expect(formatDuration(3_600_000)).toBe("1:00:00");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
  });

  it("never renders a negative or non-finite duration", () => {
    expect(formatDuration(-1)).toBe("0.0s");
    expect(formatDuration(Number.NaN)).toBe("0.0s");
  });
});

describe("durationBetween", () => {
  const start = "2026-07-26T12:00:00.000Z";

  it("measures to a fixed instant when one is given", () => {
    expect(durationBetween(start, "2026-07-26T12:00:09.800Z", 0)).toBe(9800);
  });

  it("measures to `now` when the end is open — the running/queued case", () => {
    const now = Date.parse(start) + 5000;
    expect(durationBetween(start, null, now)).toBe(5000);
  });

  it("clamps to zero rather than rendering a negative elapsed time", () => {
    expect(durationBetween(start, "2026-07-26T11:59:00.000Z", 0)).toBe(0);
  });

  it("returns 0 for an unparseable start instead of NaN", () => {
    expect(durationBetween("not-a-date", null, Date.now())).toBe(0);
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  const ago = (ms: number): string => formatRelative(new Date(now - ms).toISOString(), now);

  it("uses the register's spaced mono register", () => {
    expect(ago(2 * 60_000)).toBe("2 m ago");
    expect(ago(2 * 3_600_000)).toBe("2 h ago");
    expect(ago(3 * 86_400_000)).toBe("3 d ago");
  });

  it("says 'just now' rather than '0 m ago'", () => {
    expect(ago(1000)).toBe("just now");
  });

  it("never rounds a fresh timestamp down to zero minutes", () => {
    expect(ago(50_000)).toBe("1 m ago");
  });
});

describe("humanizeMs", () => {
  it("previews the submit form's duration field", () => {
    expect(humanizeMs(120_000)).toBe("2 m 0 s");
    expect(humanizeMs(10_000)).toBe("10 s");
    expect(humanizeMs(500)).toBe("500 ms");
  });

  it("returns null rather than a misleading approximation for unusable input", () => {
    // The field is empty, or holds something that is not a whole number of ms.
    expect(humanizeMs(Number.NaN)).toBeNull();
    expect(humanizeMs(0)).toBeNull();
    expect(humanizeMs(-5)).toBeNull();
    expect(humanizeMs(1.5)).toBeNull();
  });
});

describe("maskKey", () => {
  it("shows enough to tell two keys apart and no more", () => {
    expect(maskKey("bb_9f2ce4a1b7d8036c5e12f409ab87cd3210fe6b54")).toBe("bb_9f2ce4…6b54");
  });

  it("renders nothing when there is no key", () => {
    expect(maskKey(null)).toBe("");
  });
});

describe("formatAttempts", () => {
  it("shows an em dash for queued rows — 0 / 3 would imply a spent attempt", () => {
    expect(formatAttempts(0, 3, "queued")).toBe("—");
    expect(formatAttempts(0, 3, "running")).toBe("—");
  });

  it("shows consumed over budget once an attempt has actually been made", () => {
    expect(formatAttempts(1, 3, "running")).toBe("1 / 3");
    expect(formatAttempts(3, 3, "failed")).toBe("3 / 3");
  });
});
