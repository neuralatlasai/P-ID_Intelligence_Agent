import styles from "./Skeleton.module.css";

export interface SkeletonProps {
  readonly lines?: number;
  readonly label: string;
}

/**
 * A loading placeholder for the transcript.
 *
 * The group carries a status role and a label so a screen reader hears "Loading
 * conversation history" rather than nothing at all, and the shimmer is decorative.
 */
export function Skeleton({ lines = 3, label }: SkeletonProps) {
  return (
    <div className={styles.group} role="status" aria-live="polite">
      <span className="srOnly">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={styles.line}
          style={{ inlineSize: `${100 - index * 12}%` }}
        />
      ))}
    </div>
  );
}
