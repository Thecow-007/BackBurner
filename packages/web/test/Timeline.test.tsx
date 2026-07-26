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
