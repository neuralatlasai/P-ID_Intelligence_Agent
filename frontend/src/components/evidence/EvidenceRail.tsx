"use client";

import { useMemo } from "react";

import { AssetHierarchyCard } from "@/components/evidence/AssetHierarchyCard";
import { CitedSourcesCard } from "@/components/evidence/CitedSourcesCard";
import { ConfidenceCard } from "@/components/evidence/ConfidenceCard";
import { ImpactedAssetsCard } from "@/components/evidence/ImpactedAssetsCard";
import { TopologyChangeCard } from "@/components/evidence/TopologyChangeCard";
import {
  deriveEvidenceSupport,
  extractAssetHierarchy,
  extractImpactedAssets,
  extractSources,
  extractTopologySteps,
  splitAnswer,
} from "@/lib/responses/sections";

import styles from "./evidence.module.css";

export interface EvidenceRailProps {
  /** The answer the cards project. Usually the latest assistant turn. */
  readonly answer: string;
  /** Corpus paths the agent actually opened, from persisted tool arguments. */
  readonly toolPaths: readonly string[];
  /** Corpus paths the backend reported as existing, used only to verify a citation. */
  readonly knownPaths?: readonly string[];
  /** Rendered as the inline details stack rather than the fixed rail. */
  readonly inline?: boolean;
}

/**
 * Evidence cards projected from one answer.
 *
 * Every card is conditional on the answer explicitly containing the corresponding content.
 * An empty card is never rendered to fill the column: a placeholder saying "no topology
 * change" would be a claim the answer never made.
 *
 * The rail is a projection, not the source of truth. If every extractor returns nothing,
 * the answer is still complete and fully readable in the conversation column — the rail
 * simply says it has nothing to add.
 *
 * Extraction is memoised on the answer text: during streaming this component would
 * otherwise re-parse the whole answer on every flush.
 */
export function EvidenceRail({
  answer,
  toolPaths,
  knownPaths = [],
  inline = false,
}: EvidenceRailProps) {
  const projection = useMemo(() => {
    const segments = splitAnswer(answer);
    return {
      sources: extractSources(answer, toolPaths, knownPaths),
      support: deriveEvidenceSupport(segments, answer),
      hierarchy: extractAssetHierarchy(segments),
      topology: extractTopologySteps(segments),
      impacted: extractImpactedAssets(segments),
    };
  }, [answer, toolPaths, knownPaths]);

  const hasAnything =
    projection.sources.length > 0 ||
    projection.hierarchy.length > 0 ||
    projection.topology.length >= 2 ||
    projection.impacted.length > 0 ||
    projection.support !== "not_assessed";

  if (!hasAnything) {
    if (inline) {
      return null;
    }
    return (
      <aside className={styles.railEmpty} aria-label="Evidence">
        <p className={styles.railHeading}>Evidence</p>
        <p style={{ marginBlockStart: "var(--space-2)" }}>
          Nothing to project yet. Evidence cards appear when an answer cites sources or
          states topology, hierarchy, impact or support explicitly.
        </p>
      </aside>
    );
  }

  const cards = (
    <>
      <CitedSourcesCard sources={projection.sources} />
      <ConfidenceCard support={projection.support} />
      <TopologyChangeCard steps={projection.topology} />
      <AssetHierarchyCard rows={projection.hierarchy} />
      <ImpactedAssetsCard assets={projection.impacted} />
    </>
  );

  if (inline) {
    return (
      <div className="detailsStack" aria-label="Evidence details">
        {cards}
      </div>
    );
  }

  return (
    <aside className="evidenceRail" aria-label="Evidence">
      <p className={styles.railHeading}>Evidence</p>
      {cards}
    </aside>
  );
}
