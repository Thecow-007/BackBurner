/**
 * Browser-local persistence (docs/frontend-brief.md §4.1, §6.3). Two things
 * live in `localStorage`: the API key ("stored only in this browser") and the
 * per-lane remembered `duration_ms` default. Everything is wrapped so a
 * locked-down/private-mode browser (throwing localStorage) degrades to
 * in-memory rather than crashing the app.
 */

const KEY_STORAGE = "backburner.apiKey";
const LANE_DEFAULTS_STORAGE = "backburner.laneDefaults";

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
