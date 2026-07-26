/**
 * The connection indicator (docs/ui-spec.md §3.9) — the interface being honest
 * about whether what you are looking at is current.
 *
 * The store carries four connection states and the design draws three:
 * `connecting` (the first subscribe) wears the `reconnecting` treatment with
 * its own word, because to the reader both mean "not live yet". `stale` is
 * deliberately the loudest thing in the sidebar — it is the interface admitting
 * the view may be wrong, so it gets the solid ember fill and the fastest pulse.
 *
 * `asOf` is a human wall clock, NOT the event cursor (ui-spec §3.9), and it is
 * rendered exactly as the caller formatted it.
 */
import type { ReactElement } from "react";

import type { ConnectionState } from "../lib/types.js";
import styles from "./ConnectionIndicator.module.css";

export interface ConnectionIndicatorProps {
  state: ConnectionState;
  /** Human wall clock, e.g. "15:07:42" — already formatted by the caller. */
  asOf: string;
  /** `sidebar` is the default block; `bar` is the mobile full-width variant
   *  that sits directly under the header. */
  variant?: "sidebar" | "bar";
}

/** Copy is verbatim from the design; only `live` interpolates the clock. */
const HEADLINE: Record<Exclude<ConnectionState, "live">, string> = {
  connecting: "CONNECTING…",
  reconnecting: "RECONNECTING…",
  stale: "RECONNECTING",
};

/** The second line exists for `stale` alone — the state that has to say why. */
const STALE_DETAIL = "DATA MAY BE BEHIND · RESYNC RUNNING";

export function ConnectionIndicator({
  state,
  asOf,
  variant = "sidebar",
}: ConnectionIndicatorProps): ReactElement {
  const className = [styles.root, styles[state], variant === "bar" ? styles.bar : undefined]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      // The indicator announces its own changes (ui-spec §4). Polite, not
      // assertive: losing the stream must not interrupt what the user is doing.
      role="status"
      aria-live="polite"
      data-state={state}
      data-variant={variant}
    >
      <span className={styles.line}>
        <span className={styles.dot} aria-hidden="true" />
        {state === "live" ? `LIVE · as of ${asOf}` : HEADLINE[state]}
      </span>
      {state === "stale" ? <span className={styles.detail}>{STALE_DETAIL}</span> : null}
    </div>
  );
}
