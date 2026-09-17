"use client";

import { Card } from "@/components/ui/Card";
import { DocumentIcon, GraphIcon, ImageIcon } from "@/components/ui/icons";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { SourceReference } from "@/lib/responses/sections";

import styles from "./evidence.module.css";

export interface CitedSourcesCardProps {
  readonly sources: readonly SourceReference[];
}

/**
 * The corpus artifacts behind an answer.
 *
 * Each row states how the reference is known. "Opened" means the agent actually called a
 * tool with that exact path, taken from persisted tool arguments; "cited" means the path
 * appears in the answer text. Keeping them distinct matters — a path cited but never opened
 * is exactly the kind of thing an engineer should notice.
 *
 * Clicking copies the path. It does not open a file: the backend serves no corpus files, so
 * any URL built here would be a guess, and a link that 404s is worse than no link.
 */
export function CitedSourcesCard({ sources }: CitedSourcesCardProps) {
  const { state, copy } = useCopyToClipboard();

  if (sources.length === 0) {
    return null;
  }

  return (
    <Card title="Cited drawings & sources" count={sources.length}>
      <div className={styles.sourceList}>
        {sources.map((source) => (
          <button
            key={source.path}
            type="button"
            className={styles.source}
            onClick={() => void copy(source.path)}
            title={`Copy ${source.path}`}
          >
            <span className={styles.sourceIcon}>{iconFor(source.kind)}</span>
            <span className={styles.sourceBody}>
              <span className={styles.sourcePath}>{source.path}</span>
              {/*
                Separators are real characters rather than flex gaps alone, so selecting
                and copying a row yields readable text instead of run-together words.
              */}
              <span className={styles.sourceMeta}>
                <span>{labelFor(source.kind)}</span>
                {source.page ? <span>{`· page ${source.page}`}</span> : null}
                <span>
                  {source.provenance === "opened"
                    ? "· opened by agent"
                    : "· cited in answer"}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>
      <p className="srOnly" role="status">
        {state === "copied" ? "Path copied to clipboard" : ""}
      </p>
    </Card>
  );
}

function iconFor(kind: SourceReference["kind"]) {
  if (kind === "png") {
    return <ImageIcon size={15} />;
  }
  if (kind === "graphml") {
    return <GraphIcon size={15} />;
  }
  return <DocumentIcon size={15} />;
}

function labelFor(kind: SourceReference["kind"]): string {
  if (kind === "png") {
    return "Drawing";
  }
  if (kind === "graphml") {
    return "Topology";
  }
  return "Document";
}
