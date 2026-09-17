import { describe, expect, it } from "vitest";

import { buildPlantRegister } from "@/lib/canvas/engineering";
import { groupCounts, groupOf } from "@/lib/canvas/groups";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";

const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
const register = buildPlantRegister(drawing, adjacency, 0, new Set(["tank67"]));

describe("function groups", () => {
  it("accounts for every node exactly once", () => {
    const counts = groupCounts(drawing.nodes, register);
    expect(counts.reduce((sum, { count }) => sum + count, 0)).toBe(drawing.nodes.length);
  });

  it("separates transmitters from gauges and control valves from manual valves", () => {
    for (const node of drawing.nodes) {
      const asset = register.assets.get(node.id);
      const group = groupOf(node, register).id;
      if (!asset) expect(group).toBe("piping");
      else if (/Transmitter$/.test(asset.name)) expect(group).toBe("transmitter");
      else if (asset.category === "instrument") expect(group).toBe("indicator");
      else expect(group).toBe(asset.category);
    }
    expect(
      groupOf(
        drawing.nodes.find((n) => n.id === "tank67")!,
        register,
      ).id,
    ).toBe("exchanger");
  });
});
