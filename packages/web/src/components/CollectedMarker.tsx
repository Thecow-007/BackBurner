/**
 * The collected marker (docs/ui-spec.md §3.2). The word is NEVER abbreviated:
 * collected-vs-uncollected *is* the handle-lease concept, which is the core
 * idea of this product.
 *
 * It is not a status — it sits beside the status chip, in the NOTE cell on
 * desktop rows, and in the chip line on mobile cards. Those three placements
 * are why the caller may pass a `className`; the marker owns its own type and
 * rule and nothing else.
 */
import type { ReactElement } from "react";

import styles from "./CollectedMarker.module.css";

export interface CollectedMarkerProps {
  className?: string;
}

export function CollectedMarker({ className }: CollectedMarkerProps): ReactElement {
  return <span className={[styles.marker, className].filter(Boolean).join(" ")}>collected</span>;
}
