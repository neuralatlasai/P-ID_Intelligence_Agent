"use client";

import { useEffect, useMemo, useRef } from "react";

import type { AssetDocument, AssetRecord } from "@/lib/canvas/engineering";
import {
  documentContent,
  type DocumentBlock,
  type DocumentContext,
  type LoopWiring,
} from "@/lib/canvas/documents";
import type { CanvasDrawing, DrawingNode } from "@/lib/canvas/model";

import { SimulatedBadge } from "./AssetPanels";
import styles from "./DocumentViewer.module.css";

/**
 * Opens a listed document and shows what is in it.
 *
 * A modal `<dialog>`: focus moves in when it opens, Escape closes it, and focus returns to the
 * file the reader clicked. Tabs along the top switch between the asset's documents without
 * closing, so a datasheet and its loop diagram can be read side by side in turn.
 */
export function DocumentViewer({
  asset,
  document: doc,
  context,
  node,
  drawing,
  imageUrl,
  onSwitch,
  onClose,
  onAsk,
  onShowOnDrawing,
}: {
  readonly asset: AssetRecord;
  readonly document: AssetDocument;
  readonly context: DocumentContext;
  readonly node: DrawingNode | undefined;
  readonly drawing: CanvasDrawing;
  readonly imageUrl: string;
  readonly onSwitch: (document: AssetDocument) => void;
  readonly onClose: () => void;
  readonly onAsk: (question: string) => void;
  readonly onShowOnDrawing: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useMemo(
    () => documentContent(asset, doc, context),
    [asset, doc, context],
  );

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const nodeById = useMemo(() => new Map(drawing.nodes.map((n) => [n.id, n])), [drawing]);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="document-title"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className={styles.sheet}>
        <header className={styles.header}>
          <div>
            <small>{content.number}</small>
            <h2 id="document-title">{content.title}</h2>
            <p>
              {doc.kind} · {content.revision}
              {doc.date ? ` · issued ${doc.date}` : ""}
            </p>
          </div>
          <div className={styles.headerActions}>
            {doc.simulated ? (
              <SimulatedBadge label="Simulated document" />
            ) : (
              <span className={styles.real}>Corpus source</span>
            )}
            <button onClick={() => dialog.current?.close()} aria-label="Close document">
              ✕
            </button>
          </div>
        </header>

        <nav className={styles.tabs} aria-label={`${asset.tag} documents`}>
          {asset.documents.map((other) => (
            <button
              key={other.name}
              aria-current={other.name === doc.name ? "page" : undefined}
              onClick={() => onSwitch(other)}
            >
              {other.kind}
            </button>
          ))}
        </nav>

        <div className={styles.body}>
          {content.blocks.map((block) => (
            <Block
              key={block.heading}
              block={block}
              node={node}
              nodeById={nodeById}
              joined={context.joined}
              drawing={drawing}
              imageUrl={imageUrl}
            />
          ))}
        </div>

        <footer className={styles.footer}>
          <button
            onClick={() => {
              dialog.current?.close();
              onShowOnDrawing();
            }}
          >
            Show {asset.tag} on drawing
          </button>
          {doc.kind === "P&ID" && (
            <a href={imageUrl} target="_blank" rel="noreferrer">
              Open full sheet
            </a>
          )}
          <button
            className={styles.primary}
            onClick={() => {
              dialog.current?.close();
              onAsk(
                `Using ${doc.name} for ${asset.tag} (${asset.name}) and the drawing, check whether the ${doc.kind.toLowerCase()} agrees with what the P&ID shows: its line, its connections and its loop. List anything that conflicts or cannot be confirmed.`,
              );
            }}
          >
            Ask agent to cross-check
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function Block({
  block,
  node,
  nodeById,
  joined,
  drawing,
  imageUrl,
}: {
  readonly block: DocumentBlock;
  readonly node: DrawingNode | undefined;
  readonly nodeById: ReadonlyMap<string, DrawingNode>;
  readonly joined: DocumentContext["joined"];
  readonly drawing: CanvasDrawing;
  readonly imageUrl: string;
}) {
  switch (block.kind) {
    case "fields":
      return (
        <section className={styles.block}>
          <h3>{block.heading}</h3>
          <dl className={styles.fields}>
            {block.rows.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case "table":
      return (
        <section className={styles.block}>
          <h3>{block.heading}</h3>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  {block.columns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, column) => (
                      <td key={column}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );
    case "notes":
      return (
        <section className={styles.block}>
          <h3>{block.heading}</h3>
          <ol className={styles.notes}>
            {block.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </section>
      );
    case "loop":
      return (
        <section className={styles.block}>
          <h3>{block.heading}</h3>
          <LoopDiagram loop={block.loop} />
        </section>
      );
    case "drawing":
      return (
        <section className={styles.block}>
          <h3>{block.heading}</h3>
          {node ? (
            <SheetCrop
              node={node}
              neighbours={joined
                .map(({ id }) => nodeById.get(id))
                .filter((n): n is DrawingNode => Boolean(n))}
              drawing={drawing}
              imageUrl={imageUrl}
            />
          ) : (
            <p>This component has no position on the sheet.</p>
          )}
        </section>
      );
  }
}

/**
 * The real sheet around a component: a detection overlay, so the component and its connections
 * are ringed with the `--overlay-*` family. The two states are told apart by the weight the
 * tokens fix — selected at twice the related ring — rather than by hue.
 */
function SheetCrop({
  node,
  neighbours,
  drawing,
  imageUrl,
}: {
  readonly node: DrawingNode;
  readonly neighbours: readonly DrawingNode[];
  readonly drawing: CanvasDrawing;
  readonly imageUrl: string;
}) {
  const near = neighbours.filter((n) => Math.hypot(n.x - node.x, n.y - node.y) < 520);
  const all = [node, ...near];
  const x0 = Math.min(...all.map((n) => n.x - n.width / 2));
  const x1 = Math.max(...all.map((n) => n.x + n.width / 2));
  const y0 = Math.min(...all.map((n) => n.y - n.height / 2));
  const y1 = Math.max(...all.map((n) => n.y + n.height / 2));
  const width = Math.max(x1 - x0, 320) * 1.25;
  const height = Math.max(y1 - y0, 200) * 1.25;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const stroke = width / 260;
  // `weight` mirrors --overlay-related-width : --overlay-selected-width, scaled into the
  // sheet's own units so a ring keeps its weight at any crop size.
  const ring = (n: DrawingNode, overlay: string, weight: number) => (
    <rect
      key={n.id}
      x={n.x - n.width / 2 - stroke * 3}
      y={n.y - n.height / 2 - stroke * 3}
      width={n.width + stroke * 6}
      height={n.height + stroke * 6}
      rx={stroke * 3}
      fill="none"
      stroke={overlay}
      strokeWidth={stroke * weight}
    />
  );
  return (
    <svg
      className={styles.crop}
      viewBox={`${cx - width / 2} ${cy - height / 2} ${width} ${height}`}
      role="img"
      aria-label={`The sheet around the component, with ${near.length} connected symbols marked`}
    >
      <rect
        x={cx - width / 2}
        y={cy - height / 2}
        width={width}
        height={height}
        fill="var(--bg-void)"
      />
      {/* Normalised to ink-on-void, the same as every other rendering of this sheet. The
          class goes on the image alone so the rings above it are not inverted with it. */}
      <image
        className="engineeringRaster"
        href={imageUrl}
        width={drawing.width}
        height={drawing.height}
      />
      {near.map((n) => ring(n, "var(--overlay-related)", 1))}
      {ring(node, "var(--overlay-selected)", 2)}
    </svg>
  );
}

/** A loop drawing: field device to controller left to right, final element below the controller. */
function LoopDiagram({ loop }: { readonly loop: LoopWiring }) {
  const W = 760;
  const box = { w: 128, h: 58 };
  const gap = (W - 20 - box.w * loop.nodes.length) / Math.max(1, loop.nodes.length - 1);
  const y = 24;
  const xOf = (index: number) => 10 + index * (box.w + gap);
  const zones = ["FIELD", "FIELD", "RACK ROOM", "CONTROL SYSTEM", "CONTROL SYSTEM"];
  const last = loop.nodes.length - 1;
  return (
    <svg
      className={styles.loop}
      viewBox={`0 0 ${W} ${loop.output ? 200 : 110}`}
      role="img"
      aria-label={`Loop ${loop.loop} wiring from field device to controller`}
    >
      {loop.nodes.map((n, index) => (
        <g key={n.tag} transform={`translate(${xOf(index)}, ${y})`}>
          <text className={styles.zone} x={box.w / 2} y={-8} textAnchor="middle">
            {zones[index]}
          </text>
          {n.role === "field" || n.role === "controller" ? (
            <circle cx={box.w / 2} cy={box.h / 2} r={box.h / 2} className={styles.device} />
          ) : (
            <rect width={box.w} height={box.h} rx={4} className={styles.device} />
          )}
          {n.role === "field" || n.role === "controller" ? (
            <>
              <text
                className={styles.tag}
                x={box.w / 2}
                y={box.h / 2 + 4}
                textAnchor="middle"
              >
                {n.tag}
              </text>
              {/* An ISA bubble holds the tag only; its description sits beneath, clear of
                  the output line that leaves the controller from below. */}
              <text
                className={styles.detail}
                x={n.role === "controller" ? box.w / 2 - 10 : box.w / 2}
                y={box.h + 14}
                textAnchor={n.role === "controller" ? "end" : "middle"}
              >
                {n.detail}
              </text>
            </>
          ) : (
            <>
              <text
                className={styles.tag}
                x={box.w / 2}
                y={box.h / 2 - 2}
                textAnchor="middle"
              >
                {n.tag}
              </text>
              <text
                className={styles.detail}
                x={box.w / 2}
                y={box.h / 2 + 13}
                textAnchor="middle"
              >
                {n.detail}
              </text>
            </>
          )}
          {index < last && (
            <line
              x1={n.role === "field" ? box.w / 2 + box.h / 2 : box.w}
              x2={
                box.w +
                gap +
                (loop.nodes[index + 1]!.role === "controller" ? box.w / 2 - box.h / 2 : 0)
              }
              y1={box.h / 2}
              y2={box.h / 2}
              className={styles.wire}
            />
          )}
        </g>
      ))}
      {loop.output && (
        <g>
          <line
            x1={xOf(last) + box.w / 2}
            x2={xOf(last) + box.w / 2}
            y1={y + box.h}
            y2={150}
            className={styles.wire}
            strokeDasharray="6 4"
          />
          <line
            x1={xOf(last) + box.w / 2}
            x2={xOf(0) + box.w / 2 + 34}
            y1={150}
            y2={150}
            className={styles.wire}
            strokeDasharray="6 4"
          />
          <polygon
            points={`${xOf(0) + box.w / 2 - 34},136 ${xOf(0) + box.w / 2 + 34},164 ${xOf(0) + box.w / 2 + 34},136 ${xOf(0) + box.w / 2 - 34},164`}
            className={styles.device}
          />
          <text className={styles.tag} x={xOf(0) + box.w / 2} y={186} textAnchor="middle">
            {loop.output.tag}
          </text>
          <text
            className={styles.detail}
            x={(xOf(0) + xOf(last) + box.w) / 2}
            y={144}
            textAnchor="middle"
          >
            {loop.output.detail}
          </text>
        </g>
      )}
    </svg>
  );
}
