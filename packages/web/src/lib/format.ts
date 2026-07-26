/**
 * Presentational formatting. Pure functions, no clock of their own — callers
 * pass `now` so components can tick and tests can be deterministic.
 *
 * Every number these produce is derived from a value the API supplied. Nothing
 * here rounds a duration the engine did not report or implies progress the
 * engine cannot know (docs/ui-spec.md §0).
 */

/**
 * A duration, in the design's register: sub-minute reads `9.8s`, a minute or
 * more reads `M:SS`, an hour or more reads `H:MM:SS`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * A LIVE duration — always `M:SS`, even below a minute (`0:14`).
 *
 * The design draws these two forms differently on purpose, and the difference
 * carries meaning: a ticking counter reads as a clock counting up, so it must
 * not change shape as it crosses a minute, while a finished duration reads as a
 * measurement and earns its tenth of a second. Hence `0:14 WAITING` and
 * `5:20 ELAPSED` here, against `9.8s TOTAL` from `formatDuration` above.
 */
export function formatElapsedClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const whole = Math.floor(ms / 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** The duration between two instants, for the detail header's slot. */
export function durationBetween(sinceIso: string, untilIso: string | null, now: number): number {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return 0;
  const until = untilIso === null ? now : Date.parse(untilIso);
  return Math.max(0, (Number.isNaN(until) ? now : until) - since);
}

/**
 * Relative timestamps as the register renders them: `2 m ago`, `2 h ago`,
 * `3 d ago`. The absolute ISO instant is always available on hover/long-press,
 * so this is a supplement and never the only rendering.
 */
export function formatRelative(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

/** Wall-clock `HH:MM:SS`, used by the connection indicator's "as of". */
export function formatClock(at: number | Date): string {
  const d = typeof at === "number" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * The submit form's live preview of `duration_ms` — `120000` reads `2 m 0 s`.
 * Returns null for input that is not a usable duration, so the caller renders
 * nothing rather than a misleading approximation.
 */
export function humanizeMs(ms: number): string | null {
  if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < 1) return null;
  if (ms < 1000) return `${ms} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    const rendered = Number.isInteger(totalSeconds) ? String(totalSeconds) : totalSeconds.toFixed(1);
    return `${rendered} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes} m ${seconds} s`;
}

/**
 * The identity chip's masked key: `bb_9f2ce4a1…6b54`. Never renders the whole
 * key, and never claims to know a user's name — the SPA has no endpoint that
 * could tell it one (docs/ui-spec.md §7).
 */
export function maskKey(key: string | null): string {
  if (!key) return "";
  if (key.length <= 14) return key;
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}

/** Pretty-print a JSON payload for the mono panels (ui-spec §3.12). */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** `attempts / max_attempts`, except queued rows read `—`: zero-of-three would
 * imply a spent attempt (ui-spec §3.4). */
export function formatAttempts(attempts: number, maxAttempts: number, status: string): string {
  if (status === "queued" || attempts === 0) return "—";
  return `${attempts} / ${maxAttempts}`;
}
