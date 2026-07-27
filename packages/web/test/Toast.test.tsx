/**
 * The toast is the one surface that decides, on its own, when a notice stops
 * being visible. `frontend-brief.md` §7.1 originally made a failure persist
 * until dismissed; ADR 0023 replaced that with a 15s countdown that HOLDS while
 * the notice is being read. These tests pin both halves — the timing and the
 * hold — because the failure mode of getting either wrong is a notice that
 * disappears out from under someone.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Toast } from "../src/components/Toast.js";
import type { NotificationNotice } from "../src/lib/types.js";

function notice(over: Partial<NotificationNotice> = {}): NotificationNotice {
  return {
    eventId: 41,
    taskId: "0198c2f4-0000-7000-8000-00000000abcd",
    handle: "report-2",
    lane: "report",
    kind: "failed",
    detail: "worker: upstream returned HTTP 503",
    retryable: true,
    at: "2026-07-26T12:04:03.000Z",
    read: false,
    ...over,
  };
}

const noop = (): void => {};

describe("Toast — auto-dismiss", () => {
  it("clears a success after 6s", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast
        notice={notice({ kind: "ready", detail: "report-2 finished in 9.8s", retryable: undefined })}
        onOpen={noop}
        onDismiss={onDismiss}
      />
    );

    vi.advanceTimersByTime(5900);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onDismiss).toHaveBeenCalledWith(41);
  });

  it("clears a failure after 15s — long enough to read, not forever (ADR 0023)", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast notice={notice()} onOpen={noop} onDismiss={onDismiss} />);

    // Well past a success's lifetime, and still on screen.
    vi.advanceTimersByTime(10_000);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5100);
    expect(onDismiss).toHaveBeenCalledWith(41);
  });

  it("shows the countdown, so the disappearance is never a surprise", () => {
    vi.useFakeTimers();
    render(<Toast notice={notice()} onOpen={noop} onDismiss={noop} />);
    expect(screen.getByText("15s")).toBeInTheDocument();
  });

  it("still honours an explicit 0 as 'never', for a caller that wants that", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast notice={notice()} onOpen={noop} onDismiss={onDismiss} autoDismissMs={0} />);

    vi.advanceTimersByTime(120_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("Toast — the countdown holds while it is being read", () => {
  it("pauses on hover and resumes with the time that was left", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { container } = render(<Toast notice={notice()} onOpen={noop} onDismiss={onDismiss} />);
    const toast = container.firstElementChild as HTMLElement;

    vi.advanceTimersByTime(5000);
    fireEvent.mouseEnter(toast);
    expect(toast).toHaveAttribute("data-held", "true");

    // A minute of reading must not cost the notice its life.
    vi.advanceTimersByTime(60_000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    // 10s were left when the pointer arrived, so 9.9 is not yet enough.
    vi.advanceTimersByTime(9900);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onDismiss).toHaveBeenCalledWith(41);
  });

  it("pauses while the toast holds keyboard focus", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { container } = render(<Toast notice={notice()} onOpen={noop} onDismiss={onDismiss} />);
    const toast = container.firstElementChild as HTMLElement;

    // focusin from a control inside the toast, which is what tabbing produces.
    fireEvent.focus(screen.getByRole("button", { name: /Dismiss notification/ }));
    expect(toast).toHaveAttribute("data-held", "true");
    vi.advanceTimersByTime(60_000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.blur(screen.getByRole("button", { name: /Dismiss notification/ }));
    vi.advanceTimersByTime(15_100);
    expect(onDismiss).toHaveBeenCalledWith(41);
  });
});
