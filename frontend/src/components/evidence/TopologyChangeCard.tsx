import { Card } from "@/components/ui/Card";
import type { TopologyStep } from "@/lib/responses/sections";

import styles from "./evidence.module.css";

export interface TopologyChangeCardProps {
  readonly steps: readonly TopologyStep[];
}

/**
 * A connectivity path the answer stated explicitly.
 *
 * Only arrow notation is read, because an arrow is the answer asserting a relationship.
 * Items merely adjacent in a list are not connected, and rendering them as a chain would
 * manufacture edges that no source claimed.
 *
 * Drawn with text and CSS rather than a graph library: this is a short linear path, and a
 * canvas framework would be a large dependency for it — and would invite treating the
 * picture as the topology rather than as a view of what the answer said.
 */
export function TopologyChangeCard({ steps }: TopologyChangeCardProps) {
  if (steps.length < 2) {
    return null;
  }

  return (
    <Card title="Topology / connectivity" count={steps.length}>
      <ol className={styles.topology}>
        {steps.map((step, index) => (
          <li key={`${step.label}-${index}`}>
            <span className={styles.topologyNode}>{step.label}</span>
            {index < steps.length - 1 ? (
              <span className={styles.topologyArrow} aria-hidden="true">
                ↓
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}
