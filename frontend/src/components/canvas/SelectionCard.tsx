"use client";

import type { DrawingNode } from "@/lib/canvas/model";
import { objectClass, displayName, splitIdentifier } from "@/lib/canvas/taxonomy";
import styles from "./IndustrialWorkspace.module.css";

export interface ConnectionBreakdown {
  readonly total: number;
  readonly solid: number;
  readonly dashed: number;
  readonly unstyled: number;
}

/**
 * The card that opens on the drawing when an object is selected.
 *
 * It answers "what is this?" with what the source actually recorded — class, identifier,
 * position, extent, connections — and says plainly that a plant tag is not among them. The
 * alternative, printing a manufactured designation like `VLV-014` in the title, would be
 * indistinguishable from a real tag to the engineer reading it.
 *
 * The card is decoration over the canvas: the same facts and the same actions are in the
 * agent panel, which is what a keyboard or screen-reader user reaches.
 */
export function SelectionCard({
  node,
  tag,
  connections,
  reachable,
  onIdentifyTag,
  onTrace,
  onAsk,
  onDismiss,
}: {
  readonly node: DrawingNode;
  /** The tag the agent read off the drawing, when it has read one. */
  readonly tag?: string | undefined;
  readonly connections: ConnectionBreakdown;
  readonly reachable: number;
  readonly onIdentifyTag: () => void;
  readonly onTrace: () => void;
  readonly onAsk: () => void;
  readonly onDismiss: () => void;
}) {
  const type = objectClass(node.kind);
  const { ordinal } = splitIdentifier(node.id);

  return (
    <div className={styles.card} aria-hidden="true">
      <header>
        <div>
          <strong>{tag ?? displayName(node.id, node.kind)}</strong>
          <p>{tag ? `${type.name} — ${type.description}` : type.description}</p>
        </div>
        <button type="button" tabIndex={-1} onClick={onDismiss} aria-label="Close">
          ✕
        </button>
      </header>

      <dl className={styles.cardFacts}>
        {tag ? (
          <div>
            <dt>Tag</dt>
            <dd>
              {tag} <span className={styles.cardHint}>read from drawing</span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Class</dt>
          <dd>
            <i style={{ background: type.colour }} />
            {type.name}
          </dd>
        </div>
        <div>
          <dt>Source id</dt>
          <dd className={styles.mono}>{node.id}</dd>
        </div>
        {ordinal ? (
          <div>
            <dt>Ordinal</dt>
            <dd>
              {ordinal} of this class{" "}
              <span className={styles.cardHint}>(extractor order, not a tag)</span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Centre</dt>
          <dd className={styles.mono}>
            {Math.round(node.x)}, {Math.round(node.y)} px
          </dd>
        </div>
        <div>
          <dt>Extent</dt>
          <dd className={styles.mono}>
            {Math.round(node.width)} × {Math.round(node.height)} px
          </dd>
        </div>
        <div>
          <dt>Connections</dt>
          <dd>{describeConnections(connections)}</dd>
        </div>
        <div>
          <dt>Reachable</dt>
          <dd>{reachable} objects</dd>
        </div>
      </dl>

      <div className={styles.cardActions}>
        {!tag && (
          <button type="button" tabIndex={-1} onClick={onIdentifyTag}>
            Read tags from drawing
          </button>
        )}
        <button type="button" tabIndex={-1} onClick={onTrace}>
          Trace connected objects
        </button>
        <button type="button" tabIndex={-1} onClick={onAsk}>
          Ask the agent about this object
        </button>
      </div>
    </div>
  );
}

/** Say how an object connects, distinguishing line styles the source recorded. */
export function describeConnections(breakdown: ConnectionBreakdown): string {
  if (breakdown.total === 0) {
    return "None recorded";
  }
  const parts: string[] = [];
  if (breakdown.solid) parts.push(`${breakdown.solid} solid`);
  if (breakdown.dashed) parts.push(`${breakdown.dashed} dashed`);
  if (breakdown.unstyled) parts.push(`${breakdown.unstyled} unstyled`);
  const noun = breakdown.total === 1 ? "connection" : "connections";
  // One style needs no breakdown: "3 solid connections" already says everything.
  return parts.length === 1
    ? `${parts[0]} ${noun}`
    : `${breakdown.total} ${noun} — ${parts.join(", ")}`;
}
