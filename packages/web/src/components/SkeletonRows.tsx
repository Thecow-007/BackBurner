/**
 * Loading rows for the register (ui-spec §3.11): shown on the first snapshot
 * and on every filter change.
 *
 * Bars, not a spinner, and at the row height they replace — a spinner says
 * "something is happening"; these say "rows are coming, and this many". The
 * block is `aria-hidden`: it is decoration, and the caller announces the load.
 */
import type { ReactElement } from "react";

import styles from "./SkeletonRows.module.css";

export interface SkeletonRowsProps {
  rows?: number;
  /** Three bars per row for the desktop register, one for mobile cards. */
  bars?: 1 | 3;
}

/** The design's width cycle — varied so the block reads as content rather than
 * as a loader. */
const BAR_WIDTHS = [78, 62, 84, 58, 70, 66, 80] as const;

export function SkeletonRows({ rows = 7, bars = 3 }: SkeletonRowsProps): ReactElement {
  const count = Math.max(0, Math.floor(rows));

  return (
    <div className={styles.skeleton} aria-hidden="true">
      {Array.from({ length: count }, (_unused, index) => {
        const width = BAR_WIDTHS[index % BAR_WIDTHS.length] ?? 70;
        return (
          <div key={index} className={bars === 1 ? styles.card : styles.row}>
            <span className={styles.strong} style={{ width }} />
            {bars === 3 ? (
              <>
                <span className={styles.quiet} style={{ width: width - 18 }} />
                <span className={styles.quiet} style={{ width: 140 - width }} />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
