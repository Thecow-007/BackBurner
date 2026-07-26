/**
 * The status chip (docs/ui-spec.md §3.1) — five variants and no more. The
 * status word always sits INSIDE the chip, verbatim from the API, behind a
 * leading glyph, so status is never carried by colour alone (ui-spec §4).
 *
 * There is no sixth status: a collected task keeps its own chip at `.72`
 * opacity (`muted`) and gains <CollectedMarker /> beside it (ui-spec §3.1).
 */
import type { CSSProperties, ReactElement } from "react";

import { statusPresentation } from "../lib/status.js";
import type { TaskStatus } from "../lib/types.js";
import styles from "./StatusChip.module.css";

export interface StatusChipProps {
  status: TaskStatus;
  /** Collected and terminal chips render at .72 opacity (ui-spec §3.1). */
  muted?: boolean;
  /** `row` is the 11px register/card chip; `detail` is the header chip. */
  size?: "row" | "detail";
}

export function StatusChip({ status, muted = false, size = "row" }: StatusChipProps): ReactElement {
  const presentation = statusPresentation(status);

  // Colour comes from `lib/status.ts`, which yields `var(--token)` references —
  // so the stylesheet needs no per-status rule and no component ever composes
  // (or literals) a colour. Names are chip-local; they shadow nothing in
  // tokens.css.
  const recipe = {
    "--chip-fill": presentation.chipBg,
    "--chip-line": presentation.chipBorder,
    "--chip-ink": presentation.chipText,
  } as CSSProperties;

  const className = [
    styles.chip,
    styles[size],
    // `animated` is true for running and running alone — the single solid-fill,
    // 700-weight, pulsing variant (ui-spec §1.3). Reading the flag rather than
    // the status keeps the "one place decides how a status looks" rule intact.
    presentation.animated ? styles.solid : undefined,
    muted ? styles.muted : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={className} style={recipe} data-status={presentation.status}>
      <span className={styles.glyph} aria-hidden="true">
        {presentation.glyph}
      </span>
      {presentation.label}
    </span>
  );
}
