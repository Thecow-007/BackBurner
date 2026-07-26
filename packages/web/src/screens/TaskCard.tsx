/**
 * The MOBILE task card (design 5c; docs/ui-spec.md §3.4).
 *
 * Line 1 is the handle, the status chip, the collected marker and the seed
 * badge. Line 2 is the note, wrapping, carrying the FULL `error.reason` for
 * failures — a card has the room the 34px desktop row does not, and an error is
 * never truncated (ui-spec §0). The right side holds exactly one action, the
 * primary verb the §3 matrix permits.
 *
 * Live rows keep the blue left rail and the faint wash. That treatment marks
 * "the engine may still act on this" and nothing else; a green rail for `ready`
 * would need a colour the token set does not define, and inventing one would
 * make collect-ness look like a sixth status.
 */
import type { ReactElement } from "react";
import { Link } from "react-router-dom";

import { CollectedMarker } from "../components/CollectedMarker.js";
import { SeedBadge } from "../components/SeedBadge.js";
import { StatusChip } from "../components/StatusChip.js";
import { durationBetween, formatDuration } from "../lib/format.js";
import { allowedActions } from "../lib/matrix.js";
import { durationReadout, isLive, stateNote } from "../lib/status.js";
import type { Task } from "../lib/types.js";
import { ActionButton, type RowAction } from "./TaskRow.js";
import styles from "./TaskCard.module.css";

/**
 * The single inline verb for a card. Where two actions apply — `failed` and
 * uncollected — Retry is the inline one and Collect/acknowledge lives on the
 * detail screen (frontend-brief §4.2), because collecting a failure retires
 * retry for good and that is not a decision to take from a scrolling list.
 */
export function primaryAction(task: Task): RowAction | null {
  const actions = allowedActions(task);
  if (actions.cancel) return "cancel";
  if (actions.retry) return "retry";
  if (actions.collect) return "collect";
  return null;
}

export interface TaskCardProps {
  task: Task;
  /** The card named by `/task/:id`. */
  selected: boolean;
  /** Ticking clock, owned by the register — one ticker for the whole list. */
  now: number;
  onAction(task: Task, action: RowAction): void;
}

export function TaskCard({ task, selected, now, onAction }: TaskCardProps): ReactElement {
  const live = isLive(task);
  const failed = task.status === "failed";
  const action = primaryAction(task);
  const readout = durationReadout(task);

  // An elapsed counter, never a progress bar: the engine cannot know how far
  // through its work a worker is, so the only honest live number is time spent
  // — and it is labelled as such (ui-spec §0, §3.6).
  const elapsed = readout.live
    ? `${formatDuration(durationBetween(readout.since, readout.until, now))} ${readout.label.toLowerCase()}`
    : null;

  const note = failed && task.error ? task.error.reason : stateNote(task);

  const className = [styles.card, live ? styles.live : null, selected ? styles.selected : null]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={className}>
      <div className={styles.main}>
        <div className={styles.identity}>
          {/* By id, never by handle — handles recycle (architecture.md §5). */}
          <Link
            className={styles.handle}
            to={`/task/${task.id}`}
            aria-current={selected ? "true" : undefined}
          >
            {task.handle}
          </Link>
          <StatusChip status={task.status} muted={task.collected} />
          {task.collected ? <CollectedMarker /> : null}
          {task.seeded ? <SeedBadge /> : null}
        </div>

        <p className={styles.note}>
          <span className={styles.meta}>{task.lane}</span>
          {elapsed !== null ? (
            <>
              <span className={styles.sep} aria-hidden="true">
                ·
              </span>
              <span className={styles.elapsed}>{elapsed}</span>
            </>
          ) : null}
          <span className={styles.sep} aria-hidden="true">
            ·
          </span>
          <span className={failed ? styles.reason : styles.stateNote}>{note}</span>
        </p>
      </div>

      {action !== null ? (
        <ActionButton task={task} action={action} size="large" onPress={onAction} />
      ) : null}
    </li>
  );
}
