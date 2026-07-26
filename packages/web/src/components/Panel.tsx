/**
 * The panel primitive: a bordered surface with an optional micro-label header
 * (ui-spec §3.11, §3.12).
 *
 * The `error` tone is the red-railed treatment shared by the "Snapshot failed"
 * panel and the verbatim error block. It exists so a failure is always rendered
 * as something — a rail, a label and the envelope's own words — because a blank
 * pane tells the operator nothing about the system's state.
 */
import type { ReactElement, ReactNode } from "react";

import styles from "./Panel.module.css";

export interface PanelProps {
  /** Micro-label on the panel's header line (uppercase mono hairline). */
  label?: ReactNode;
  /** Right-aligned header content, e.g. a copy affordance or a retryable flag. */
  headerRight?: ReactNode;
  /** `error` is the red-railed variant used by the snapshot-failed and error panels. */
  tone?: "default" | "error";
  children: ReactNode;
  className?: string;
}

export function Panel({
  label,
  headerRight,
  tone = "default",
  children,
  className,
}: PanelProps): ReactElement {
  const hasHeader = label !== undefined || headerRight !== undefined;
  const classes = [styles.panel, tone === "error" ? styles.error : null, className]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={classes}>
      {hasHeader ? (
        <div className={styles.header}>
          <span className={styles.label}>{label}</span>
          {headerRight !== undefined ? (
            <span className={styles.headerRight}>{headerRight}</span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.body}>{children}</div>
    </section>
  );
}
