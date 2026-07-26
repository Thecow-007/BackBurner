/**
 * The seed badge (docs/ui-spec.md §3.3). Marks a task that came from
 * `npm run seed` rather than from real work.
 *
 * Quiet by design: it is provenance, not a warning, so it borrows no status
 * colour and no ember. `className` exists because it is placed by its caller —
 * beside the handle on desktop rows, on the card's chip line on mobile.
 */
import type { ReactElement } from "react";

import styles from "./SeedBadge.module.css";

export interface SeedBadgeProps {
  className?: string;
}

export function SeedBadge({ className }: SeedBadgeProps): ReactElement {
  return <span className={[styles.badge, className].filter(Boolean).join(" ")}>seed</span>;
}
