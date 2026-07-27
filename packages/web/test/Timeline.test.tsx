/**
 * The timeline is where the engine's history is restated in prose, which makes
 * it the easiest place in the app to assert something the engine never said.
 * The copy register is pinned here.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Timeline } from "../src/components/Timeline.js";
import type { HistoryTransition } from "../src/lib/types.js";

const at = (seconds: number): string => new Date(Date.parse("2026-07-26T12:04:03.000Z") + seconds * 1000).toISOString();

/**
 * The clock the component compares transitions against, so "is this from
 * today?" is pinned rather than left to whatever day the suite runs on. It sits
 * within half an hour of `at(0)` and the older instants below are all mid-day
 * UTC, so every assertion holds in every timezone the suite might run in.
 */
const NOW = Date.parse("2026-07-26T12:30:00.000Z");

function t(over: Partial<HistoryTransition> & Pick<HistoryTransition, "event_type">): HistoryTransition {
  return {
    from_status: null,
    to_status: null,
    at: at(0),
    meta: {},
    ...over,
  };
}

describe("Timeline — attempt grouping", () => {
  it("groups a single-attempt success and measures only the work", () => {
    render(
      <Timeline
        transitions={[
          t({ event_type: "accepted", to_status: "queued", meta: { summary: "scrape-4 queued" }, at: at(0) }),
          t({ event_type: "running", from_status: "queued", to_status: "running", meta: { attempt: 1, max_attempts: 3 }, at: at(0) }),
          t({ event_type: "ready", from_status: "running", to_status: "ready", meta: { summary: "finished in 9.8 s" }, at: at(9.8) }),
          // Collected three minutes later — an operator action, not the work.
          t({ event_type: "collected", from_status: "ready", to_status: "ready", at: at(189.8) }),
        ]}
      />
    );

    expect(screen.getByText("ATTEMPT 1 OF 3")).toBeInTheDocument();
    // 9.8s, not 3:09 — the collect must not be folded into the attempt's span.
    expect(screen.getByText("9.8s")).toBeInTheDocument();
    expect(screen.queryByText("3:09")).not.toBeInTheDocument();
    expect(screen.getByText("operator collected · handle released")).toBeInTheDocument();
  });

  it("renders the attempt copy register exactly", () => {
    render(
      <Timeline
        transitions={[
          t({ event_type: "accepted", to_status: "queued", meta: { max_attempts: 3 }, at: at(0) }),
          t({ event_type: "running", from_status: "queued", to_status: "running", meta: { attempt: 1, max_attempts: 3 }, at: at(0) }),
          t({ event_type: "failed", from_status: "running", to_status: "failed", meta: { reason: "HTTP 503", retryable: true, attempt: 1, max_attempts: 3 }, at: at(11) }),
          t({ event_type: "retrying", from_status: "failed", to_status: "queued", meta: { attempt: 1, max_attempts: 3, run_after: at(13) }, at: at(11) }),
          t({ event_type: "running", from_status: "queued", to_status: "running", meta: { attempt: 3, max_attempts: 3 }, at: at(13) }),
        ]}
      />
    );

    expect(screen.getByText("— → queued · budget 3")).toBeInTheDocument();
    expect(screen.getByText("queued → running · worker claimed")).toBeInTheDocument();
    expect(screen.getByText("running → failed · HTTP 503 · retryable")).toBeInTheDocument();
    expect(screen.getByText("queued → running · final attempt")).toBeInTheDocument();
    expect(screen.getByText("backoff 2.0s — waiting")).toBeInTheDocument();
  });

  it("names an operator retry and a recovery re-queue distinctly", () => {
    render(
      <Timeline
        transitions={[
          t({ event_type: "retrying", from_status: "failed", to_status: "queued", meta: { operator: true, attempt: 0, max_attempts: 3 } }),
          t({ event_type: "retrying", from_status: "running", to_status: "queued", meta: { recovery: true, attempt: 1, max_attempts: 3 } }),
        ]}
      />
    );

    expect(screen.getByText("operator retry")).toBeInTheDocument();
    expect(screen.getByText("automatic retry after restart")).toBeInTheDocument();
  });
});

describe("Timeline — never claims what the engine did not", () => {
  it("says 'budget exhausted' only when the attempts actually ran out", () => {
    render(
      <Timeline
        transitions={[
          t({ event_type: "running", from_status: "queued", to_status: "running", meta: { attempt: 3, max_attempts: 3 }, at: at(0) }),
          t({ event_type: "failed", from_status: "running", to_status: "failed", meta: { reason: "worker: upstream returned HTTP 503", retryable: false, attempt: 3, max_attempts: 3 }, at: at(9) }),
        ]}
      />
    );
    expect(screen.getByText(/budget exhausted · terminal$/)).toBeInTheDocument();
  });

  it("does NOT claim exhaustion for a permanent failure with budget remaining", () => {
    // params.fail_permanent lands in `failed` on attempt 1 of 3. Saying the
    // budget was exhausted would assert something that never happened.
    render(
      <Timeline
        transitions={[
          t({ event_type: "running", from_status: "queued", to_status: "running", meta: { attempt: 1, max_attempts: 3 }, at: at(0) }),
          t({ event_type: "failed", from_status: "running", to_status: "failed", meta: { reason: "worker: invalid selector '.total'", retryable: false, attempt: 1, max_attempts: 3 }, at: at(2) }),
        ]}
      />
    );

    expect(screen.queryByText(/budget exhausted/)).not.toBeInTheDocument();
    expect(
      screen.getByText("running → failed · worker: invalid selector '.total' · not retryable")
    ).toBeInTheDocument();
  });

  it("renders a long failure reason verbatim, never truncated", () => {
    const reason =
      "worker: upstream returned HTTP 503 (Service Unavailable) for https://reports.internal/api/v2/ledger?period=2026-06 after 3 attempts; last response body: {\"error\":\"capacity\",\"retry_after\":null}";
    render(
      <Timeline
        transitions={[
          t({ event_type: "failed", from_status: "running", to_status: "failed", meta: { reason, retryable: true } }),
        ]}
      />
    );
    expect(screen.getByText(`running → failed · ${reason} · retryable`)).toBeInTheDocument();
  });

  it("omits an attempt duration rather than claiming an in-flight attempt took no time", () => {
    render(
      <Timeline
        transitions={[
          t({ event_type: "running", from_status: "queued", to_status: "running", meta: { attempt: 1, max_attempts: 3 } }),
        ]}
      />
    );
    expect(screen.queryByText("0.0s")).not.toBeInTheDocument();
  });

  it("is an ordered list, as the accessibility spec requires", () => {
    const { container } = render(
      <Timeline transitions={[t({ event_type: "accepted", to_status: "queued" })]} label="TIMELINE · 1 ATTEMPT" />
    );
    expect(container.querySelector("ol")).not.toBeNull();
    expect(screen.getByText("TIMELINE · 1 ATTEMPT")).toBeInTheDocument();
  });
});

/**
 * The rail is a line BETWEEN events. Drawing it below the last dot claims a
 * connection to something that has not happened, which is exactly the kind of
 * quiet lie ui-spec §0 exists to prevent.
 */
describe("Timeline — the rail terminates at the final dot", () => {
  const stems = (root: HTMLElement): number =>
    root.querySelectorAll("li[class*='node'] span[class*='stem']").length;

  it("draws no stem below the last node of the last attempt", () => {
    const { container } = render(
      <Timeline
        now={NOW}
        transitions={[
          t({ event_type: "accepted", to_status: "queued", at: at(0) }),
          t({ event_type: "running", from_status: "queued", to_status: "running", meta: { attempt: 1, max_attempts: 3 }, at: at(0) }),
          t({ event_type: "ready", from_status: "running", to_status: "ready", at: at(9.8) }),
        ]}
      />
    );

    const nodes = container.querySelectorAll("li[data-terminal='true']");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.textContent).toContain("ready");
    // Three nodes, two connections.
    expect(stems(container)).toBe(2);
  });

  it("keeps the stem on a node that is only last within an earlier attempt", () => {
    const { container } = render(
      <Timeline
        now={NOW}
        transitions={[
          t({ event_type: "running", from_status: "queued", to_status: "running", meta: { attempt: 1, max_attempts: 3 }, at: at(0) }),
          t({ event_type: "failed", from_status: "running", to_status: "failed", meta: { reason: "HTTP 503", retryable: true, attempt: 1, max_attempts: 3 }, at: at(11) }),
          t({ event_type: "running", from_status: "queued", to_status: "running", meta: { attempt: 2, max_attempts: 3 }, at: at(13) }),
          t({ event_type: "ready", from_status: "running", to_status: "ready", at: at(20) }),
        ]}
      />
    );

    // Only the very last node terminates; the `failed` that closes attempt 1
    // still has the next attempt to reach.
    expect(container.querySelectorAll("li[data-terminal='true']")).toHaveLength(1);
    expect(stems(container)).toBe(3);
  });

  it("keeps the stem on a last node that still has a backoff marker below it", () => {
    const { container } = render(
      <Timeline
        now={NOW}
        transitions={[
          t({ event_type: "running", from_status: "queued", to_status: "running", meta: { attempt: 1, max_attempts: 3 }, at: at(0) }),
          t({ event_type: "failed", from_status: "running", to_status: "failed", meta: { reason: "HTTP 503", retryable: true }, at: at(11) }),
          // Last node of the last group, but the dashed wait hangs below it.
          t({ event_type: "retrying", from_status: "failed", to_status: "queued", meta: { attempt: 1, max_attempts: 3, run_after: at(13) }, at: at(11) }),
        ]}
      />
    );

    expect(screen.getByText("backoff 2.0s — waiting")).toBeInTheDocument();
    expect(container.querySelectorAll("li[data-terminal='true']")).toHaveLength(0);
    expect(stems(container)).toBe(3);
  });
});

describe("Timeline — timestamps that are not from today carry their date", () => {
  it("renders a bare clock for a transition from today", () => {
    render(<Timeline now={NOW} transitions={[t({ event_type: "accepted", to_status: "queued", at: at(0) })]} />);
    const stamp = screen.getByText((_, node) => node?.tagName === "TIME");
    expect(stamp.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("dates a seeded transition from months earlier — 14:32:07 alone is a riddle", () => {
    render(
      <Timeline
        now={NOW}
        transitions={[t({ event_type: "accepted", to_status: "queued", at: "2026-03-04T12:00:00.000Z" })]}
      />
    );
    const stamp = screen.getByText((_, node) => node?.tagName === "TIME");
    expect(stamp.textContent).toMatch(/^04 Mar · \d{2}:\d{2}:\d{2}$/);
    // The machine-readable value is still the engine's exact instant.
    expect(stamp).toHaveAttribute("dateTime", "2026-03-04T12:00:00.000Z");
  });

  it("adds the year when the transition is not even from this year", () => {
    render(
      <Timeline
        now={NOW}
        transitions={[t({ event_type: "accepted", to_status: "queued", at: "2025-12-30T12:00:00.000Z" })]}
      />
    );
    expect(screen.getByText(/^30 Dec 2025 · \d{2}:\d{2}:\d{2}$/)).toBeInTheDocument();
  });
});
