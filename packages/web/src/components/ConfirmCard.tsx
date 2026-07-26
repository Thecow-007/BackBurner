/**
 * The DESKTOP inline confirm (docs/ui-spec.md §3.8). It renders inside the
 * panel whose action it guards rather than over it, so the task the question
 * names stays in view while the operator decides. The mobile equivalent is
 * `ConfirmSheet`.
 *
 * `question` is a node rather than a string because the copy always names the
 * task and the handle inside it is mono — the caller composes it.
 */
import { useId, type ReactElement, type ReactNode } from "react";

import { Button, type ButtonVariant } from "./Button.js";
import styles from "./ConfirmCard.module.css";

export interface ConfirmCardProps {
  /** The caller composes this, rendering the handle in mono. */
  question: ReactNode;
  confirmLabel: string;
  dismissLabel: string;
  confirmVariant?: ButtonVariant;
  onConfirm(): void;
  onDismiss(): void;
}

export function ConfirmCard({
  question,
  confirmLabel,
  dismissLabel,
  confirmVariant = "danger",
  onConfirm,
  onDismiss,
}: ConfirmCardProps): ReactElement {
  const questionId = useId();

  return (
    <div className={styles.card} role="group" aria-labelledby={questionId}>
      <p className={styles.question} id={questionId}>
        {question}
      </p>
      {/* Dismiss left, confirm right — the destructive choice is never the one
       * a returning thumb or an Enter key lands on first. */}
      <div className={styles.actions}>
        <Button variant="quiet" onClick={onDismiss}>
          {dismissLabel}
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
