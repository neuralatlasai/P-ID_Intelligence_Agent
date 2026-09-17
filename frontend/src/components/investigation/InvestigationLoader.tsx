"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { drawing as fixture, parseDrawing, type CanvasDrawing } from "@/lib/canvas/model";
import {
  createDemoFusionManifest,
  parseFusionManifest,
  type FusionManifest,
} from "@/lib/investigation/model";

import { InvestigationWorkspace } from "./InvestigationWorkspace";
import styles from "./InvestigationWorkspace.module.css";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly drawing: CanvasDrawing;
      readonly fusionManifest: FusionManifest;
      readonly source: "backend" | "demo";
    };

const DEFAULT_DRAWING = "PID2Graph OPEN100/0.graphml";

/** Load one corpus pair without silently replacing failed evidence with fixture data. */
export function InvestigationLoader({ sessionId }: { readonly sessionId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort("timeout"), 15000);

    async function load() {
      try {
        const [drawingResponse, fusionResponse] = await Promise.all([
          fetch(`/api/canvas/graph/${encodeURIComponent(DEFAULT_DRAWING)}`, {
            cache: "no-store",
            signal: controller.signal,
          }),
          fetch(`/api/canvas/fusion/${encodeURIComponent(DEFAULT_DRAWING)}`, {
            cache: "no-store",
            signal: controller.signal,
          }),
        ]);
        if (!drawingResponse.ok) {
          throw new Error(`Drawing service returned HTTP ${drawingResponse.status}.`);
        }
        if (!fusionResponse.ok) {
          throw new Error(`Fusion service returned HTTP ${fusionResponse.status}.`);
        }
        const drawing = parseDrawing(await drawingResponse.json());
        if (!drawing) throw new Error("The drawing service returned unsupported geometry.");
        const fusionManifest = parseFusionManifest(await fusionResponse.json(), drawing);
        if (!fusionManifest) {
          throw new Error("The field-to-simulation mapping failed independent validation.");
        }
        if (!controller.signal.aborted) {
          setState({ kind: "ready", drawing, fusionManifest, source: "backend" });
        }
      } catch (error) {
        if (!controller.signal.aborted || controller.signal.reason === "timeout") {
          setState({
            kind: "failed",
            message:
              controller.signal.reason === "timeout"
                ? "Evidence service timed out. Retry the connection."
                : error instanceof Error
                  ? error.message
                  : "Could not load linked evidence.",
          });
        }
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void load();
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  if (state.kind === "ready") {
    return (
      <InvestigationWorkspace
        sessionId={sessionId}
        drawing={state.drawing}
        fusionManifest={state.fusionManifest}
        sourceMode={state.source}
      />
    );
  }

  function retry() {
    setState({ kind: "loading" });
    setAttempt((value) => value + 1);
  }

  function openDemo() {
    const drawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
    setState({
      kind: "ready",
      drawing,
      fusionManifest: createDemoFusionManifest(drawing),
      source: "demo",
    });
  }

  return (
    <main className={styles.connectionScreen}>
      <span>Linked investigation</span>
      <h1>Preparing evidence map</h1>
      <p role="status">
        {state.kind === "loading"
          ? "Loading the corpus drawing and extracted topology..."
          : state.message}
      </p>
      {state.kind === "failed" ? (
        <div>
          <button onClick={retry}>Retry connection</button>
          <button onClick={openDemo}>Open labeled demonstration</button>
        </div>
      ) : null}
      <Link href={`/canvas?session=${sessionId}`}>Return to Industrial Canvas</Link>
    </main>
  );
}
