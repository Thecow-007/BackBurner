/**
 * The mobile drawer (docs/ui-spec.md §3.14, design 5d) — the sidebar minus the
 * STATUS counts, which already live in the chip rail above the list.
 *
 * Contents in the order the spec fixes: wordmark + connection state → the three
 * nav destinations → LANES with counts → identity chip + `Change key`.
 *
 * It is a modal dialog: it traps focus while open, closes on Escape and on a
 * scrim tap, and returns focus to whatever opened it — the `☰` (ui-spec §4).
 */
import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { Link, useLocation } from "react-router-dom";

import { ConnectionIndicator } from "../components/ConnectionIndicator.js";
import { maskKey } from "../lib/format.js";
import { useActions, useAsOfClock, useAuth, useConnection, useCounts } from "../store/react.js";
import { formatCount, useLaneFilter, Wordmark } from "./Sidebar.js";
import styles from "./MobileDrawer.module.css";

/** Everything focusable the trap has to cycle through. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface MobileDrawerProps {
  open: boolean;
  /** Called by Escape, the scrim, the `✕`, and every destination inside. */
  onClose(): void;
  unreadCount: number;
  onOpenNotifications(): void;
}

export function MobileDrawer({
  open,
  onClose,
  unreadCount,
  onOpenNotifications,
}: MobileDrawerProps): ReactElement | null {
  const connection = useConnection();
  const { label } = useAsOfClock();
  const counts = useCounts();
  const lanes = useLaneFilter();
  const { apiKey } = useAuth();
  const { signOut } = useActions();
  const { pathname } = useLocation();

  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Focus moves into the drawer on open and back to the opener on close. The
  // opener is captured rather than passed in, so the drawer restores focus
  // correctly no matter which control raised it.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      opener?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (panel === null) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;

      const active = document.activeElement;
      if (active === null || !panel.contains(active)) {
        // Focus escaped the panel (a scrim click, say) — pull it back in.
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  const openNotifications = useCallback(() => {
    // The notification centre is an overlay of its own; the drawer gets out of
    // its way rather than stacking two panels over the list.
    onClose();
    onOpenNotifications();
  }, [onClose, onOpenNotifications]);

  const changeKey = useCallback(() => {
    onClose();
    signOut();
  }, [onClose, signOut]);

  if (!open) return null;

  return (
    <>
      {/* aria-hidden + tabIndex -1: the scrim is a convenience tap target, and
          Escape and the ✕ are the keyboard and screen-reader routes out. */}
      <button
        type="button"
        className={styles.scrim}
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className={styles.panel}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
      >
        <div className={styles.head}>
          <div className={styles.headTop}>
            <span className={styles.headMark}>
              <Wordmark size="large" />
            </span>
            <button
              ref={closeRef}
              type="button"
              className={styles.close}
              onClick={onClose}
              aria-label="Close menu"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          <ConnectionIndicator state={connection} asOf={label} />
        </div>

        <nav className={styles.nav} aria-label="Primary">
          <Link
            to="/"
            className={styles.navItem}
            aria-current={pathname === "/" ? "page" : undefined}
            onClick={onClose}
          >
            <span className={styles.navGlyph} aria-hidden="true">
              ▤
            </span>
            <span className={styles.navLabel}>Task register</span>
            {/* What the register currently holds under the active filters —
                the list this link opens (ui-spec §3.10). */}
            <span className={styles.navMeta}>{counts === null ? "—" : counts.matching}</span>
          </Link>

          <Link
            to="/submit"
            className={styles.navItem}
            aria-current={pathname === "/submit" ? "page" : undefined}
            onClick={onClose}
          >
            <span className={styles.navGlyph} aria-hidden="true">
              +
            </span>
            <span className={styles.navLabel}>Submit task</span>
          </Link>

          <button type="button" className={styles.navItem} onClick={openNotifications}>
            <span className={styles.navGlyph} aria-hidden="true">
              ◍
            </span>
            <span className={styles.navLabel}>Notifications</span>
            {unreadCount > 0 ? (
              <span className={styles.badge}>
                {unreadCount}
                <span className="sr-only"> unread</span>
              </span>
            ) : null}
          </button>
        </nav>

        <div className={styles.section}>
          <h2 className={styles.sectionLabel}>Lanes</h2>
          {lanes.lanes.map((lane) => {
            const checked = lanes.active === lane;
            return (
              <button
                key={lane}
                type="button"
                className={styles.laneRow}
                aria-pressed={checked}
                onClick={() => lanes.toggle(lane)}
              >
                <span className={styles.box} data-checked={checked} aria-hidden="true">
                  {checked ? "✓" : ""}
                </span>
                <span className={styles.laneLabel}>{lane}</span>
                <span className={styles.count}>{formatCount(lanes.countFor(lane))}</span>
              </button>
            );
          })}
        </div>

        <div className={styles.foot}>
          <span className={styles.key}>{maskKey(apiKey)}</span>
          <button type="button" className={styles.changeKey} onClick={changeKey}>
            Change key
          </button>
        </div>
      </div>
    </>
  );
}
