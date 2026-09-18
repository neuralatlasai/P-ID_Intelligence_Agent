import { Card } from "@/components/ui/Card";

import styles from "./evidence.module.css";

export interface AssetHierarchyCardProps {
  readonly rows: ReadonlyArray<{ readonly label: string; readonly depth: number }>;
}

/**
 * An asset hierarchy the answer stated explicitly.
 *
 * Levels come from the answer's own indentation or arrow notation. Nothing is derived from
 * tag naming: `P-2101A` looking like a child of `P-2101` is a naming convention, not a
 * stated relationship, and presenting it as one would be the frontend asserting an
 * engineering fact.
 *
 * The card is omitted entirely when the answer contains no hierarchy.
 */
export function AssetHierarchyCard({ rows }: AssetHierarchyCardProps) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <Card title="Asset hierarchy" count={rows.length}>
      <ul className={styles.hierarchy}>
        {rows.map((row, index) => (
          <li
            key={`${row.label}-${index}`}
            className={styles.hierarchyRow}
            style={{ paddingInlineStart: `${row.depth * 14}px` }}
          >
            {row.depth > 0 ? (
              <span className={styles.hierarchyRail} aria-hidden="true">
                └
              </span>
            ) : null}
            <span>{row.label}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
