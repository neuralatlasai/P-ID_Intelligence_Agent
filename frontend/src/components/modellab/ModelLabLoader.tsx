"use client";

import { useEffect, useState } from "react";

import { drawing as fixture, parseDrawing, type CanvasDrawing } from "@/lib/canvas/model";
import { FUSION_DRAWING } from "@/lib/investigation/model";
import type { StageId } from "@/lib/modellab/stages";

import { ModelLab } from "./ModelLab";
import styles from "./ModelLab.module.css";

type LoadState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly drawing: CanvasDrawing;
      readonly source: "backend" | "demo";
      readonly drawings: number | null;
      readonly corpusFiles: number | null;
      readonly reason?: string;
    };

function count(body: unknown, key: string): number | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Load the sheet the field references are registered against, and the corpus counts.
 *
 * When the backend cannot be reached the lab opens on the bundled copy of the same sheet and
 * says so in its header. The counts that only the backend knows are then shown as unknown,
 * not filled in.
 */
export function ModelLabLoader({ stageId }: { readonly stageId: StageId }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const offline = (reason: string) =>
      setState({
        kind: "ready",
        drawing: { ...fixture, imagePath: "PID2Graph OPEN100/0.png" },
        source: "demo",
        drawings: null,
        corpusFiles: null,
        reason,
      });

    async function load() {
      try {
        const [graph, catalog, health] = await Promise.all([
          fetch(`/api/canvas/graph/${encodeURIComponent(FUSION_DRAWING)}`, {
            cache: "no-store",
            signal: controller.signal,
          }),
          fetch("/api/canvas/drawings?offset=0", {
            cache: "no-store",
            signal: controller.signal,
          }),
          fetch("/api/health", { cache: "no-store", signal: controller.signal }),
        ]);
        if (!graph.ok) throw new Error(`Drawing service returned HTTP ${graph.status}`);
        const drawing = parseDrawing(await graph.json());
        if (!drawing) throw new Error("The drawing service returned unsupported geometry");
        const catalogBody: unknown = catalog.ok ? await catalog.json() : null;
        const healthBody: unknown = health.ok ? await health.json() : null;
        if (controller.signal.aborted) return;
        setState({
          kind: "ready",
          drawing,
          source: "backend",
          drawings: count(catalogBody, "total"),
          corpusFiles: count(healthBody, "corpusFiles"),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        offline(error instanceof Error ? error.message : "Backend unavailable");
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  if (state.kind === "loading") {
    return (
      <main className={styles.loading}>
        <p role="status">Loading the registered sheet and corpus counts…</p>
      </main>
    );
  }
  return (
    <ModelLab
      stageId={stageId}
      drawing={state.drawing}
      source={state.source}
      drawings={state.drawings}
      corpusFiles={state.corpusFiles}
      offlineReason={state.reason}
    />
  );
}
