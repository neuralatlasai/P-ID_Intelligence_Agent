import { describe, expect, it } from "vitest";
import {
  buildAdjacency,
  demoSignal,
  drawing,
  equipmentNeighbours,
  traceConnections,
  parseDrawing,
} from "@/lib/canvas/model";

describe("source graph exploration", () => {
  it("preserves directed edges without creating reverse paths", () => {
    const nodes = drawing.nodes.slice(0, 2);
    const graph = buildAdjacency(
      nodes,
      [{ source: nodes[0]!.id, target: nodes[1]!.id }],
      true,
    );
    expect(traceConnections(graph, nodes[0]!.id).size).toBe(2);
    expect(traceConnections(graph, nodes[1]!.id).size).toBe(1);
  });
  it("terminates on cycles, preserves shortest depth and excludes disconnected objects", () => {
    const graph = new Map([
      ["a", ["b", "c"]],
      ["b", ["a", "c"]],
      ["c", ["a", "b", "d"]],
      ["d", ["c"]],
      ["isolated", []],
    ]);
    expect([...traceConnections(graph, "a")]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 1],
      ["d", 2],
    ]);
    expect(traceConnections(graph, "missing").size).toBe(0);
  });

  it("indexes all fixture edges symmetrically without inventing flow direction", () => {
    const index = buildAdjacency(drawing.nodes, drawing.edges);
    expect(index.size).toBe(drawing.nodes.length);
    for (const edge of drawing.edges) {
      expect(index.get(edge.source)).toContain(edge.target);
      expect(index.get(edge.target)).toContain(edge.source);
    }
  });

  it("keeps every object within the source image coordinate system", () => {
    for (const node of drawing.nodes) {
      expect(node.x - node.width / 2).toBeGreaterThanOrEqual(0);
      expect(node.y - node.height / 2).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width / 2).toBeLessThanOrEqual(drawing.width);
      expect(node.y + node.height / 2).toBeLessThanOrEqual(drawing.height);
    }
  });
});

describe("backend canvas boundary", () => {
  const valid = { ...drawing, imagePath: "PID2Graph OPEN100/0.png" };
  it("accepts source geometry and rejects duplicate IDs, dangling edges and invalid bounds", () => {
    expect(parseDrawing(valid)).toBeDefined();
    expect(
      parseDrawing({ ...valid, nodes: [valid.nodes[0], valid.nodes[0]] }),
    ).toBeUndefined();
    expect(
      parseDrawing({ ...valid, edges: [{ source: "missing", target: "missing" }] }),
    ).toBeUndefined();
    expect(parseDrawing({ ...valid, width: Infinity })).toBeUndefined();
    expect(parseDrawing({ ...valid, unpositioned: -1 })).toBeUndefined();
    expect(
      parseDrawing({ ...valid, nodes: [{ ...valid.nodes[0], width: valid.width * 2 }] }),
    ).toBeUndefined();
  });
});

describe("dimensionless demonstration signal", () => {
  it("is deterministic and bounded even for invalid inputs", () => {
    for (const time of [-1, 0, 23, 3600, Infinity, NaN]) {
      for (const setting of [-100, 0, 50, 100, 200, Infinity, NaN]) {
        const value = demoSignal(time, setting);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
        expect(demoSignal(time, setting)).toBe(value);
      }
    }
  });
});

describe("equipmentNeighbours", () => {
  /**
   * A short chain of the shape every P&ID graph has: equipment joined to equipment through
   * the connectors and crossings the draughtsman used to draw the line.
   *
   *   valve1 — connector1 — connector2 — valve2
   *                      \
   *                       crossing1 — tank1
   */
  const index = buildAdjacency(
    [
      { id: "valve1", kind: "valve", x: 0, y: 0, width: 4, height: 4 },
      { id: "connector1", kind: "connector", x: 1, y: 0, width: 4, height: 4 },
      { id: "connector2", kind: "connector", x: 2, y: 0, width: 4, height: 4 },
      { id: "valve2", kind: "valve", x: 3, y: 0, width: 4, height: 4 },
      { id: "crossing1", kind: "crossing", x: 2, y: 1, width: 4, height: 4 },
      { id: "tank1", kind: "tank", x: 2, y: 2, width: 4, height: 4 },
    ],
    [
      { source: "valve1", target: "connector1" },
      { source: "connector1", target: "connector2" },
      { source: "connector2", target: "valve2" },
      { source: "connector1", target: "crossing1" },
      { source: "crossing1", target: "tank1" },
    ],
  );

  const isEquipment = (id: string): boolean =>
    id.startsWith("valve") || id.startsWith("tank");

  it("reports the equipment reached through the drafting apparatus", () => {
    // The raw neighbour is connector1, which tells an engineer nothing.
    expect(index.get("valve1")).toEqual(["connector1"]);

    expect(equipmentNeighbours(index, isEquipment, "valve1")).toEqual([
      { id: "valve2", hops: 3 },
      { id: "tank1", hops: 3 },
    ]);
  });

  it("stops at the first equipment on a path", () => {
    // Nothing beyond valve2 belongs to valve1: it belongs to valve2.
    const chain = buildAdjacency(
      [
        { id: "valve1", kind: "valve", x: 0, y: 0, width: 1, height: 1 },
        { id: "connector1", kind: "connector", x: 1, y: 0, width: 1, height: 1 },
        { id: "valve2", kind: "valve", x: 2, y: 0, width: 1, height: 1 },
        { id: "valve3", kind: "valve", x: 3, y: 0, width: 1, height: 1 },
      ],
      [
        { source: "valve1", target: "connector1" },
        { source: "connector1", target: "valve2" },
        { source: "valve2", target: "valve3" },
      ],
    );

    expect(equipmentNeighbours(chain, isEquipment, "valve1")).toEqual([
      { id: "valve2", hops: 2 },
    ]);
  });

  it("returns nothing for an object the graph does not hold", () => {
    expect(equipmentNeighbours(index, isEquipment, "nope")).toEqual([]);
  });

  it("returns nothing when only apparatus is reachable", () => {
    const stub = buildAdjacency(
      [
        { id: "valve1", kind: "valve", x: 0, y: 0, width: 1, height: 1 },
        { id: "connector1", kind: "connector", x: 1, y: 0, width: 1, height: 1 },
      ],
      [{ source: "valve1", target: "connector1" }],
    );

    expect(equipmentNeighbours(stub, isEquipment, "valve1")).toEqual([]);
  });

  it("honours the bound on a densely connected object", () => {
    const nodes = [{ id: "hub", kind: "valve", x: 0, y: 0, width: 1, height: 1 }];
    const edges: { source: string; target: string }[] = [];
    for (let n = 0; n < 40; n += 1) {
      nodes.push({ id: `valve${n}`, kind: "valve", x: n, y: 1, width: 1, height: 1 });
      edges.push({ source: "hub", target: `valve${n}` });
    }

    expect(
      equipmentNeighbours(buildAdjacency(nodes, edges), isEquipment, "hub", 5),
    ).toHaveLength(5);
  });
});
