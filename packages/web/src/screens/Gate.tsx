/**
 * The API-key gate (docs/frontend-brief.md §4.1) — the pre-app surface. There
 * is no signup: access is a per-user key issued out of band, and nothing else
 * renders until one is accepted.
 *
 * Two decisions worth stating, because both look like omissions:
 *
 *  - **No client-side format check.** The helper text says `bb_` + 40 hex, but
 *    the field only gates on "non-empty". The server is the authority on
 *    whether a key works, and a regex that rejects a key the server would have
 *    accepted is a worse failure than one round trip.
 *  - **The input is never cleared on rejection.** A mistyped character is the
 *    common case; clearing the field would force a re-paste of a 43-character
 *    secret to fix a typo. It is preserved and refocused for correction.
 *
 * The key is never logged, never placed in a URL, and never rendered unmasked
 * except through the user's own show toggle.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from "react";

import { Button } from "../components/Button.js";
import { useActions, useAuth } from "../store/react.js";
import styles from "./Gate.module.css";

/**
 * The store's mid-session message, verbatim from `store.ts`'s `kickToGate`.
 * The gate has two distinct error surfaces — a banner for "your session ended
 * under you" and an inline line for "this key was not accepted" — and this
 * exact string is what tells them apart. Any other message is the inline case.
 */
const KICKED_BACK_MESSAGE = "Your API key stopped working; enter a valid key to continue.";

export function Gate(): ReactElement {
  const { status, error } = useAuth();
  const { signIn } = useActions();

  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uid = useId();
  const inputId = `${uid}-key`;
  const helpId = `${uid}-help`;
  const errorId = `${uid}-error`;

  const kickedBack = status === "error" && error === KICKED_BACK_MESSAGE;
  const inlineError = status === "error" && !kickedBack ? error : null;
  const validating = status === "validating";
  // Paste-friendly: the value is trimmed for every decision made about it, so a
  // key copied with a trailing newline behaves exactly like a clean one.
  const trimmed = value.trim();

  // A rejected key comes back to a focused field so the correction is one
  // keystroke away (§4.1). Keyed on `status`, so a second failed attempt
  // (validating → error) refocuses again.
  useEffect(() => {
    if (status === "error") inputRef.current?.focus();
  }, [status]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (trimmed.length === 0 || validating) return;
    // `signIn` does not throw — it writes authStatus/authError and returns.
    void signIn(trimmed);
  }

  return (
    <main className={styles.gate}>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.mark}>
          {/* The ember bar (ui-spec §6): hot end at the bottom, and it never
              fills or depletes — it is a mark, not a progress indicator. */}
          <span className={styles.bar} aria-hidden="true" />
          <h1 className={styles.wordmark}>BackBurner</h1>
          <p className={styles.lede}>
            Background job runner. Enter your API key to open your dashboard.
          </p>
        </div>

        {kickedBack ? (
          // Distinct from the inline field error on purpose: this one is about
          // the session that just ended, not about the characters in the field.
          <div className={styles.banner} role="alert">
            {error}
          </div>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor={inputId}>
            API key
          </label>
          <div
            className={[
              styles.inputRow,
              validating ? styles.locked : null,
              inlineError !== null ? styles.invalid : null,
            ]
              .filter((token): token is string => token !== null)
              .join(" ")}
          >
            <input
              ref={inputRef}
              id={inputId}
              className={styles.input}
              // Masked by default; `text` only through the user's own toggle.
              type={revealed ? "text" : "password"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              // Locked rather than disabled while validating: `readOnly` keeps
              // the field in the tab order and readable by a screen reader,
              // which `disabled` would silently remove (ui-spec §4).
              readOnly={validating}
              aria-disabled={validating || undefined}
              aria-invalid={inlineError !== null || undefined}
              aria-describedby={inlineError !== null ? `${errorId} ${helpId}` : helpId}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
            />
            <button
              type="button"
              className={styles.toggle}
              onClick={() => {
                setRevealed((shown) => !shown);
                inputRef.current?.focus();
              }}
              aria-pressed={revealed}
              aria-controls={inputId}
            >
              {revealed ? "hide" : "show"}
            </button>
          </div>

          {inlineError !== null ? (
            <p className={styles.error} id={errorId}>
              {inlineError}
            </p>
          ) : null}

          <p className={styles.help} id={helpId}>
            bb_ followed by 40 hex characters
          </p>
        </div>

        <Button
          type="submit"
          variant="primary"
          size="large"
          className={styles.connect}
          pending={validating}
          pendingLabel="Connecting…"
          disabled={trimmed.length === 0}
        >
          Connect
        </Button>

        <p className={styles.fine}>Your key is stored only in this browser.</p>
      </form>
    </main>
  );
}
