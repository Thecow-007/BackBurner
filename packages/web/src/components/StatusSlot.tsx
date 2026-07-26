/**
 * The duration slot (ui-spec §3.6): a number in the status colour, a changing
 * label under it, the state note beneath, and the action bar beside it.
 *
 * Every one of the seven states — queued, running, ready, ready·collected,
 * failed, failed·collected, cancelled — is derived by `durationReadout()` and
 * `stateNote()`, so this component holds no `switch (status)` of its own
 * (ui-spec §5). The counter is elapsed time and is always labelled as elapsed;
 * it is never a progress indicator, because the engine cannot know how far a
 * worker has got.
 */
import type { ReactElement, ReactNode } from "react";

import { durationBetween, formatDuration, formatElapsedClock } from "../lib/format.js";
import { durationReadout, stateNote, statusPresentation } from "../lib/status.js";
import type { Task } from "../lib/types.js";
import { useNow } from "../store/react.js";
import styles from "./StatusSlot.module.css";

export interface StatusSlotProps {
  task: Task;
  /** The `collected` transition's timestamp, passed by the detail screen when
   *  history is loaded. Omitted elsewhere — the note drops the clause rather
   *  than inventing a time. */
  collectedAt?: string;
  /** The action bar. When the task is terminal the slot renders the terminal
   *  note from `durationReadout()` instead, and ignores this. */
  actions?: ReactNode;
}

export function StatusSlot({ task, collectedAt, actions }: StatusSlotProps): ReactElement {
  const readout = durationReadout(task);
  const presentation = statusPresentation(task.status);
  // Ticks once a second only while the readout is live. `useNow` is a pure
  // timer that reads no store state and issues no requests — the client is
  // re-rendering a number it can already compute (frontend-brief §5 rule 4).
  const now = useNow(readout.live);
  const elapsed = durationBetween(readout.since, readout.until, now);
  // A ticking counter reads as a clock and must not change shape as it crosses
  // a minute (`0:14 WAITING`, `5:20 ELAPSED`); a finished duration reads as a
  // measurement and earns its tenth of a second (`9.8s TOTAL`). The design
  // draws both, and the difference is the point.
  const value = readout.live ? formatElapsedClock(elapsed) : formatDuration(elapsed);
  const note = stateNote(task, collectedAt);

  return (
    <div className={styles.slot}>
      <div className={styles.row}>
        <div className={styles.readout}>
          <span
            className={[styles.value, readout.muted ? styles.muted : null].filter(Boolean).join(" ")}
            style={{ color: presentation.color }}
          >
            {value}
          </span>
          <span className={styles.label}>{readout.label}</span>
        </div>
        <div className={styles.actions}>
          {readout.terminalNote !== null ? (
            <span className={styles.terminal}>{readout.terminalNote}</span>
          ) : (
            actions
          )}
        </div>
      </div>
      {note ? <p className={styles.note}>{note}</p> : null}
    </div>
  );
}
