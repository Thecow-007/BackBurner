/**
 * The one-pane status rail (docs/ui-spec.md §3.10, design 5c): the sidebar's
 * STATUS counts, kept alive above the list when the sidebar has become a
 * drawer. Same model, same numbers, same filter behaviour — it shares
 * `useStatusFilter` with the sidebar so the two can never disagree.
 *
 * Counts are `null` until the first snapshot lands and render an em dash then;
 * a number derived from the loaded rows would be invented state.
 */
import type { CSSProperties, ReactElement } from "react";

import { STATUS_ORDER, statusPresentation } from "../lib/status.js";
import { formatCount, useStatusFilter } from "./Sidebar.js";
import styles from "./StatusRail.module.css";

export interface StatusRailProps {
  /** The shell's layout hook (it hides the rail at two panes and above). */
  className?: string;
}

export function StatusRail({ className }: StatusRailProps): ReactElement {
  const status = useStatusFilter();

  return (
    <div className={[styles.root, className].filter(Boolean).join(" ")}>
      <div className={styles.scroller} role="group" aria-label="Filter by status">
        <button
          type="button"
          className={styles.chip}
          aria-pressed={status.active === undefined}
          onClick={() => status.select(undefined)}
        >
          all
          <span className={styles.count}>{formatCount(status.total)}</span>
        </button>

        {STATUS_ORDER.map((value) => {
          const presentation = statusPresentation(value);
          return (
            <button
              key={value}
              type="button"
              className={styles.chip}
              aria-pressed={status.active === value}
              onClick={() => status.select(status.active === value ? undefined : value)}
            >
              <span
                className={styles.glyph}
                style={{ "--row-ink": presentation.color } as CSSProperties}
                aria-hidden="true"
              >
                {presentation.glyph}
              </span>
              {presentation.label}
              <span className={styles.count}>{formatCount(status.countFor(value))}</span>
            </button>
          );
        })}
      </div>
      <span className={styles.fade} aria-hidden="true" />
    </div>
  );
}
