import { Skeleton } from "@/components/ui/Skeleton";

/**
 * The route-level loading state.
 *
 * A light transcript skeleton rather than a full-page spinner: the shell is cheap to
 * render, and blocking the whole page makes a fast load feel slower than it is.
 */
export default function Loading() {
  return (
    <div className="appFrame">
      <div style={{ padding: "var(--space-8)" }}>
        <Skeleton lines={5} label="Loading session" />
      </div>
    </div>
  );
}
