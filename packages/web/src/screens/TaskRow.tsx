/**
 * The DESKTOP register row (docs/ui-spec.md §2, §3.4).
 *
 * The row is a grid whose columns are declared once, on the register, as
 * `--register-tracks` — the header and every row read the same custom property,
 * so "header and rows share identical tracks and gap" (ui-spec §2) is enforced
 * by construction rather than by two lists that can drift apart. How many
 * tracks there are depends on how wide the register PANE is, not on how wide
 * the window is (ui-spec §2, ADR 0024); this file never asks.
 *
 * Navigation is by IMMUTABLE ID: the row links to `/task/{task.id}`, never to
 * `/task/{handle}`. Handles recycle, so a link keyed by handle would silently
 * come to mean a different task later (docs/architecture.md handle allocation).
 */
import { useEffect, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";

import { Button, type ButtonVariant } from "../components/Button.js";
import { CollectedMarker } from "../components/CollectedMarker.js";
import { SeedBadge } from "../components/SeedBadge.js";
import { StatusChip } from "../components/StatusChip.js";
import { formatAttempts, formatRelative } from "../lib/format.js";
import { allowedActions } from "../lib/matrix.js";
import { isLive, stateNote } from "../lib/status.js";
import type { Task } from "../lib/types.js";
import { useIsPending } from "../store/react.js";
import styles from "./TaskRow.module.css";

/** The three mutating verbs a list item can offer (frontend-brief §3). */
export type RowAction = "cancel" | "retry" | "collect";

/** Milliseconds of silence after which a pending control admits it is waiting
 * (ui-spec §3.7). The store starts its own resync on the same threshold. */
const PENDING_ESCALATION_MS = 10_000;

interface ActionPresentation {
  label: string;
  pendingLabel: string;
  variant: ButtonVariant;
}

/**
 * Label and colour for a verb. Collect is the one action whose presentation
 * depends on the status it acts on: collecting a `ready` result is the happy
 * path and carries the green recipe, while collecting a `failed` task is an
 * acknowledgement — it archives the error and retires retry, so it is
 * deliberately the quieter of the two choices (ui-spec §1.1, §3.8).
 */
function actionPresentation(task: Task, action: RowAction): ActionPresentation {
  switch (action) {
    case "cancel":
      return { label: "Cancel", pendingLabel: "Cancelling…", variant: "secondary" };
    case "retry":
      return { label: "Retry", pendingLabel: "Retrying…", variant: "danger" };
    case "collect":
      return task.status === "failed"
        ? { label: "Collect / acknowledge", pendingLabel: "Collecting…", variant: "secondary" }
        : { label: "Collect", pendingLabel: "Collecting…", variant: "collect" };
  }
}

export interface ActionButtonProps {
  task: Task;
  action: RowAction;
  /** `large` clears the 44px touch minimum for mobile cards and sheets. */
  size?: "default" | "large";
  className?: string;
  /** The list never mutates directly — it asks its owner to confirm first. */
  onPress(task: Task, action: RowAction): void;
}

/**
 * A single row/card action. Shared by the desktop row and the mobile card so
 * the pending discipline is written once: the control goes pending on press and
 * stays pending until the CONFIRMING EVENT lands (not until the HTTP response
 * returns), and pending is a text change, never a spinner (ui-spec §3.7).
 */
export function ActionButton({
  task,
  action,
  size = "default",
  className,
  onPress,
}: ActionButtonProps): ReactElement {
  const pending = useIsPending(task.id, action);
  const [silent, setSilent] = useState(false);
  const presentation = actionPresentation(task, action);

  useEffect(() => {
    if (!pending) {
      setSilent(false);
      return;
    }
    const timer = setTimeout(() => setSilent(true), PENDING_ESCALATION_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  return (
    <Button
      variant={presentation.variant}
      size={size}
      className={className}
      pending={pending}
      pendingLabel={silent ? "Waiting for confirmation…" : presentation.pendingLabel}
      onClick={() => onPress(task, action)}
    >
      {presentation.label}
    </Button>
  );
}

export interface TaskRowProps {
  task: Task;
  /** The row named by `/task/:id`, given the selected treatment. */
  selected: boolean;
  /** Ticking clock for relative timestamps; owned by the register. */
  now: number;
  onAction(task: Task, action: RowAction): void;
}

export function TaskRow({ task, selected, now, onAction }: TaskRowProps): ReactElement {
  const live = isLive(task);
  const failed = task.status === "failed";
  const actions = allowedActions(task);

  // The NOTE cell carries the error for failed rows and the state note
  // otherwise (ui-spec §3.4). Only the FIRST LINE is rendered at 34px — the
  // full text travels in `title` and is shown untruncated on the detail screen
  // and on the mobile card, so nothing is ever lost, only deferred.
  const full = failed && task.error ? task.error.reason : stateNote(task);
  const firstLine = full.split("\n")[0] ?? full;

  const className = [styles.row, live ? styles.live : null, selected ? styles.selected : null]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={className}>
      {/* Gutter: a 3px rail on live rows only. Decorative — `live` is already
       * carried by the status word inside the chip. */}
      <span className={styles.gutter} aria-hidden="true" />

      <span className={styles.handleCell}>
        {/* The link stretches over the whole row via ::after, which keeps one
         * link per row while leaving the action buttons real buttons rather
         * than interactive content nested inside an anchor. */}
        <Link
          className={styles.link}
          to={`/task/${task.id}`}
          aria-current={selected ? "true" : undefined}
        >
          {task.handle}
        </Link>
        {task.seeded ? <SeedBadge /> : null}
      </span>

      <span className={styles.statusCell}>
        <StatusChip status={task.status} muted={task.collected} />
      </span>

      <span className={styles.laneCell}>{task.lane}</span>

      <span className={styles.attemptsCell}>
        {formatAttempts(task.attempts, task.max_attempts, task.status)}
      </span>

      <span className={styles.createdCell} title={task.created_at}>
        {formatRelative(task.created_at, now)}
      </span>

      {/* The collected chip is a child of this cell but not always drawn inside
       * it: where the register is wide enough the cell becomes `display:
       * contents` and the chip takes its own COLLECTED column, leaving the note
       * text as the last cell. One element, two possible columns, no duplicated
       * markup (ui-spec §2, §3.2). The tooltip therefore belongs to the text
       * span rather than to the wrapper, which has no box in that mode. */}
      <span className={styles.noteCell}>
        {task.collected ? <CollectedMarker className={styles.collectedCell} /> : null}
        <span className={failed ? styles.noteError : styles.note} title={full}>
          {firstLine}
        </span>
      </span>

      {/* No ACTION column at three panes — the detail pane is always present
       * (ui-spec §2). The stylesheet removes this group entirely above 1280px
       * so it leaves the tab order too; below that it is revealed on hover AND
       * on keyboard focus. */}
      {actions.cancel || actions.retry || actions.collect ? (
        <span className={styles.actions}>
          {actions.cancel ? (
            <ActionButton task={task} action="cancel" onPress={onAction} />
          ) : null}
          {actions.retry ? <ActionButton task={task} action="retry" onPress={onAction} /> : null}
          {actions.collect ? (
            <ActionButton task={task} action="collect" onPress={onAction} />
          ) : null}
        </span>
      ) : null}
    </li>
  );
}
