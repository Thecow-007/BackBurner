/**
 * Browser-local persistence (docs/frontend-brief.md §4.1, §6.3). Three things
 * live in `localStorage`: the API key ("stored only in this browser"), the
 * per-lane remembered `duration_ms` default, and the two dragged pane widths
 * (ADR 0025). Everything is wrapped so a locked-down/private-mode browser
 * (throwing localStorage) degrades to in-memory rather than crashing the app.
 */

const KEY_STORAGE = "backburner.apiKey";
const LANE_DEFAULTS_STORAGE = "backburner.laneDefaults";
const PANE_WIDTH_STORAGE = "backburner.paneWidths";

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // best-effort; a rejecting store just means no persistence this session
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// ── API key ────────────────────────────────────────────────────────────────

export function getStoredKey(): string | null {
  const k = safeGet(KEY_STORAGE);
  return k && k.length > 0 ? k : null;
}

export function setStoredKey(key: string): void {
  safeSet(KEY_STORAGE, key);
}

export function clearStoredKey(): void {
  safeRemove(KEY_STORAGE);
}

// ── Per-lane duration defaults ──────────────────────────────────────────────

export type LaneDefaults = Record<string, number>;

export function getLaneDefaults(): LaneDefaults {
  const raw = safeGet(LANE_DEFAULTS_STORAGE);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: LaneDefaults = {};
    for (const [lane, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isInteger(value) && value > 0) out[lane] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function getLaneDefault(lane: string): number | undefined {
  return getLaneDefaults()[lane];
}

export function setLaneDefault(lane: string, durationMs: number): void {
  const all = getLaneDefaults();
  all[lane] = durationMs;
  safeSet(LANE_DEFAULTS_STORAGE, JSON.stringify(all));
}

// ── Dragged pane widths (ADR 0025) ──────────────────────────────────────────
//
// Only the raw pixel width the user dragged to is stored. The CAPS are not
// enforced here and must not be: the width is spent inside
// `clamp(<min>, var(--pane-w), <max>vw)`, so a width dragged on a 2560px
// monitor cannot swallow a 1280px one — the viewport unit re-clamps it on every
// resize, with no listener and no clamping logic in JS.

export type PaneId = "sidebar" | "detail";

export type PaneWidths = Partial<Record<PaneId, number>>;

export function getPaneWidths(): PaneWidths {
  const raw = safeGet(PANE_WIDTH_STORAGE);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: PaneWidths = {};
    for (const pane of ["sidebar", "detail"] as const) {
      const value = (parsed as Record<string, unknown>)[pane];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        out[pane] = Math.round(value);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function getPaneWidth(pane: PaneId): number | undefined {
  return getPaneWidths()[pane];
}

export function setPaneWidth(pane: PaneId, width: number): void {
  const all = getPaneWidths();
  all[pane] = Math.round(width);
  safeSet(PANE_WIDTH_STORAGE, JSON.stringify(all));
}

/** Double-click on the handle: forget the stored width and fall back to the
 * token default, rather than writing the default in as if it were a choice. */
export function clearPaneWidth(pane: PaneId): void {
  const all = getPaneWidths();
  delete all[pane];
  if (Object.keys(all).length === 0) safeRemove(PANE_WIDTH_STORAGE);
  else safeSet(PANE_WIDTH_STORAGE, JSON.stringify(all));
}
