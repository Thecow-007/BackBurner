/**
 * The submit screen (docs/frontend-brief.md §4.3) — enqueue a task in seconds,
 * optimised for the repeat case: same lane, same duration, one press.
 *
 * Three rules shape this file more than anything else:
 *
 *  - **The confirmation waits for the event, not the response.** `submit()`
 *    resolves with the created task, but the `ACCEPTED` panel appears only once
 *    the store's `submit` pending flag clears — which happens when the
 *    `accepted` event applies (§6.4). The 201 is an acknowledgement; the event
 *    is the fact.
 *  - **Lanes come from the server or not at all.** The picker is built from
 *    `counts.lanes` (the engine's REGISTERED lanes, ADR 0018). While counts are
 *    null the lane list is genuinely unknown, so submission is disabled and the
 *    screen says so — hard-coding `scrape`/`report` would be invented state.
 *  - **The outcome control is honest about being a demo control.** It says what
 *    the mock worker will do, in the worker's terms, rather than dressing the
 *    failure modes up as something else.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";

import { Button } from "../components/Button.js";
import { StatusChip } from "../components/StatusChip.js";
import { ApiError } from "../lib/api.js";
import { humanizeMs } from "../lib/format.js";
import { getLaneDefault, setLaneDefault } from "../lib/storage.js";
import type { SubmitInput } from "../lib/types.js";
import { useActions, useCounts, useIsPending, useStore } from "../store/react.js";
import styles from "./Submit.module.css";

/** api-contract §6.1: `params.duration_ms` is an integer 1–600000. */
const MAX_DURATION_MS = 600_000;
/** api-contract §6.1: `max_attempts` is an integer 1–10. */
const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 10;

/**
 * The last lane used, remembered "within the session" (§4.3). Module scope
 * rather than component state so it survives navigating away and back, and
 * rather than localStorage because the brief scopes the DURATION default to the
 * browser and the LANE only to the session.
 */
let rememberedLane: string | null = null;

type Outcome = "succeed" | "fail" | "fail_permanent";
type FieldName = "lane" | "duration" | "max_attempts";

interface FieldErrors {
  lane?: string;
  duration?: string;
  max_attempts?: string;
}

export interface SubmitProps {
  /** Navigate to a task's detail screen after the confirmation panel's
   *  "View task". The router owns navigation; this screen does not. */
  onViewTask(taskId: string): void;
}

/** Strict positive-integer parse: `"10e3"`, `"10.5"` and `" 10 "` with junk all
 * fail rather than coercing to something the user did not type. */
function parseIntegerField(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

export function Submit({ onViewTask }: SubmitProps): ReactElement {
  const counts = useCounts();
  const lanes = counts?.lanes;
  const { submit } = useActions();

  const [lane, setLane] = useState<string | null>(rememberedLane);
  const [duration, setDuration] = useState("");
  const [storedDefault, setStoredDefault] = useState<number | undefined>(undefined);
  const [defaultSaved, setDefaultSaved] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("succeed");
  const [maxAttempts, setMaxAttempts] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [touched, setTouched] = useState<Record<FieldName, boolean>>({
    lane: false,
    duration: false,
    max_attempts: false,
  });
  const [focusRequest, setFocusRequest] = useState<FieldName | null>(null);
  const [submitError, setSubmitError] = useState<{ label: string; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState<{ id: string; handle: string } | null>(null);

  const laneRef = useRef<HTMLInputElement>(null);
  const durationRef = useRef<HTMLInputElement>(null);
  const attemptsRef = useRef<HTMLInputElement>(null);
  const acceptedRef = useRef<HTMLElement>(null);

  const uid = useId();
  const laneGroupId = `${uid}-lane`;
  const laneErrorId = `${uid}-lane-error`;
  const durationId = `${uid}-duration`;
  const durationHelpId = `${uid}-duration-help`;
  const durationErrorId = `${uid}-duration-error`;
  const attemptsId = `${uid}-attempts`;
  const attemptsHelpId = `${uid}-attempts-help`;
  const attemptsErrorId = `${uid}-attempts-error`;
  const advancedId = `${uid}-advanced`;

  const lanesUnknown = lanes === undefined;
  const lanesEmpty = lanes !== undefined && lanes.length === 0;
  const lanesUnavailable = lanesUnknown || lanesEmpty;

  /** Selecting a lane prefills the duration from that lane's stored default
   * (§6.3) — including the first, automatic selection below. */
  function selectLane(next: string): void {
    setLane(next);
    rememberedLane = next;
    const stored = getLaneDefault(next);
    setStoredDefault(stored);
    setDuration(stored === undefined ? "" : String(stored));
    setDefaultSaved(false);
    setTouched((prev) => ({ ...prev, lane: true, duration: false }));
  }

  // The lane list arrives with the first snapshot, so the initial selection
  // cannot happen at mount. It runs once the lanes are known — and again only
  // if the remembered/selected lane is not among them.
  useEffect(() => {
    if (lanes === undefined || lanes.length === 0) return;
    if (lane !== null && lanes.includes(lane)) return;
    const preferred = rememberedLane !== null && lanes.includes(rememberedLane) ? rememberedLane : lanes[0];
    if (preferred === undefined) return;
    selectLane(preferred);
    // `selectLane` marks the lane touched; the first selection is automatic,
    // not a user action, so the untouched state is restored here.
    setTouched((prev) => ({ ...prev, lane: false }));
    // `selectLane` closes over setters only, so it is deliberately not a
    // dependency — including it would re-run this on every render.
  }, [lanes, lane]);

  const durationRaw = duration.trim();
  const durationParsed = durationRaw === "" ? null : parseIntegerField(durationRaw);
  const attemptsRaw = maxAttempts.trim();
  const attemptsParsed = attemptsRaw === "" ? null : parseIntegerField(attemptsRaw);

  const errors = useMemo<FieldErrors>(() => {
    const found: FieldErrors = {};
    if (!lanesUnavailable && lane === null) found.lane = "Choose a lane.";
    if (
      durationRaw !== "" &&
      (durationParsed === null || durationParsed < 1 || durationParsed > MAX_DURATION_MS)
    ) {
      found.duration = `Duration must be a whole number of milliseconds from 1 to ${MAX_DURATION_MS}.`;
    }
    if (
      attemptsRaw !== "" &&
      (attemptsParsed === null || attemptsParsed < MIN_ATTEMPTS || attemptsParsed > MAX_ATTEMPTS)
    ) {
      found.max_attempts = `Max attempts must be a whole number from ${MIN_ATTEMPTS} to ${MAX_ATTEMPTS}.`;
    }
    return found;
  }, [lane, lanesUnavailable, durationRaw, durationParsed, attemptsRaw, attemptsParsed]);

  const shownErrors: FieldErrors = {
    lane: touched.lane ? errors.lane : undefined,
    duration: touched.duration ? errors.duration : undefined,
    max_attempts: touched.max_attempts ? errors.max_attempts : undefined,
  };
  const hasShownError =
    shownErrors.lane !== undefined ||
    shownErrors.duration !== undefined ||
    shownErrors.max_attempts !== undefined;

  // The preview only appears for a value we would actually send; previewing an
  // out-of-range number as "≈ 16 m 40 s" would dress up an invalid entry.
  const durationValid = errors.duration === undefined && durationParsed !== null;
  const preview = durationValid ? humanizeMs(durationParsed) : null;
  const canSetDefault = lane !== null && durationValid && durationParsed !== storedDefault;

  // ── Pending, and the event that ends it (§6.4) ────────────────────────────
  //
  // Between the press and the 201 there is no task id to key pending on, so the
  // local flag covers that window; from the 201 onward the STORE owns it, and
  // it clears when `accepted` applies. The confirmation panel is gated on the
  // second, never the first.
  const awaitingAccepted = useIsPending(accepted?.id, "submit");
  const pending = submitting || (accepted !== null && awaitingAccepted);
  const confirmed = accepted !== null && !awaitingAccepted;
  const acceptedTask = useStore((state) =>
    accepted === null ? undefined : state.tasksById.get(accepted.id)
  );

  useEffect(() => {
    if (focusRequest === null) return;
    const target =
      focusRequest === "lane"
        ? laneRef.current
        : focusRequest === "duration"
          ? durationRef.current
          : attemptsRef.current;
    target?.focus();
    setFocusRequest(null);
  }, [focusRequest]);

  // Moving focus to the confirmation is what announces it: the panel replaces
  // the control the user just pressed, so leaving focus on a removed button
  // would strand a keyboard user mid-flow.
  useEffect(() => {
    if (confirmed) acceptedRef.current?.focus();
  }, [confirmed]);

  function handleSetDefault(): void {
    if (lane === null || durationParsed === null || !durationValid) return;
    setLaneDefault(lane, durationParsed);
    setStoredDefault(durationParsed);
    setDefaultSaved(true);
  }

  function buildInput(selectedLane: string): SubmitInput {
    const input: SubmitInput = { lane: selectedLane };
    // Omitted rather than zero-filled: a blank duration means "engine picks
    // 3–15 s", and a blank budget means the lane's configured default.
    if (durationParsed !== null) input.duration_ms = durationParsed;
    if (outcome === "fail") input.fail = true;
    if (outcome === "fail_permanent") input.fail_permanent = true;
    if (attemptsParsed !== null) input.max_attempts = attemptsParsed;
    return input;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (lanesUnavailable || pending) return;

    setTouched({ lane: true, duration: true, max_attempts: true });
    const firstInvalid: FieldName | null =
      errors.lane !== undefined
        ? "lane"
        : errors.duration !== undefined
          ? "duration"
          : errors.max_attempts !== undefined
            ? "max_attempts"
            : null;
    if (firstInvalid !== null || lane === null) {
      // A collapsed field cannot take focus, so the section opens first; both
      // state changes land in the same render, and the focus effect runs after.
      if (firstInvalid === "max_attempts") setAdvancedOpen(true);
      setFocusRequest(firstInvalid ?? "lane");
      return;
    }

    setSubmitError(null);
    setSubmitting(true);
    try {
      const task = await submit(buildInput(lane));
      rememberedLane = lane;
      setAccepted({ id: task.id, handle: task.handle });
    } catch (err) {
      // Unlike the other actions, `submit` throws. Envelope messages are human
      // sentences meant to be read — rendered verbatim, never reworded and
      // never truncated (api-contract §3).
      const isApi = err instanceof ApiError;
      setSubmitError({
        label: isApi && !err.isNetworkError ? `REJECTED · ${err.status} ${err.code}` : "REQUEST FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  function submitAnother(): void {
    // Keeps lane and duration (§4.3) — the repeat case is the whole point.
    setAccepted(null);
    setSubmitError(null);
  }

  const laneHelp = lanesUnknown
    ? "The lane list arrives with your first snapshot from the server; until it does there is nothing to submit into."
    : lanesEmpty
      ? "The server reports no registered lanes, so there is nothing to submit into."
      : "Last used lane is preselected.";

  const durationHelp =
    lane === null
      ? `Optional. Leave blank and the engine picks 3–15 s. Max ${MAX_DURATION_MS}.`
      : storedDefault === undefined
        ? `No default set — the engine picks 3–15 s. Max ${MAX_DURATION_MS}.`
        : `Default for ${lane}: ${humanizeMs(storedDefault) ?? `${storedDefault} ms`} · leave blank and the engine picks 3–15 s. Max ${MAX_DURATION_MS}.`;

  return (
    <section className={styles.screen}>
      <div className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Submit task</h2>
          <span className={styles.cardNote}>POST /tasks · you get a handle back immediately</span>
        </header>

        <form className={styles.form} onSubmit={(event) => void handleSubmit(event)} noValidate>
          {submitError !== null ? (
            <div className={styles.rejected} role="alert">
              <div className={styles.rejectedLabel}>{submitError.label}</div>
              <p className={styles.rejectedMessage}>{submitError.message}</p>
            </div>
          ) : null}

          {/* ── Lane ───────────────────────────────────────────────────── */}
          <fieldset className={styles.group}>
            <legend className={styles.legend}>Lane</legend>
            {lanes !== undefined && lanes.length > 0 ? (
              <div className={styles.lanes} id={laneGroupId}>
                {lanes.map((option, index) => (
                  <label
                    key={option}
                    className={[styles.lane, option === lane ? styles.laneSelected : null]
                      .filter((token): token is string => token !== null)
                      .join(" ")}
                  >
                    <input
                      ref={index === 0 ? laneRef : undefined}
                      type="radio"
                      className={styles.laneInput}
                      name={laneGroupId}
                      value={option}
                      checked={option === lane}
                      onChange={() => selectLane(option)}
                      aria-describedby={shownErrors.lane !== undefined ? laneErrorId : undefined}
                    />
                    <span className={styles.laneText}>{option}</span>
                  </label>
                ))}
              </div>
            ) : null}
            {shownErrors.lane !== undefined ? (
              <p className={styles.fieldError} id={laneErrorId}>
                {shownErrors.lane}
              </p>
            ) : null}
            <p className={lanesUnavailable ? styles.helpLoud : styles.help}>{laneHelp}</p>
          </fieldset>

          {/* ── Duration ───────────────────────────────────────────────── */}
          <div className={styles.group}>
            <label className={styles.legend} htmlFor={durationId}>
              Duration · ms
            </label>
            <div className={styles.durationRow}>
              <input
                ref={durationRef}
                id={durationId}
                className={[styles.input, styles.durationInput, shownErrors.duration !== undefined ? styles.inputInvalid : null]
                  .filter((token): token is string => token !== null)
                  .join(" ")}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={duration}
                onChange={(event) => {
                  setDuration(event.target.value);
                  setDefaultSaved(false);
                }}
                onBlur={() => setTouched((prev) => ({ ...prev, duration: true }))}
                aria-invalid={shownErrors.duration !== undefined || undefined}
                aria-describedby={
                  shownErrors.duration !== undefined
                    ? `${durationErrorId} ${durationHelpId}`
                    : durationHelpId
                }
                placeholder="blank = 3–15 s"
              />
              {/* Sourced entirely from what is typed — it restates the number,
                  it does not predict anything about the run. */}
              {preview !== null ? <span className={styles.preview}>≈ {preview}</span> : null}
              {canSetDefault && lane !== null ? (
                <button type="button" className={styles.setDefault} onClick={handleSetDefault}>
                  Set as default for {lane}
                </button>
              ) : defaultSaved && lane !== null ? (
                <span className={styles.saved} role="status">
                  default saved
                </span>
              ) : null}
            </div>
            {shownErrors.duration !== undefined ? (
              <p className={styles.fieldError} id={durationErrorId}>
                {shownErrors.duration}
              </p>
            ) : null}
            <p className={styles.help} id={durationHelpId}>
              {durationHelp}
            </p>
          </div>

          {/* ── Outcome ────────────────────────────────────────────────── */}
          <fieldset className={styles.group}>
            <legend className={styles.legend}>Outcome</legend>
            <div className={styles.outcomes}>
              {OUTCOMES.map((option) => (
                <label
                  key={option.value}
                  className={[styles.outcome, option.value === outcome ? styles.outcomeSelected : null]
                    .filter((token): token is string => token !== null)
                    .join(" ")}
                >
                  <input
                    type="radio"
                    className={styles.radio}
                    name={`${uid}-outcome`}
                    value={option.value}
                    checked={option.value === outcome}
                    onChange={() => setOutcome(option.value)}
                  />
                  <span className={styles.outcomeBody}>
                    <span className={styles.outcomeTitle}>{option.title}</span>
                    <span className={styles.outcomeNote}>{option.note}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* ── Advanced ───────────────────────────────────────────────── */}
          <div className={styles.advanced}>
            <button
              type="button"
              className={styles.advancedToggle}
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
              aria-controls={advancedId}
            >
              <span className={styles.advancedGlyph} aria-hidden="true">
                {advancedOpen ? "▾" : "▸"}
              </span>
              ADVANCED
            </button>
            {advancedOpen ? (
              <div className={styles.advancedBody} id={advancedId}>
                <label className={styles.advancedLabel} htmlFor={attemptsId}>
                  max_attempts
                </label>
                <input
                  ref={attemptsRef}
                  id={attemptsId}
                  className={[styles.input, styles.attemptsInput, shownErrors.max_attempts !== undefined ? styles.inputInvalid : null]
                    .filter((token): token is string => token !== null)
                    .join(" ")}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={maxAttempts}
                  onChange={(event) => setMaxAttempts(event.target.value)}
                  onBlur={() => setTouched((prev) => ({ ...prev, max_attempts: true }))}
                  aria-invalid={shownErrors.max_attempts !== undefined || undefined}
                  aria-describedby={
                    shownErrors.max_attempts !== undefined
                      ? `${attemptsErrorId} ${attemptsHelpId}`
                      : attemptsHelpId
                  }
                  // Blank sends nothing, so the engine applies the lane's own
                  // default. Prefilling `3` would claim to know that default.
                  placeholder="lane default"
                />
                <p className={styles.help} id={attemptsHelpId}>
                  Automatic retries with backoff before the task lands in failed. {MIN_ATTEMPTS}–
                  {MAX_ATTEMPTS}.
                </p>
                {shownErrors.max_attempts !== undefined ? (
                  <p className={styles.fieldErrorWide} id={attemptsErrorId}>
                    {shownErrors.max_attempts}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* ── Actions, or the confirmation the event earned ───────────── */}
          {confirmed && acceptedTask !== undefined ? (
            <section className={styles.accepted} ref={acceptedRef} tabIndex={-1} role="status">
              <div className={styles.acceptedLabel}>ACCEPTED</div>
              <div className={styles.acceptedHead}>
                <span className={styles.acceptedHandle}>{acceptedTask.handle}</span>
                {/* The engine's status, read back from the store — not the
                    word "queued" hard-coded into the panel. */}
                <StatusChip status={acceptedTask.status} />
              </div>
              <p className={styles.acceptedNote}>
                Handle leased until the result is collected or the task is cancelled.
              </p>
              <div className={styles.acceptedActions}>
                <Button
                  variant="secondary"
                  size="large"
                  className={styles.acceptedButton}
                  onClick={() => onViewTask(acceptedTask.id)}
                >
                  View task
                </Button>
                <Button
                  variant="primary"
                  size="large"
                  className={styles.acceptedButton}
                  onClick={submitAnother}
                >
                  Submit another
                </Button>
              </div>
            </section>
          ) : (
            <div className={styles.actions}>
              <Button
                type="submit"
                variant="primary"
                size="large"
                pending={pending}
                pendingLabel="Submitting…"
                disabled={lanesUnavailable || hasShownError}
              >
                Submit task
              </Button>
              {pending ? <span className={styles.pendingNote}>pending until accepted lands</span> : null}
            </div>
          )}
        </form>
      </div>
    </section>
  );
}

/**
 * The outcome options, in the mock worker's own terms (frontend-brief §4.3).
 * Naming them "Succeed / Fail" and then explaining exactly what the worker does
 * is the honest framing: this control exists so every failure path in the spec
 * is reproducible on demand.
 */
const OUTCOMES: ReadonlyArray<{ value: Outcome; title: string; note: string }> = [
  {
    value: "succeed",
    title: "Succeed",
    note: "Worker sleeps for the duration, then returns a result.",
  },
  {
    value: "fail",
    title: "Fail — retryable",
    note: "Worker returns a retryable error; the engine auto-retries with backoff until the attempt budget runs out.",
  },
  {
    value: "fail_permanent",
    title: "Fail — permanent",
    note: "Worker returns a non-retryable error; the task lands in failed immediately, no auto-retries.",
  },
];
