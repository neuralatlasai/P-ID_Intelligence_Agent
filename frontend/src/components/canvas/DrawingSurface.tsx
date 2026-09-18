"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CSSProperties } from "react";
import { type CanvasDrawing, type DrawingNode } from "@/lib/canvas/model";
import { objectClass } from "@/lib/canvas/taxonomy";
import styles from "./IndustrialWorkspace.module.css";

/** Stage padding, per the stylesheet. The left side clears the floating palette. */
const STAGE_PAD_LEFT = 84;
const STAGE_PAD_TOP = 26;
const STAGE_GUTTER = STAGE_PAD_LEFT + 26;

/** Height of the sheet's filename caption, which sits above the raster. */
const CAPTION_HEIGHT = 22;

/** The detail card's footprint. The stylesheet caps it at exactly these dimensions. */
const CARD_WIDTH = 344;
const CARD_HEIGHT = 420;

/** Corner radius of a detection box, in the drawing's own coordinates. */
const MARKER_RADIUS = 5;
/** The selection callout, in the drawing's own coordinates. */
const CALLOUT_TEXT = 22;
const CALLOUT_HEIGHT = 32;
const CALLOUT_PAD = 11;

interface OverlayPalette {
  /**
   * Detection overlays: one hue at three weights, which are three strengths of "related to
   * the selection" rather than three input modalities. This canvas selects on click, so the
   * middle level marks what the traversal has reached.
   */
  readonly hover: string;
  readonly hoverWidth: number;
  readonly selected: string;
  readonly selectedWidth: number;
  readonly related: string;
  readonly relatedWidth: number;
  readonly dimmed: number;
  /** The wash inside a selected box. Alpha, so the geometry under it still reads. */
  readonly selectedFill: string;
  /** Connector wires drawn over the sheet, well below the drawing's own geometry. */
  readonly wire: string;
  /** Text on the selection callout, which is filled with the selected overlay. */
  readonly calloutText: string;
  readonly mono: string;
}

/**
 * The overlay palette, read from the stylesheet once for the life of the document.
 *
 * `getComputedStyle` forces a style recalculation, so it is never called from the draw
 * loop: at one call per shape a pan would stall. The tokens do not change at runtime, so a
 * single read serves every frame.
 */
let cachedPalette: OverlayPalette | null = null;

function overlayPalette(): OverlayPalette {
  if (cachedPalette) return cachedPalette;
  const root = getComputedStyle(document.documentElement);
  const token = (name: string): string => root.getPropertyValue(name).trim();
  const size = (name: string, fallback: number): number => {
    const parsed = Number.parseFloat(token(name));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  cachedPalette = {
    hover: token("--overlay-hover"),
    hoverWidth: size("--overlay-hover-width", 1),
    selected: token("--overlay-selected"),
    selectedWidth: size("--overlay-selected-width", 2),
    related: token("--overlay-related"),
    relatedWidth: size("--overlay-related-width", 1),
    dimmed: size("--overlay-dimmed-opacity", 1),
    selectedFill: token("--overlay-selected-bg"),
    wire: token("--ink-wire"),
    calloutText: token("--text-inverse"),
    mono: token("--font-mono"),
  };
  return cachedPalette;
}

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

/**
 * One detection box.
 *
 * Hover, selection and relationship are told apart by the width the tokens fix for each, not
 * by hue — so the same three weights read identically here, on a photograph and in the 3D
 * view. Only the selected box carries a wash, and that wash is alpha, so the geometry it
 * sits over still reads: the drawing is the thing this screen exists for.
 */
function paintMarker(
  context: CanvasRenderingContext2D,
  box: MarkerBox,
  stroke: string,
  width: number,
  opacity: number,
  fill?: string,
): void {
  context.save();
  context.globalAlpha = opacity;
  context.beginPath();
  context.roundRect(box.x, box.y, box.width, box.height, MARKER_RADIUS);
  if (fill) {
    context.fillStyle = fill;
    context.fill();
  }
  context.strokeStyle = stroke;
  context.lineWidth = width;
  context.stroke();
  context.restore();
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
 * The sheet sits on the void, the way a drawing sits on a drafting table, and the overlay is
 * one fixed-resolution canvas rather than several hundred positioned elements — O(V + E) per
 * update, with memory bounded by the raster's own size.
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
      // height would leave the sheet a postage stamp on the drafting field with every
      // annotation illegible. Filling the width and scrolling is how a drawing is read.
      setFitWidth(Math.max(1, element.clientWidth - STAGE_GUTTER));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [drawing]);

  const sheetWidth = (fitWidth * zoom) / 100;
  /** Drawing pixels to CSS pixels. Overlay weights are specified in the latter. */
  const scale = sheetWidth / drawing.width;

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || !scale) return;

    const palette = overlayPalette();
    /** A width the tokens give in CSS pixels, in the drawing's own coordinates. */
    const weight = (css: number) => css / scale;

    // The backing buffer follows the device, not the markup, so the overlay is not soft on
    // a high-DPI display. It is capped at the raster's own resolution: past that the
    // drawing underneath is what limits sharpness, and an unbounded buffer at 300% zoom
    // would cost hundreds of megabytes for no visible gain.
    const ratio = window.devicePixelRatio || 1;
    const bufferWidth = clamp(Math.round(sheetWidth * ratio), 1, drawing.width);
    const bufferHeight = Math.max(
      1,
      Math.round((bufferWidth * drawing.height) / drawing.width),
    );
    if (element.width !== bufferWidth) element.width = bufferWidth;
    if (element.height !== bufferHeight) element.height = bufferHeight;
    // Everything below is expressed in the drawing's coordinates, as the geometry is.
    context.setTransform(
      bufferWidth / drawing.width,
      0,
      0,
      bufferHeight / drawing.height,
      0,
      0,
    );
    context.clearRect(0, 0, drawing.width, drawing.height);

    if (showConnections) {
      for (const edge of drawing.edges) {
        const start = nodeById.get(edge.source);
        const end = nodeById.get(edge.target);
        if (!start || !end || start.positioned === false || end.positioned === false)
          continue;
        const distance = connected.get(start.id);
        const active = distance !== undefined && distance <= step;
        // Reached edges are opaque and thick; the rest sit at wire weight, so the traversal
        // front is readable without burying the drawing underneath it.
        context.strokeStyle = active ? palette.hover : palette.wire;
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
        // Three states, one hue. An object the traversal has reached carries the emphasised
        // weight; anything else joined to the selection carries the relationship weight; an
        // object on another part of the graph is out of context and is dimmed to it. The
        // class is named in the list beside the drawing and in the key above it, so nothing
        // here has to be told apart by colour.
        const depth = connected.get(node.id);
        const reached = depth !== undefined && depth <= step;
        paintMarker(
          context,
          markerBox(node),
          reached ? palette.hover : palette.related,
          weight(reached ? palette.hoverWidth : palette.relatedWidth),
          depth === undefined ? palette.dimmed : 1,
        );
      }
      if (selectedNode) {
        const box = markerBox(selectedNode);
        paintMarker(
          context,
          box,
          palette.selected,
          weight(palette.selectedWidth),
          1,
          palette.selectedFill,
        );
        // A callout carrying whatever the object is currently called. Before the tags are
        // read that is its class; afterwards it is the designation printed on the sheet,
        // which is the only label an engineer can act on — and a designation is read
        // character by character, so the callout is set in mono.
        const text = labelFor(selectedNode);
        context.font = `500 ${CALLOUT_TEXT}px ${palette.mono}`;
        const width = context.measureText(text).width + CALLOUT_PAD * 2;
        const x = Math.min(
          Math.max(0, selectedNode.x - width / 2),
          Math.max(0, drawing.width - width),
        );
        const y = Math.max(0, box.y - 40);
        context.fillStyle = palette.selected;
        context.beginPath();
        context.roundRect(x, y, width, CALLOUT_HEIGHT, MARKER_RADIUS);
        context.fill();
        context.fillStyle = palette.calloutText;
        context.fillText(text, x + CALLOUT_PAD, y + 23);
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
    scale,
    sheetWidth,
  ]);

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
                className="engineeringRaster"
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
