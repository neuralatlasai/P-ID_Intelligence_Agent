import styles from "./StatusDot.module.css";

export type StatusTone = "ready" | "degraded" | "down" | "checking";

export interface StatusDotProps {
  readonly tone: StatusTone;
  /** Visible label. Never omitted: colour alone does not communicate status. */
  readonly label: string;
  readonly pulsing?: boolean;
  readonly hideLabel?: boolean;
}

/**
 * A status indicator.
 *
 * The dot is decorative and hidden from assistive technology; the adjacent text is the real
 * signal. A visually hidden label stays in the accessibility tree, so the status is still
 * announced.
 */
export function StatusDot({
  tone,
  label,
  pulsing = false,
  hideLabel = false,
}: StatusDotProps) {
  return (
    <span className={styles.wrapper}>
      <span
        aria-hidden="true"
        className={[styles.dot, styles[tone], pulsing ? styles.pulsing : ""]
          .filter(Boolean)
          .join(" ")}
      />
      <span className={hideLabel ? "srOnly" : undefined}>{label}</span>
    </span>
  );
}
