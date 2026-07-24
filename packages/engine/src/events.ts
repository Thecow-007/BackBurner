/**
 * In-process event bus + SSE payload construction + subscribe() replay.
 * docs/architecture.md §11 (subscription ordering), docs/api-contract.md §8
 * (event payload shapes). `subscribe` attaches the live listener BEFORE
 * running the replay query, so nothing committed in between is lost; live
 * events are deduplicated against the replay by id.
 */
import type { Queryable } from "./transitions.js";
import type { TaskRow, TransitionRow } from "./types.js";
import { deriveHandle, toIso } from "./serialize.js";

export interface LiveEvent {
  id: number;
  userId: string;
  event: Record<string, unknown>;
}

type Listener = (evt: LiveEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  subscribeRaw(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  publish(evt: LiveEvent): void {
    for (const listener of this.listeners) listener(evt);
  }
}

/** Build the SSE `data:` payload for a just-written transition row. */
export function buildEventPayload(transition: TransitionRow, taskRow: TaskRow): Record<string, unknown> {
  return {
    type: transition.event_type,
    handle: deriveHandle(taskRow.lane, taskRow.handle_num),
    lane: taskRow.lane,
    task_id: transition.task_id,
    at: toIso(transition.at),
    ...transition.meta,
  };
}

export function transitionEventId(transition: TransitionRow): number {
  return Number(transition.id);
}

/**
 * Replay query — excludes transitions belonging to seeded tasks (they are
 * historical; a live/`?since=0` stream must never resurrect them).
 */
async function replayTransitions(
  client: Queryable,
  userId: string,
  sinceId: number
): Promise<Array<{ id: number; event: Record<string, unknown> }>> {
  const { rows } = await client.query<TransitionRow & { lane: string; handle_num: number }>(
    `SELECT tt.*, t.lane AS lane, t.handle_num AS handle_num
       FROM task_transitions tt
       JOIN tasks t ON t.id = tt.task_id
      WHERE tt.user_id = $1 AND tt.id > $2 AND t.seeded = false
      ORDER BY tt.id`,
    [userId, sinceId]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    event: buildEventPayload(row, { lane: row.lane, handle_num: row.handle_num } as TaskRow),
  }));
}

/**
 * Create the `subscribe(userId, sinceId?)` async iterable per architecture
 * §11's ordering contract. `client` is a long-lived Queryable (the pool)
 * used only for the one-shot replay query.
 */
export function createSubscription(
  bus: EventBus,
  client: Queryable,
  userId: string,
  sinceId = 0
): AsyncIterable<{ id: number; event: Record<string, unknown> }> {
  async function* generator(): AsyncGenerator<{ id: number; event: Record<string, unknown> }> {
    const queue: LiveEvent[] = [];
    let wake: (() => void) | null = null;

    const unsubscribe = bus.subscribeRaw((evt) => {
      if (evt.userId !== userId) return;
      queue.push(evt);
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    });

    try {
      const replay = await replayTransitions(client, userId, sinceId);
      let maxDelivered = sinceId;
      for (const item of replay) {
        maxDelivered = item.id;
        yield item;
      }

      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) break;
          if (next.id <= maxDelivered) continue;
          maxDelivered = next.id;
          yield { id: next.id, event: next.event };
        }
      }
    } finally {
      unsubscribe();
    }
  }

  return { [Symbol.asyncIterator]: generator };
}

export async function latestEventId(client: Queryable, userId: string): Promise<number> {
  const { rows } = await client.query<{ as_of: string }>(
    `SELECT COALESCE(MAX(id), 0)::text AS as_of FROM task_transitions WHERE user_id = $1`,
    [userId]
  );
  return Number(rows[0]?.as_of ?? 0);
}
