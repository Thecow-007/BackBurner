/**
 * The React binding is the only bridge between the vanilla store and the
 * component tree, and two of its behaviours are easy to get subtly wrong in
 * ways no screen would reveal until a demo: a toast that fires twice after a
 * reconnect, and an "as of" clock that keeps ticking after the stream drops.
 * Both would be the interface lying about how current it is.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "zustand/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationNotice } from "../src/lib/types.js";
import type { BackburnerStore } from "../src/store/store.js";
import { StoreProvider, useAsOfClock, useToastQueue, useUnreadCount } from "../src/store/react.js";

/** A store stub: only the slices these hooks read, plus a setter for tests. */
function makeStore(notifications: NotificationNotice[] = [], connection: BackburnerStore["connection"] = "live") {
  return createStore<BackburnerStore>(() => ({ notifications, connection }) as unknown as BackburnerStore);
}

function notice(over: Partial<NotificationNotice> & Pick<NotificationNotice, "eventId">): NotificationNotice {
  return {
    taskId: `task-${over.eventId}`,
    handle: "scrape-1",
    lane: "scrape",
    kind: "ready",
    detail: "finished in 9.8s",
    at: "2026-07-26T12:00:00.000Z",
    read: false,
    ...over,
  };
}

describe("useToastQueue", () => {
  function Harness(): React.ReactElement {
    const { pending, markShown } = useToastQueue();
    return (
      <div>
        <span data-testid="count">{pending.length}</span>
        {pending.map((n) => (
          <button key={n.eventId} type="button" onClick={() => markShown(n.eventId)}>
            {`dismiss-${n.eventId}`}
          </button>
        ))}
      </div>
    );
  }

  it("surfaces each notice once and never again after it is shown", async () => {
    const user = userEvent.setup();
    const store = makeStore([notice({ eventId: 4132 }), notice({ eventId: 4133 })]);

    render(
      <StoreProvider store={store} autoBootstrap={false}>
        <Harness />
      </StoreProvider>
    );
    expect(screen.getByTestId("count")).toHaveTextContent("2");

    await user.click(screen.getByText("dismiss-4132"));
    expect(screen.getByTestId("count")).toHaveTextContent("1");

    // A reconnect replays the same events; the store dedupes by id, and so does
    // this queue — the dismissed notice must not come back as a fresh toast.
    act(() => {
      store.setState({ notifications: [notice({ eventId: 4133 }), notice({ eventId: 4132 })] });
    });
    expect(screen.getByTestId("count")).toHaveTextContent("1");
    expect(screen.queryByText("dismiss-4132")).not.toBeInTheDocument();
  });

  it("still surfaces genuinely new notices after a replay", () => {
    const store = makeStore([notice({ eventId: 4132 })]);
    render(
      <StoreProvider store={store} autoBootstrap={false}>
        <Harness />
      </StoreProvider>
    );
    act(() => {
      store.setState({ notifications: [notice({ eventId: 4140 }), notice({ eventId: 4132 })] });
    });
    expect(screen.getByTestId("count")).toHaveTextContent("2");
  });
});

describe("useAsOfClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function Clock(): React.ReactElement {
    const { label, live } = useAsOfClock();
    return <span data-testid="clock">{`${label} ${live ? "live" : "frozen"}`}</span>;
  }

  it("ticks while the stream is healthy", () => {
    vi.setSystemTime(new Date("2026-07-26T15:07:42.000Z"));
    const store = makeStore([], "live");

    render(
      <StoreProvider store={store} autoBootstrap={false}>
        <Clock />
      </StoreProvider>
    );
    const first = screen.getByTestId("clock").textContent;

    act(() => {
      vi.setSystemTime(new Date("2026-07-26T15:07:45.000Z"));
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId("clock").textContent).not.toBe(first);
    expect(screen.getByTestId("clock")).toHaveTextContent("live");
  });

  it("FREEZES at the last vouched-for instant when the stream drops", () => {
    vi.setSystemTime(new Date("2026-07-26T15:07:42.000Z"));
    const store = makeStore([], "live");

    render(
      <StoreProvider store={store} autoBootstrap={false}>
        <Clock />
      </StoreProvider>
    );

    act(() => {
      store.setState({ connection: "reconnecting" });
    });
    const frozen = screen.getByTestId("clock").textContent;
    expect(frozen).toContain("frozen");

    // Time passes with no stream. The clock must NOT advance — it would be
    // claiming the view is current when nothing has confirmed that.
    act(() => {
      vi.setSystemTime(new Date("2026-07-26T15:09:00.000Z"));
      vi.advanceTimersByTime(78_000);
    });
    expect(screen.getByTestId("clock").textContent).toBe(frozen);
  });
});

describe("useUnreadCount", () => {
  it("counts only unread notices", () => {
    const store = makeStore([
      notice({ eventId: 1, read: false }),
      notice({ eventId: 2, read: true }),
      notice({ eventId: 3, read: false }),
    ]);

    function Badge(): React.ReactElement {
      return <span data-testid="unread">{useUnreadCount()}</span>;
    }

    render(
      <StoreProvider store={store} autoBootstrap={false}>
        <Badge />
      </StoreProvider>
    );
    expect(screen.getByTestId("unread")).toHaveTextContent("2");
  });
});
