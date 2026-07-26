/**
 * A mono JSON block with a micro-label and a copy affordance (ui-spec §3.12).
 *
 * Params are always shown, results only once collected, and error bodies are
 * never truncated at any width — `wrap` switches the block from scrolling to
 * wrapping and disables collapsing entirely, because a half-shown failure is
 * worse than no panel at all.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import { prettyJson } from "../lib/format.js";
import styles from "./JsonPanel.module.css";

export interface JsonPanelProps {
  /** e.g. "PARAMS", "RESULT". Rendered as the micro-label. */
  label: string;
  value: unknown;
  /** Collapsed past ~14 lines with a "show all" affordance when true. */
  collapsible?: boolean;
  /** Error bodies wrap instead of scrolling, and are NEVER truncated. */
  wrap?: boolean;
}

const COLLAPSE_AFTER_LINES = 14;
const CONFIRM_MS = 1500;

type CopyState = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = {
  idle: "copy JSON",
  copied: "copied",
  // A dead button is not honest either: if the clipboard write was refused
  // (insecure context, denied permission) the affordance says so.
  failed: "copy failed",
};

export function JsonPanel({
  label,
  value,
  collapsible = false,
  wrap = false,
}: JsonPanelProps): ReactElement {
  const text = prettyJson(value);
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const confirmTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    },
    []
  );

  function flash(state: CopyState): void {
    setCopyState(state);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setCopyState("idle"), CONFIRM_MS);
  }

  function copy(): void {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      flash("failed");
      return;
    }
    // Always the full payload, never the collapsed view — the clipboard gets
    // what the API returned.
    clipboard.writeText(text).then(
      () => flash("copied"),
      () => flash("failed")
    );
  }

  const lines = text.split("\n");
  const canCollapse = collapsible && !wrap && lines.length > COLLAPSE_AFTER_LINES;
  const collapsed = canCollapse && !expanded;
  const shown = collapsed ? lines.slice(0, COLLAPSE_AFTER_LINES).join("\n") : text;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.label}>{label}</span>
        <button type="button" className={styles.copy} onClick={copy} aria-live="polite">
          {COPY_LABEL[copyState]}
        </button>
      </div>
      <pre
        className={[styles.block, wrap ? styles.wrapBlock : null].filter(Boolean).join(" ")}
        // A scrollable region needs to be reachable by keyboard; a wrapping one
        // does not scroll, so it stays out of the tab order.
        tabIndex={wrap ? undefined : 0}
        aria-label={wrap ? undefined : label}
      >
        {shown}
      </pre>
      {canCollapse ? (
        <button type="button" className={styles.toggle} onClick={() => setExpanded(!expanded)}>
          {expanded ? "show less" : `show all ${lines.length} lines`}
        </button>
      ) : null}
    </div>
  );
}
