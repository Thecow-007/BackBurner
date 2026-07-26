/**
 * The empty, resting and no-match states (ui-spec §3.11).
 *
 * These are real code paths, not nice-to-haves — a new key sees the first one
 * before it sees anything else.
 */
import type { ReactElement, ReactNode } from "react";

import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
  heading: string;
  body?: ReactNode;
  action?: ReactNode;
  /** The resting detail pane uses a dim ember bar glyph. */
  glyph?: "ember-bar" | "none";
}

export function EmptyState({ heading, body, action, glyph = "none" }: EmptyStateProps): ReactElement {
  // The glyph is what distinguishes the resting pane from an empty list, and
  // the resting pane speaks in prose rather than a headline, so it also selects
  // the quieter type register.
  const resting = glyph === "ember-bar";

  return (
    <div className={styles.empty}>
      {resting ? <span className={styles.emberBar} aria-hidden="true" /> : null}
      <p className={resting ? styles.resting : styles.heading}>{heading}</p>
      {body !== undefined ? <div className={styles.body}>{body}</div> : null}
      {action !== undefined ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
