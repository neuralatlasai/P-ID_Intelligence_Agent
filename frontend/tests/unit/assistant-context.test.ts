import { describe, expect, it } from "vitest";

import {
  ASSISTANT_CONTEXT_START,
  buildCanvasAssistantContext,
  stripWorkspaceContext,
  withWorkspaceContext,
} from "@/lib/canvas/assistant-context";
import type { CanvasDrawing } from "@/lib/canvas/model";

const DRAWING: CanvasDrawing = {
  source: "area/example.graphml",
  imagePath: "area/example.png",
  width: 1000,
  height: 600,
  directed: false,
  nodes: [
    { id: "valve1", kind: "valve", x: 100, y: 100, width: 20, height: 20 },
    { id: "connector1", kind: "connector", x: 150, y: 100, width: 10, height: 10 },
    { id: "pump1", kind: "pump", x: 200, y: 100, width: 30, height: 30 },
  ],
  edges: [
    { source: "valve1", target: "connector1", style: "solid" },
    { source: "connector1", target: "pump1", style: "solid" },
  ],
};

describe("canvas assistant context", () => {
  it("summarises detections and reaches equipment through drafting nodes", () => {
    const selected = DRAWING.nodes[0]!;
    const context = buildCanvasAssistantContext(DRAWING, selected, "FV-101");

    expect(context.classCounts).toEqual([
      { label: "connector", count: 1, equipment: false },
      { label: "pump", count: 1, equipment: true },
      { label: "valve", count: 1, equipment: true },
    ]);
    expect(context.selected.printedTag).toBe("FV-101");
    expect(context.selected.incidentConnections).toBe(1);
    expect(context.selected.reachableObjects).toBe(2);
    expect(context.selected.relatedEquipment).toEqual([
      { id: "pump1", kind: "pump", hops: 2 },
    ]);
  });

  it("adds machine context while keeping the visible question recoverable", () => {
    const context = buildCanvasAssistantContext(DRAWING, DRAWING.nodes[0]!);
    const visible = "Explain this valve for a new operator.";
    const submitted = withWorkspaceContext(visible, context);

    expect(submitted).toContain(ASSISTANT_CONTEXT_START);
    expect(submitted).toContain("Selected source node: valve1");
    expect(submitted).toContain("Detected classes:");
    expect(stripWorkspaceContext(submitted)).toBe(visible);
  });

  it("anchors a simulated asset on its source node and keeps positions out", () => {
    const context = buildCanvasAssistantContext(DRAWING, DRAWING.nodes[0]!, undefined, {
      hierarchy: "Site > Area 10 > Unit 100 > Main Steam System > example.png",
      asset: {
        tag: "FCV-1012",
        name: "Flow Control Valve",
        description: "Modulating flow control valve.",
        status: "In service",
        loop: "1012",
        loopPartner: "FIT-1012 Flow Indicating Transmitter",
        lines: ['6"-MS-1001-D1B'],
        joined: [{ tag: "P-101A", name: "Centrifugal Pump", hops: 2 }],
        failureModes: ["FTC Failure to close on demand"],
      },
    });
    const submitted = withWorkspaceContext("Explain FCV-1012.", context);

    expect(submitted).toContain("Selected asset: FCV-1012");
    expect(submitted).toContain("Control loop 1012 with FIT-1012");
    expect(submitted).toContain('6"-MS-1001-D1B');
    // A simulated tag sent without an anchor is searched for on the drawing, not found, and
    // reported as missing. The node id is how the agent finds the component instead.
    expect(submitted).toContain("The selected component is source node valve1");
    expect(submitted).toContain("do not report it as missing");
    // Positions stay out of the standing context; they invite answers that describe a
    // component by where it is drawn.
    expect(submitted).not.toMatch(/Selected bounds|centre \(/);
    expect(stripWorkspaceContext(submitted)).toBe("Explain FCV-1012.");
  });

  it("does not strip incomplete or user-authored marker text", () => {
    const text = `Keep this ${ASSISTANT_CONTEXT_START} in my question`;
    expect(stripWorkspaceContext(text)).toBe(text);
  });
});
