/**
 * `status.ts` is the single source for how a status looks and what its duration
 * slot says. If it drifts, every screen drifts with it — so the seven states of
 * the detail header and the five chips are pinned here.
 */
import { describe, expect, it } from "vitest";

import { allowedActions } from "../src/lib/matrix.js";
import { durationReadout, stateNote, statusPresentation, STATUS_ORDER } from "../src/lib/status.js";
import type { Task, TaskStatus } from "../src/lib/types.js";

function task(over: Partial<Task> = {}): Task {
  return {
    handle: "scrape-1",
    lane: "scrape",
    params: {},
    status: "queued",
    result: null,
    error: null,
    created_at: "2026-07-26T12:00:00.000Z",
    updated_at: "2026-07-26T12:00:09.800Z",
    collected: false,
    id: "0198f2c4-7b31-7a90-9d44-6c11e0f9a2b8",
    attempts: 0,
    max_attempts: 3,
    seeded: false,
    ...over,
  };
}

describe("statusPresentation", () => {
  it("labels every status verbatim — the API's word, never a paraphrase", () => {
    for (const status of STATUS_ORDER) {
      expect(statusPresentation(status).label).toBe(status);
    }
  });

  it("gives every status a glyph, so status is never conveyed by colour alone", () => {
    const glyphs = STATUS_ORDER.map((s) => statusPresentation(s).glyph);
    expect(glyphs).toEqual(["·", "▸", "✓", "✕", "⊘"]);
    expect(new Set(glyphs).size).toBe(5);
  });

  it("animates running and nothing else", () => {
    const animated = STATUS_ORDER.filter((s) => statusPresentation(s).animated);
    expect(animated).toEqual(["running"]);
  });

  it("makes running blue, never ember — ember is brand and action only", () => {
    expect(statusPresentation("running").color).toBe("var(--st-running)");
    for (const status of STATUS_ORDER) {
      expect(statusPresentation(status).color).not.toContain("ember");
      expect(statusPresentation(status).halo).not.toContain("ember");
      expect(statusPresentation(status).chipBg).not.toContain("ember");
    }
  });

  it("treats only queued and running as live", () => {
    const live = STATUS_ORDER.filter((s) => statusPresentation(s).live);
    expect(live).toEqual(["queued", "running"]);
  });
});

describe("durationReadout — the seven detail-header states", () => {
  it("queued waits, and ticks", () => {
    const r = durationReadout(task({ status: "queued" }));
    expect(r.label).toBe("WAITING");
    expect(r.live).toBe(true);
    expect(r.until).toBeNull();
    expect(r.terminalNote).toBeNull();
  });

  it("running counts elapsed from the claim, not from submission", () => {
    const t = task({ status: "running", attempts: 1 });
    const r = durationReadout(t);
    expect(r.label).toBe("ELAPSED");
    expect(r.live).toBe(true);
    // The claim is the most recent transition — measuring from created_at would
    // silently fold the queue wait into "elapsed".
    expect(r.since).toBe(t.updated_at);
  });

  it("ready totals, and is not terminal until collected", () => {
    const open = durationReadout(task({ status: "ready" }));
    expect(open.label).toBe("TOTAL");
    expect(open.live).toBe(false);
    expect(open.muted).toBe(false);
    expect(open.terminalNote).toBeNull();

    const done = durationReadout(task({ status: "ready", collected: true }));
    expect(done.muted).toBe(true);
    expect(done.terminalNote).toBe("terminal · view only");
  });

  it("failed spans its attempts, and pluralises honestly", () => {
    expect(durationReadout(task({ status: "failed", attempts: 3 })).label).toBe("ACROSS 3 ATTEMPTS");
    expect(durationReadout(task({ status: "failed", attempts: 1 })).label).toBe("ACROSS 1 ATTEMPT");
  });

  it("failed and collected is terminal but keeps its duration", () => {
    const r = durationReadout(task({ status: "failed", attempts: 3, collected: true }));
    expect(r.muted).toBe(true);
    expect(r.terminalNote).toBe("terminal · view only");
    expect(r.label).toBe("ACROSS 3 ATTEMPTS");
  });

  it("cancelled reads up to the cancel, and is always terminal", () => {
    const r = durationReadout(task({ status: "cancelled" }));
    expect(r.label).toBe("BEFORE CANCEL");
    expect(r.terminalNote).toBe("terminal · view only");
  });

  it("does not let collecting change how long the work took", () => {
    // `updated_at` moves to the collect instant, so measuring to it made a
    // 9.8s task read 27.5s once an operator got round to collecting it.
    const created = "2026-07-26T12:00:00.000Z";
    const finished = "2026-07-26T12:00:09.800Z";
    const collected = "2026-07-26T12:00:27.500Z";

    const open = durationReadout(task({ status: "ready", created_at: created, updated_at: finished }));
    const done = durationReadout(
      task({ status: "ready", collected: true, created_at: created, updated_at: collected }),
      finished
    );

    expect(done.until).toBe(open.until);
    expect(done.muted).toBe(true);
  });

  it("falls back to updated_at when history is not loaded, which is exact while uncollected", () => {
    const t = task({ status: "ready", collected: false });
    expect(durationReadout(t).until).toBe(t.updated_at);
  });

  it("always holds a duration, so the panel never jumps between states", () => {
    for (const status of STATUS_ORDER) {
      for (const collected of [false, true]) {
        const r = durationReadout(task({ status, collected }));
        expect(r.since).toBeTruthy();
        expect(r.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("stateNote", () => {
  it("never claims a queue position — no endpoint can source one", () => {
    const note = stateNote(task({ status: "queued" }));
    expect(note).toBe("attempt budget 3");
    expect(note).not.toMatch(/behind/);
  });

  it("omits the collection time when history is not loaded, rather than inventing one", () => {
    // And omits the word "collected" with it: the CollectedMarker sits beside
    // this note in every surface, so repeating it reads "collected collected".
    const t = task({ status: "ready", collected: true });
    expect(stateNote(t)).toBe("handle released · result shown below");
  });

  it("names the collection time in the operator's own wall clock when history has it", () => {
    // Notes and the timeline read in local time (the design's `worker claimed
    // 14:22:09`); only the metadata block carries the Z-suffixed UTC instant.
    const at = "2026-07-26T14:07:00.000Z";
    const local = new Date(at);
    const p = (n: number): string => String(n).padStart(2, "0");
    const expected = `${p(local.getHours())}:${p(local.getMinutes())}:${p(local.getSeconds())}`;

    const note = stateNote(task({ status: "ready", collected: true }), at);
    expect(note).toBe(`collected ${expected} · handle released · result shown below`);
  });

  it("tells a ready task's operator the handle is still leased", () => {
    expect(stateNote(task({ status: "ready" }))).toBe(
      "result held until you collect · handle still leased"
    );
  });

  it("never contradicts the retryable flag the error panel prints beside it", () => {
    // Retryable, budget spent: the attempts ran out, the error was not fatal.
    const exhausted = task({
      status: "failed",
      attempts: 3,
      max_attempts: 3,
      error: { reason: "HTTP 503", retryable: true },
    });
    expect(stateNote(exhausted)).toBe("budget exhausted · the engine will not retry it again");
    expect(stateNote(exhausted)).not.toMatch(/not retryable/);

    // Genuinely non-retryable: fail_permanent, budget untouched.
    const permanent = task({
      status: "failed",
      attempts: 1,
      max_attempts: 3,
      error: { reason: "invalid selector", retryable: false },
    });
    expect(stateNote(permanent)).toBe("not retryable by the engine");
    expect(stateNote(permanent)).not.toMatch(/budget exhausted/);
  });

  it("says retry is retired once a failed task is collected", () => {
    expect(stateNote(task({ status: "failed", collected: true }))).toBe(
      "retry permanently retired · error still shown"
    );
  });
});

describe("status.ts and matrix.ts agree", () => {
  it("offers no action on any state the duration slot calls terminal", () => {
    const cases: Array<[TaskStatus, boolean]> = [
      ["ready", true],
      ["failed", true],
      ["cancelled", false],
    ];
    for (const [status, collected] of cases) {
      const t = task({ status, collected });
      const readout = durationReadout(t);
      const actions = allowedActions(t);
      if (readout.terminalNote !== null) {
        expect(actions).toEqual({ collect: false, cancel: false, retry: false });
      }
    }
  });

  it("leaves an action available wherever the slot is not terminal", () => {
    for (const status of STATUS_ORDER) {
      const t = task({ status, collected: false });
      if (durationReadout(t).terminalNote === null) {
        const actions = allowedActions(t);
        expect(actions.collect || actions.cancel || actions.retry).toBe(true);
      }
    }
  });
});
