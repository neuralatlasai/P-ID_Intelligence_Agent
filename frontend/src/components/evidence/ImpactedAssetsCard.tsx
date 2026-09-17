import { Card } from "@/components/ui/Card";
import type { ImpactedAsset } from "@/lib/responses/sections";

import styles from "./evidence.module.css";

export interface ImpactedAssetsCardProps {
  readonly assets: readonly ImpactedAsset[];
}

/**
 * Assets the answer explicitly listed as impacted or related.
 *
 * Only list items inside an impacted-assets section are read. A tag appearing in prose is
 * not an impact claim, and promoting it to one would turn a mention into a finding.
 */
export function ImpactedAssetsCard({ assets }: ImpactedAssetsCardProps) {
  if (assets.length === 0) {
    return null;
  }

  return (
    <Card title="Related & impacted assets" count={assets.length}>
      <ul className={styles.impacted}>
        {assets.map((asset, index) => (
          <li key={`${asset.tag}-${index}`} className={styles.impactedRow}>
            {/*
              The dash is a real character rather than a flex gap alone, so selecting and
              copying a row yields "E-2201 — downstream heat exchanger" rather than
              run-together words.
            */}
            <span className={styles.impactedTag}>{asset.tag}</span>
            {asset.note ? (
              <span className={styles.impactedNote}>{` — ${asset.note}`}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
