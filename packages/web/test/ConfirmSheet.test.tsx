/**
 * Every action started from the mobile list confirms in a sheet first, so a
 * thumb never fires a mutation mid-scroll. That makes the sheet a modal on the
 * critical path of cancel, retry and collect — and a modal that leaks focus or
 * cannot be escaped is a trap in the bad sense.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../src/components/Button.js";
import { ConfirmSheet } from "../src/components/ConfirmSheet.js";

function setup(over: Partial<Parameters<typeof ConfirmSheet>[0]> = {}) {
  const onConfirm = vi.fn();
  const onDismiss = vi.fn();
  const utils = render(
    <>
      <button type="button">outside before</button>
      <ConfirmSheet
        open
        question="Cancel scrape-1? A running worker will be stopped."
        confirmLabel="Cancel task"
        dismissLabel="Keep running"
        onConfirm={onConfirm}
        onDismiss={onDismiss}
        {...over}
      />
      <button type="button">outside after</button>
    </>
  );
  return { ...utils, onConfirm, onDismiss };
}

describe("ConfirmSheet", () => {
  it("renders nothing when closed", () => {
    render(
      <ConfirmSheet
        open={false}
        question="Cancel scrape-1?"
        confirmLabel="Cancel task"
        dismissLabel="Keep running"
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is a labelled modal dialog naming the task", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent("Cancel scrape-1? A running worker will be stopped.");
  });

  it("opens with focus on the safe choice, not the destructive one", async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Keep running" })).toHaveFocus();
    });
  });

  it("keeps Tab inside the sheet", async () => {
    const user = userEvent.setup();
    setup();
    const dismiss = screen.getByRole("button", { name: "Keep running" });
    const confirm = screen.getByRole("button", { name: "Cancel task" });

    await waitFor(() => expect(dismiss).toHaveFocus());
    await user.tab();
    expect(confirm).toHaveFocus();
    // Wrapping past the last control returns to the first, never to the page.
    await user.tab();
    expect(dismiss).toHaveFocus();
  });

  it("wraps backwards too", async () => {
    const user = userEvent.setup();
    setup();
    const dismiss = screen.getByRole("button", { name: "Keep running" });
    const confirm = screen.getByRole("button", { name: "Cancel task" });

    await waitFor(() => expect(dismiss).toHaveFocus());
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it("dismisses on Escape", async () => {
    const user = userEvent.setup();
    const { onDismiss, onConfirm } = setup();
    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("dismisses on a scrim tap but not on a tap inside the sheet", async () => {
    const user = userEvent.setup();
    const { onDismiss } = setup();

    await user.click(screen.getByRole("dialog"));
    expect(onDismiss).not.toHaveBeenCalled();

    const scrim = screen.getByRole("dialog").parentElement;
    expect(scrim).not.toBeNull();
    await user.click(scrim!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("confirms only on the confirm control", async () => {
    const user = userEvent.setup();
    const { onConfirm, onDismiss } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("restores focus to whatever opened it", async () => {
    const user = userEvent.setup();
    const opener = document.createElement("button");
    opener.textContent = "open";
    document.body.appendChild(opener);
    opener.focus();

    const { rerender } = render(
      <ConfirmSheet
        open
        question="Cancel scrape-1?"
        confirmLabel="Cancel task"
        dismissLabel="Keep running"
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep running" })).toHaveFocus());

    rerender(
      <ConfirmSheet
        open={false}
        question="Cancel scrape-1?"
        confirmLabel="Cancel task"
        dismissLabel="Keep running"
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
    void user;
  });
});

describe("Button — the pending contract", () => {
  it("swaps the label and stays reachable, because waiting is the news", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button pending pendingLabel="Cancelling…" onClick={onClick}>
        Cancel
      </Button>
    );

    const button = screen.getByRole("button", { name: "Cancelling…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    // A native `disabled` button drops out of the tab order and announces
    // nothing — the opposite of what a pending action needs to communicate.
    expect(button).not.toBeDisabled();

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not submit its form while pending", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" pending pendingLabel="Submitting…">
          Submit task
        </Button>
      </form>
    );

    await user.click(screen.getByRole("button", { name: "Submitting…" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("uses the native disabled attribute when genuinely unavailable", () => {
    render(<Button disabled>Connect</Button>);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });
});
