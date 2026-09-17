import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./IconButton.module.css";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The control has no visible text, so this is its entire accessible name. */
  readonly label: string;
  readonly icon: ReactNode;
  readonly bordered?: boolean;
  readonly pressed?: boolean;
}

/**
 * An icon-only control.
 *
 * `label` is required rather than optional because an icon button without an accessible
 * name is invisible to a screen reader, and an optional prop guarantees someone omits it.
 */
export function IconButton({
  label,
  icon,
  bordered = false,
  pressed,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  const classes = [
    styles.base,
    bordered ? styles.bordered : "",
    pressed ? styles.pressed : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      {...rest}
    >
      {icon}
    </button>
  );
}
