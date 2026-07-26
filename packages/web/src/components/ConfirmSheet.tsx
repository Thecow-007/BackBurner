/**
 * The MOBILE bottom sheet (docs/ui-spec.md §3.8). Every action initiated from
 * the list view confirms here first — collect, cancel and retry alike — so a
 * thumb never fires a mutation mid-scroll.
 *
 * The trap is implemented by hand rather than through `<dialog>.showModal()`:
 * the native modal's focus, scrim and Escape behaviour still differ enough
 * between engines that "traps focus, restores it, closes on Escape" (ui-spec
 * §4) would mean something slightly different per browser. `confirm()` is
 * likewise never used — it cannot carry a mono handle or the button copy.
 */
import { useEffect, useId, useRef, type MouseEvent, type ReactElement } from "react";

import { Button } from "./Button.js";
import type { ConfirmCardProps } from "./ConfirmCard.js";
import styles from "./ConfirmSheet.module.css";

export interface ConfirmSheetProps extends ConfirmCardProps {
  open: boolean;
}

/* Pending buttons wear aria-disabled, not the native attribute, so they stay in
 * this list on purpose — a control the user is waiting on must remain reachable
 * (ui-spec §3.7). */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

export function ConfirmSheet({
  open,
  question,
  confirmLabel,
  dismissLabel,
  confirmVariant = "danger",
  onConfirm,
  onDismiss,
}: ConfirmSheetProps): ReactElement | null {
  const questionId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);

  // Move focus in on open, hand it back on close. An overlay that strands focus
  // behind its own scrim is worse than no overlay at all.
  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The dismiss button is first in the DOM, so the least destructive choice
    // is the one already under the cursor when the sheet arrives.
    focusableWithin(sheetRef.current)[0]?.focus();
    return () => {
      restore?.focus();
    };
  }, [open]);

  // Escape closes; Tab cycles inside. Bound on the document in the capture
  // phase so the trap holds even if focus was moved out from under us.
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== "Tab") return;

      const sheet = sheetRef.current;
      const items = focusableWithin(sheet);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }

      const active = document.activeElement;
      const outside = !sheet?.contains(active);
      if (event.shiftKey && (outside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, onDismiss]);

  function handleScrimClick(event: MouseEvent<HTMLDivElement>): void {
    // Only the scrim itself dismisses — a click that landed on the sheet and
    // bubbled up must not.
    if (event.target === event.currentTarget) onDismiss();
  }

  if (!open) return null;

  return (
    <div className={styles.scrim} onClick={handleScrimClick}>
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={questionId}
      >
        <div className={styles.grab} aria-hidden="true" />
        <p className={styles.question} id={questionId}>
          {question}
        </p>
        {/* Dismiss left, confirm right — a thumb travelling back up the screen
         * meets the safe choice first. */}
        <div className={styles.actions}>
          {/* Bordered here, unlike the card's borderless dismiss — the design
              gives the sheet's two 48px targets equal footprint so a thumb can
              find either, while colour still marks which one is destructive. */}
          <Button size="large" variant="secondary" onClick={onDismiss}>
            {dismissLabel}
          </Button>
          <Button size="large" variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
