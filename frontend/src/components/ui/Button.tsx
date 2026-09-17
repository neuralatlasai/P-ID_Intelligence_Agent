import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly block?: boolean;
  readonly leadingIcon?: ReactNode;
}

/**
 * The application's button.
 *
 * `type` defaults to "button". The HTML default is "submit", which inside the composer
 * form would make every icon button send the question — a bug that stays invisible until
 * someone clicks the wrong control.
 */
export function Button({
  variant = "secondary",
  size = "md",
  block = false,
  leadingIcon,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    styles.base,
    styles[variant],
    styles[size],
    block ? styles.block : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type={type} className={classes} {...rest}>
      {leadingIcon}
      {children}
    </button>
  );
}
