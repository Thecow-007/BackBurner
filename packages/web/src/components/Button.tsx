/**
 * The only button in the SPA. Four variants, two sizes, and the pending state
 * that carries the product's central promise: the interface never claims an
 * action succeeded before the confirming SSE event lands — not when the HTTP
 * response returns (docs/ui-spec.md §0, §3.7; docs/frontend-brief.md §6.4).
 *
 * Presentational only. Every label and every callback arrives as a prop; this
 * component reads no store and issues no request.
 */
import type { ButtonHTMLAttributes, MouseEvent, ReactElement, ReactNode } from "react";

import styles from "./Button.module.css";

/**
 * `quiet` exists because the design draws every dismiss affordance — `Keep it`,
 * `Keep running` — quieter than `secondary`: dim text, no border. Giving the
 * safe choice the same weight as the destructive one is exactly the pressure a
 * confirmation is supposed to remove.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "collect";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "disabled"> {
  variant?: ButtonVariant;
  size?: "default" | "large";
  /** True from press until the confirming SSE event lands — NOT until the
   *  HTTP response returns. */
  pending?: boolean;
  /** Rendered INSTEAD of children while pending: "Cancelling…", "Retrying…",
   *  "Collecting…", "Submitting…". Pending is a text change, never a spinner. */
  pendingLabel?: string;
  disabled?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "default",
  pending = false,
  pendingLabel,
  disabled = false,
  children,
  className,
  onClick,
  type = "button",
  ...rest
}: ButtonProps): ReactElement {
  const blocked = pending || disabled;

  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    if (blocked) {
      // Swallowing the handler is not enough: an aria-disabled button is a real
      // button, so a `type="submit"` one would still submit its form.
      event.preventDefault();
      return;
    }
    onClick?.(event);
  }

  const classes = [
    styles.button,
    styles[variant],
    size === "large" ? styles.large : styles.default,
    pending ? styles.pending : undefined,
    className,
  ]
    .filter((token): token is string => Boolean(token))
    .join(" ");

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      // Pending deliberately avoids the native `disabled` attribute: a disabled
      // button drops out of the tab order and announces nothing, and "we are
      // still waiting on the engine" is exactly the state a user needs told
      // about. aria-disabled plus the changed label carries it (ui-spec §3.7).
      disabled={disabled && !pending}
      aria-disabled={pending || undefined}
      onClick={handleClick}
    >
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
}
