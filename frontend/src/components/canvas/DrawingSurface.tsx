"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CSSProperties } from "react";
import { type CanvasDrawing, type DrawingNode } from "@/lib/canvas/model";
import { objectClass } from "@/lib/canvas/taxonomy";
import styles from "./IndustrialWorkspace.module.css";

/** The selected marker's colour. Warm, so it separates from every class hue. */
const SELECTED = "#b8320c";

/** Stage padding, per the stylesheet. The left side clears the floating palette. */
const STAGE_PAD_LEFT = 84;
const STAGE_PAD_TOP = 26;
const STAGE_GUTTER = STAGE_PAD_LEFT + 26;

/** Height of the sheet's filename caption, which sits above the raster. */
const CAPTION_HEIGHT = 22;

/** The detail card's footprint. The stylesheet caps it at exactly these dimensions. */
const CARD_WIDTH = 344;
const CARD_HEIGHT = 420;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

interface MarkerBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The drawn rectangle for a node, with a floor so a tiny symbol stays visible. */
function markerBox(node: DrawingNode): MarkerBox {
  const width = Math.max(24, node.width + 10);
  const height = Math.max(24, node.height + 10);
  return { x: node.x - width / 2, y: node.y - height / 2, width, height };
}

function paintMarker(
  context: CanvasRenderingContext2D,
  box: MarkerBox,
  stroke: string,
  emphasised: boolean,
): void {
  context.strokeStyle = stroke;
  context.fillStyle = `${stroke}${emphasised ? "2e" : "12"}`;
  context.lineWidth = emphasised ? 6 : 2.5;
  context.beginPath();
  context.roundRect(box.x, box.y, box.width, box.height, 5);
  context.fill();
  context.stroke();
}

interface Props {
  readonly drawing: CanvasDrawing;
  readonly imageUrl: string;
  readonly selected: string;
  readonly connected: ReadonlyMap<string, number>;
  readonly showConnections: boolean;
  readonly showTags: boolean;
  /** Classes switched off in the legend; their markers are not drawn. */
  readonly hiddenClasses: ReadonlySet<string>;
  readonly zoom: number;
  readonly step: number;
  readonly onSelect: (id: string) => void;
  /** What to print on the selected symbol: its plant tag once read, its class until then. */
  readonly labelFor: (node: DrawingNode) => string;
  /** Floating controls drawn over the stage, outside the sheet's scaling. */
  readonly tools: ReactNode;
  /** The detail card, anchored to the selected object inside the sheet. */
  readonly detail: ReactNode;
}

/**
 * The drawing stage.
 *
 * The sheet floats on a dotted field, the way a drawing sits on a drafting table, and the
 * overlay is one fixed-resolution canvas rather than several hundred positioned elements —
 * O(V + E) per update, with memory bounded by the raster's own size.
 *
 * The overlay is `aria-hidden` and the sheet carries no interactive semantics of its own.
 * Everything selectable here is also a button in the object list beside it, which is what a
 * keyboard or screen-reader user operates; a click target painted into a bitmap is not.
 */
export function DrawingSurface({
  drawing,
  imageUrl,
  selected,
  connected,
  showConnections,
  showTags,
  hiddenClasses,
  zoom,
  step,
  onSelect,
  labelFor,
  tools,
  detail,
}: Props) {
  const nodeById = useMemo(
    () => new Map(drawing.nodes.map((node) => [node.id, node])),
    [drawing],
  );
  const [imageFailed, setImageFailed] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState(720);
  const [pan, setPan] = useState({ left: 0, top: 0, width: 0, height: 0 });

  // The card is placed in the stage's own coordinates rather than the sheet's, so it can
  // never be clipped by the edge of the pane. That requires knowing where the sheet has
  // been panned to, which is what this tracks — coalesced to one read per frame, because a
  // scroll fires far more often than the browser paints.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setPan({
        left: element.scrollLeft,
        top: element.scrollTop,
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(element);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      // 100% means the width of the stage, not the whole sheet scaled to fit inside it.
      // A P&ID is wider than it is tall and a workspace pane is wider still, so fitting the
      // height would leave the sheet a postage stamp in a field of grey with every
      // annotation illegible. Filling the width and scrolling is how a drawing is read.
      setFitWidth(Math.max(1, element.clientWidth - STAGE_GUTTER));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [drawing]);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, drawing.width, drawing.height);

    if (showConnections) {
      for (const edge of drawing.edges) {
        const start = nodeById.get(edge.source);
        const end = nodeById.get(edge.target);
        if (!start || !end || start.positioned === false || end.positioned === false)
          continue;
        const distance = connected.get(start.id);
        const active = distance !== undefined && distance <= step;
        // Reached edges are opaque and thick; the rest stay faint, so the traversal front
        // is readable without burying the drawing underneath it.
        context.strokeStyle = active ? "#6d28d9" : "#2563eb2e";
        context.lineWidth = active ? 5 : 2;
        context.lineCap = "round";
        // A dashed source line is drawn dashed here too, rather than redrawn as a solid
        // one, because the style is the only thing that distinguishes a signal line.
        context.setLineDash(edge.style === "non-solid" ? [14, 10] : []);
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }
      context.setLineDash([]);
    }

    if (showTags) {
      // The selection is painted after every other marker so its highlight is never
      // overdrawn by a neighbouring box further down the node list.
      let selectedNode: DrawingNode | null = null;
      for (const node of drawing.nodes) {
        if (node.positioned === false) continue;
        const type = objectClass(node.kind);
        if (!type.equipment || hiddenClasses.has(node.kind)) continue;
        if (node.id === selected) {
          selectedNode = node;
          continue;
        }
        // The hue restates the class already named in the list beside the drawing, and the
        // legend above the stage spells each one out.
        paintMarker(context, markerBox(node), type.colour, false);
      }
      if (selectedNode) {
        const box = markerBox(selectedNode);
        paintMarker(context, box, SELECTED, true);
        // A callout carrying whatever the object is currently called. Before the tags are
        // read that is its class; afterwards it is the designation printed on the sheet,
        // which is the only label an engineer can act on.
        const text = labelFor(selectedNode);
        context.font = "600 22px ui-sans-serif, system-ui, sans-serif";
        const width = context.measureText(text).width + 22;
        const x = Math.min(
          Math.max(0, selectedNode.x - width / 2),
          Math.max(0, drawing.width - width),
        );
        const y = Math.max(0, box.y - 40);
        context.fillStyle = SELECTED;
        context.beginPath();
        context.roundRect(x, y, width, 32, 6);
        context.fill();
        context.fillStyle = "#ffffff";
        context.fillText(text, x + 11, y + 23);
      }
    }
  }, [
    selected,
    connected,
    showConnections,
    showTags,
    hiddenClasses,
    step,
    drawing,
    nodeById,
    labelFor,
  ]);

  const sheetWidth = (fitWidth * zoom) / 100;
  const scale = sheetWidth / drawing.width;

  useEffect(() => {
    const element = stage.current;
    const node = nodeById.get(selected);
    if (!element || !node || node.positioned === false || !sheetWidth) return;
    // Centre the symbol, clamped by the browser to the scrollable range. Instant rather
    // than smooth under a reduced-motion preference, which is a movement like any other.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({
      left: node.x * scale - element.clientWidth / 2,
      top: node.y * scale - element.clientHeight / 2,
      behavior: reduced ? "instant" : "smooth",
    });
  }, [selected, nodeById, scale, sheetWidth]);

  const selectedNode = nodeById.get(selected);
  // Where the selected symbol currently sits inside the pane, in pixels from its top-left.
  const anchor =
    selectedNode && selectedNode.positioned !== false
      ? {
          x: STAGE_PAD_LEFT + selectedNode.x * scale - pan.left,
          y: STAGE_PAD_TOP + CAPTION_HEIGHT + selectedNode.y * scale - pan.top,
        }
      : null;
  // Off-pane, the card has nothing to point at, so it is not drawn at all.
  const onScreen =
    anchor !== null &&
    anchor.x > -40 &&
    anchor.y > -40 &&
    anchor.x < pan.width + 40 &&
    anchor.y < pan.height + 40;
  // The card opens below and right of the symbol and is then clamped into the pane. Flipping
  // sides instead would still overflow whenever neither side had room, which on a short
  // pane is most selections; clamping cannot, because the card's footprint is bounded.
  const card = anchor
    ? {
        left: clamp(anchor.x + 16, 8, Math.max(8, pan.width - CARD_WIDTH - 8)),
        top: clamp(anchor.y + 16, 8, Math.max(8, pan.height - CARD_HEIGHT - 8)),
      }
    : null;

  return (
    <div className={styles.stageWrap}>
      <div
        ref={stage}
        className={styles.stage}
        tabIndex={0}
        role="group"
        aria-label="Drawing stage. Scroll to pan; select objects using the object list."
      >
        {imageFailed ? (
          <p role="alert" className={styles.stageError}>
            The drawing image could not be loaded. Refresh the source to retry.
          </p>
        ) : (
          <figure className={styles.sheet} style={{ width: `${sheetWidth}px` }}>
            <figcaption>{drawing.imagePath.split("/").at(-1)}</figcaption>
            <div className={styles.sheetBody}>
              {/* The corpus raster is the drawing itself; no screenshot stands in for it. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt={`P&ID source drawing: ${drawing.imagePath}`}
                onError={() => setImageFailed(true)}
                width={drawing.width}
                height={drawing.height}
                draggable={false}
              />
              <canvas
                ref={canvas}
                width={drawing.width}
                height={drawing.height}
                aria-hidden="true"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const x = ((event.clientX - rect.left) * drawing.width) / rect.width;
                  const y = ((event.clientY - rect.top) * drawing.height) / rect.height;
                  // Nearest positioned object within a fixed on-screen radius, so the same
                  // gesture picks the same symbol at every zoom level.
                  let best = (30 * drawing.width) / rect.width;
                  let candidate: string | undefined;
                  for (const node of drawing.nodes) {
                    if (node.positioned === false) continue;
                    const distance = Math.hypot(node.x - x, node.y - y);
                    if (distance < best) {
                      best = distance;
                      candidate = node.id;
                    }
                  }
                  if (candidate) onSelect(candidate);
                }}
              />
            </div>
          </figure>
        )}
      </div>
      {detail && card && onScreen ? (
        <div
          className={styles.anchor}
          style={
            {
              left: `${card.left}px`,
              top: `${card.top}px`,
              // On a pane shorter than the card, the card scrolls inside the space it has
              // rather than running off the bottom of the stage.
              "--card-max": `${Math.max(160, pan.height - card.top - 8)}px`,
            } as CSSProperties
          }
        >
          {detail}
        </div>
      ) : null}
      {/* Pinned to the stage, not to the sheet, so panning never moves the controls. */}
      {tools}
    </div>
  );
}
