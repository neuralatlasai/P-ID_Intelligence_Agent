import * as THREE from "three";

/**
 * Procedural models for every field scene, one builder per detection id.
 *
 * Each model is built from primitives, in metres, laid out as the photograph shows the
 * equipment — so a part is where an engineer who has just looked at the photo expects it —
 * and every pickable part carries the id of its detection box. Parts the photograph does not
 * show are not modelled: a manway that is not in the picture would be geometry the twin made
 * up. Context that is not a detection (a skid, a plinth, pipe stands) is built separately
 * and is never pickable.
 *
 * The module holds geometry only. It imports no DOM and no renderer, so the unit tests build
 * every part of every model in Node and check the ids against the scenes.
 */

/**
 * Material role. Every part sits on one of exactly three neutral steps, grouped by what the
 * part is made of; the colours come from the `--scene-material*` tokens in the renderer.
 */
export type Tone = "structure" | "body" | "machined";

export type MaterialFor = (tone: Tone) => THREE.Material;
export type PartBuilder = (group: THREE.Group, material: MaterialFor) => void;

export interface ModelSpec {
  /** Detection id → geometry. */
  readonly parts: Readonly<Record<string, PartBuilder>>;
  /** Non-pickable context: skid, plinth, pipe stands. */
  readonly context?: PartBuilder;
  /** Camera home and orbit target, metres. */
  readonly camera: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  /** Orbit distance limits. */
  readonly distance: readonly [number, number];
  /** Floor height, where the reference grid sits. */
  readonly floor: number;
  /** Half-extent of the shadow frustum, sized to the model. */
  readonly extent: number;
  /** Short description for the text alternative. */
  readonly subject: string;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────────────────────────────────

type Axis = "x" | "y" | "z";

const cylinder = (
  radius: number,
  length: number,
  material: THREE.Material,
  axis: Axis = "y",
) => {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 36),
    material,
  );
  if (axis === "x") mesh.rotation.z = Math.PI / 2;
  if (axis === "z") mesh.rotation.x = Math.PI / 2;
  return mesh;
};

const cone = (top: number, bottom: number, length: number, material: THREE.Material) =>
  new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, length, 36), material);

const box = (x: number, y: number, z: number, material: THREE.Material) =>
  new THREE.Mesh(new THREE.BoxGeometry(x, y, z), material);

const at = <T extends THREE.Object3D>(object: T, x: number, y: number, z = 0): T => {
  object.position.set(x, y, z);
  return object;
};

/** A 2:1 semi-elliptical head of radius r, opening down (`up`) or up (`down`). */
function head(radius: number, material: THREE.Material, facing: "up" | "down") {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2),
    material,
  );
  mesh.scale.set(1, facing === "up" ? 0.5 : -0.5, 1);
  return mesh;
}

/** A ring of bolt heads on a flange face, around an axis. */
function boltRing(
  group: THREE.Group,
  material: THREE.Material,
  axis: Axis,
  centre: readonly [number, number, number],
  radius: number,
  count: number,
  length: number,
) {
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const a = Math.cos(angle) * radius;
    const b = Math.sin(angle) * radius;
    const bolt = cylinder(radius * 0.08 + 0.008, length, material, axis);
    if (axis === "x") at(bolt, centre[0], centre[1] + a, centre[2] + b);
    else if (axis === "y") at(bolt, centre[0] + a, centre[1], centre[2] + b);
    else at(bolt, centre[0] + a, centre[1] + b, centre[2]);
    group.add(bolt);
  }
}

/** A bolted flange pair on a pipe axis, at a position along it. */
function flangePair(
  group: THREE.Group,
  material: MaterialFor,
  axis: Axis,
  centre: readonly [number, number, number],
  radius: number,
  thickness: number,
  bolts = 12,
) {
  const offset = (d: number): [number, number, number] =>
    axis === "x"
      ? [centre[0] + d, centre[1], centre[2]]
      : axis === "y"
        ? [centre[0], centre[1] + d, centre[2]]
        : [centre[0], centre[1], centre[2] + d];
  for (const d of [-thickness / 2 - 0.004, thickness / 2 + 0.004]) {
    const disc = cylinder(radius, thickness, material("machined"), axis);
    const [x, y, z] = offset(d);
    group.add(at(disc, x, y, z));
  }
  boltRing(
    group,
    material("structure"),
    axis,
    centre,
    radius * 0.8,
    bolts,
    thickness * 2.6,
  );
}

/**
 * Place a builder on a vessel wall: the callback works in a frame whose +x points radially
 * out from the vessel axis at the given azimuth (0 = +x, π/2 = toward the camera on +z).
 */
function onWall(group: THREE.Group, azimuth: number, build: (frame: THREE.Group) => void) {
  const frame = new THREE.Group();
  frame.rotation.y = -azimuth;
  build(frame);
  group.add(frame);
}

/** A tube along a smooth path — cable and small-bore tubing. */
function tube(
  points: readonly [number, number, number][],
  radius: number,
  material: THREE.Material,
) {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  );
  return new THREE.Mesh(new THREE.TubeGeometry(curve, 48, radius, 10, false), material);
}

/** A straight pipe run along x, between two stations. */
function pipeRun(
  group: THREE.Group,
  material: MaterialFor,
  from: number,
  to: number,
  radius: number,
  y = 0,
) {
  group.add(
    at(
      cylinder(radius, Math.abs(to - from), material("machined"), "x"),
      (from + to) / 2,
      y,
    ),
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Heat exchanger — the original skid
// ────────────────────────────────────────────────────────────────────────────────────────────

/** A gate valve: body, bonnet, stem and handwheel, oriented along a pipe axis. */
function handValve(group: THREE.Group, material: MaterialFor, pipeAxis: "x" | "y") {
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 16), material("body"));
  body.scale.set(pipeAxis === "x" ? 1.25 : 1, pipeAxis === "y" ? 1.25 : 1, 1);
  group.add(body);
  for (const side of [-1, 1]) {
    const flange = cylinder(0.3, 0.06, material("machined"), pipeAxis);
    if (pipeAxis === "x") flange.position.x = side * 0.32;
    else flange.position.y = side * 0.32;
    group.add(flange);
  }
  // The bonnet stands off the pipe on z for a vertical pipe, on y for a horizontal one.
  const bonnet = cylinder(0.1, 0.42, material("body"), pipeAxis === "x" ? "y" : "z");
  const wheel = new THREE.Mesh(
    new THREE.TorusGeometry(0.24, 0.035, 10, 32),
    material("structure"),
  );
  if (pipeAxis === "x") {
    group.add(at(bonnet, 0, 0.34));
    wheel.rotation.x = Math.PI / 2;
    group.add(at(wheel, 0, 0.58));
  } else {
    group.add(at(bonnet, 0, 0, 0.34));
    group.add(at(wheel, 0, 0, 0.58));
  }
}

function saddle(group: THREE.Group, material: MaterialFor, x: number) {
  group.add(at(box(0.22, 1.25, 1.5, material("structure")), x, -1.0));
  group.add(at(box(0.6, 0.08, 1.8, material("structure")), x, -1.62));
}

const EXCHANGER: ModelSpec = {
  subject: "the shell-and-tube exchanger skid",
  camera: [5.5, 4.6, 13.5],
  target: [-0.4, 0.2, 0],
  distance: [5, 30],
  floor: -1.83,
  extent: 9,
  context: (group, material) => {
    // The skid is context, not a part: it is under everything and names nothing.
    const skid = at(box(11.5, 0.16, 3.2, material("structure")), -0.4, -1.74);
    group.add(skid);
  },
  parts: {
    D1: (group, material) => {
      group.add(at(cylinder(0.85, 5.2, material("body"), "x"), -0.3, 0));
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(0.85, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2),
        material("body"),
      );
      cap.rotation.z = Math.PI / 2;
      cap.scale.set(0.45, 1, 1);
      group.add(at(cap, -2.9, 0));
      for (const x of [-1.4, 0.9])
        group.add(at(cylinder(0.88, 0.05, material("machined"), "x"), x, 0));
    },
    D2: (group, material) => {
      group.add(at(cylinder(1.02, 0.12, material("machined"), "x"), 2.36, 0));
      group.add(at(cylinder(0.86, 0.9, material("body"), "x"), 2.86, 0));
      group.add(at(cylinder(1.02, 0.12, material("machined"), "x"), 3.36, 0));
      boltRing(group, material("structure"), "x", [2.36, 0, 0], 0.95, 20, 0.3);
    },
    D3: (group, material) => {
      group.add(at(cylinder(0.2, 0.7, material("body")), 1.2, 1.1));
      group.add(at(cylinder(0.32, 0.08, material("machined")), 1.2, 1.46));
    },
    D4: (group, material) => {
      group.add(at(cylinder(0.18, 0.6, material("body")), 1.5, -1.05));
      group.add(at(cylinder(0.3, 0.08, material("machined")), 1.5, -1.36));
    },
    D5: (group, material) => {
      group.add(at(cylinder(0.2, 0.5, material("machined")), 1.2, 1.75));
      const holder = at(new THREE.Group(), 1.2, 2.32);
      handValve(holder, material, "y");
      group.add(holder);
      group.add(at(cylinder(0.2, 0.9, material("machined")), 1.2, 3.0));
    },
    D6: (group, material) => {
      group.add(at(cylinder(0.16, 2.2, material("machined")), -5.2, 1.1));
      const holder = at(new THREE.Group(), -5.2, 1.3);
      handValve(holder, material, "y");
      group.add(holder);
    },
    D7: (group, material) => {
      const holder = at(new THREE.Group(), 3.9, -2.05);
      handValve(holder, material, "x");
      group.add(holder);
      group.add(at(cylinder(0.18, 0.9, material("machined"), "x"), 4.8, -2.05));
    },
    D8: (group, material) => {
      group.add(at(cylinder(0.04, 0.5, material("machined")), 2.86, 1.1));
      group.add(at(cylinder(0.2, 0.08, material("machined"), "z"), 2.86, 1.5, 0.02));
      group.add(
        at(
          new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.025, 8, 28), material("body")),
          2.86,
          1.5,
          0.07,
        ),
      );
    },
    D9: (group, material) => {
      group.add(at(cylinder(0.04, 0.3, material("machined")), -2.0, 0.98));
      group.add(at(box(0.26, 0.2, 0.18, material("structure")), -2.0, 1.22));
      group.add(at(cylinder(0.1, 0.1, material("machined"), "z"), -2.0, 1.22, 0.12));
    },
    D10: (group, material) => saddle(group, material, -1.9),
    D11: (group, material) => saddle(group, material, 1.2),
    D12: (group, material) => {
      group.add(at(cylinder(0.2, 2.0, material("machined"), "x"), -4.2, 0));
      group.add(at(cylinder(0.32, 0.08, material("machined"), "x"), -3.24, 0));
      const elbow = new THREE.Mesh(
        new THREE.TorusGeometry(0.2, 0.17, 12, 24, Math.PI / 2),
        material("machined"),
      );
      elbow.rotation.z = Math.PI;
      group.add(at(elbow, -5.2, 0.0));
    },
    D13: (group, material) => {
      group.add(at(cylinder(0.18, 0.55, material("machined")), 1.5, -1.68));
      group.add(at(cylinder(0.18, 2.1, material("machined"), "x"), 2.5, -2.05));
    },
  },
};

// ────────────────────────────────────────────────────────────────────────────────────────────
// Vertical vessels
// ────────────────────────────────────────────────────────────────────────────────────────────

/** A radial nozzle on a vessel wall, with its flange and a stub of connecting pipe. */
function wallNozzle(
  group: THREE.Group,
  material: MaterialFor,
  shellRadius: number,
  azimuth: number,
  y: number,
  bore: number,
  reach: number,
  pipe: number,
) {
  onWall(group, azimuth, (frame) => {
    const out = shellRadius + reach;
    frame.add(
      at(
        cylinder(bore, reach + 0.1, material("body"), "x"),
        shellRadius + reach / 2 - 0.05,
        y,
      ),
    );
    flangePair(frame, material, "x", [out, y, 0], bore * 1.7, 0.06, 12);
    if (pipe > 0)
      frame.add(
        at(cylinder(bore, pipe, material("machined"), "x"), out + pipe / 2 + 0.05, y),
      );
  });
}

/** Knock-out drum `tank70`: ID 1.5 m, T/T 2.6 m, on four legs. */
const KNOCKOUT_DRUM: ModelSpec = (() => {
  const R = 0.75;
  const T = 2.6;
  const legFoot = -1.6;
  return {
    subject: "the knock-out drum",
    camera: [5.4, 3.4, 9.6],
    target: [0, 1.0, 0],
    distance: [3.5, 24],
    floor: legFoot,
    extent: 6,
    parts: {
      K1: (group, material) => {
        group.add(at(cylinder(R, T, material("body")), 0, T / 2));
        group.add(at(head(R, material("body"), "up"), 0, T));
        group.add(at(head(R, material("body"), "down"), 0, 0));
        group.add(at(cylinder(R + 0.008, 0.02, material("machined")), 0, 0.02));
        group.add(at(cylinder(R + 0.008, 0.02, material("machined")), 0, T - 0.02));
      },
      K2: (group, material) => {
        group.add(at(cylinder(0.22, 0.6, material("body")), 0, T + 0.62));
        flangePair(group, material, "y", [0, T + 0.9, 0], 0.4, 0.07, 12);
        group.add(at(cylinder(0.18, 1.4, material("machined")), 0, T + 1.65));
      },
      K3: (group, material) =>
        wallNozzle(group, material, R, Math.PI, T * 0.55, 0.28, 0.55, 2.0),
      K4: (group, material) => {
        // Shoulder nozzle, elbow up, spring relief valve with side discharge and lever.
        onWall(group, Math.PI * 0.12, (frame) => {
          const y0 = T * 0.82;
          const x = R + 0.42;
          frame.add(at(cylinder(0.06, 0.46, material("body"), "x"), R + 0.2, y0));
          frame.add(at(cylinder(0.1, 0.04, material("machined"), "x"), R + 0.05, y0));
          frame.add(at(cylinder(0.06, 0.6, material("machined")), x, y0 + 0.28));
          frame.add(at(cylinder(0.12, 0.05, material("machined")), x, y0 + 0.6));
          frame.add(at(cylinder(0.11, 0.4, material("body")), x, y0 + 0.82));
          frame.add(at(cylinder(0.07, 0.3, material("body"), "x"), x - 0.22, y0 + 0.82));
          frame.add(
            at(cylinder(0.12, 0.04, material("machined"), "x"), x - 0.38, y0 + 0.82),
          );
          frame.add(at(cylinder(0.12, 0.05, material("machined")), x, y0 + 1.04));
          frame.add(at(cylinder(0.085, 0.62, material("body")), x, y0 + 1.36));
          frame.add(at(cylinder(0.06, 0.12, material("body")), x, y0 + 1.72));
          frame.add(at(box(0.04, 0.34, 0.05, material("structure")), x + 0.14, y0 + 1.58));
        });
      },
      K5: (group, material) => {
        for (const angle of [
          Math.PI * 0.25,
          Math.PI * 0.75,
          Math.PI * 1.25,
          Math.PI * 1.75,
        ]) {
          const x = Math.cos(angle) * (R + 0.02);
          const z = Math.sin(angle) * (R + 0.02);
          const top = 0.55;
          group.add(
            at(
              box(0.14, top - legFoot, 0.14, material("structure")),
              x,
              (top + legFoot) / 2,
              z,
            ),
          );
          group.add(at(box(0.36, 0.04, 0.36, material("structure")), x, legFoot + 0.02, z));
        }
      },
      K6: (group, material) => {
        const bottom = -R / 2;
        group.add(at(cylinder(0.06, 0.3, material("body")), 0, bottom - 0.12));
        group.add(at(cylinder(0.11, 0.04, material("machined")), 0, bottom - 0.28));
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(0.11, 20, 14),
          material("body"),
        );
        group.add(at(ball, 0, bottom - 0.46));
        group.add(at(cylinder(0.11, 0.04, material("machined")), 0, bottom - 0.64));
        group.add(
          at(box(0.42, 0.03, 0.04, material("structure")), 0.24, bottom - 0.46, 0.06),
        );
        group.add(at(cylinder(0.05, 0.4, material("machined")), 0, bottom - 0.86));
      },
    },
  };
})();

// ────────────────────────────────────────────────────────────────────────────────────────────
// Valves
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Two pipe stands under a horizontal line: context, not parts. */
const pipeStands =
  (xs: readonly number[], floor: number, pipeBottom: number): PartBuilder =>
  (group, material) => {
    for (const x of xs) {
      group.add(
        at(
          box(0.36, pipeBottom - floor, 0.36, material("structure")),
          x,
          (pipeBottom + floor) / 2,
        ),
      );
    }
  };

/** Globe control valve `valve43` on a horizontal line; pipe axis on x at y = 0. */
const CONTROL_VALVE: ModelSpec = (() => {
  const pipe = 0.17;
  const floor = -0.95;
  return {
    subject: "the globe control valve",
    camera: [2.6, 1.9, 5.4],
    target: [0, 0.55, 0],
    distance: [1.8, 14],
    floor,
    extent: 3.5,
    context: pipeStands([-2.0, 2.0], floor, -pipe),
    parts: {
      C1: (group, material) => {
        const body = new THREE.Mesh(
          new THREE.SphereGeometry(0.34, 28, 18),
          material("body"),
        );
        body.scale.set(1.25, 1, 1);
        group.add(body);
        group.add(at(cylinder(0.2, 0.9, material("body"), "x"), 0, 0));
        group.add(at(cylinder(0.14, 0.34, material("body")), 0, 0.42));
        flangePair(group, material, "y", [0, 0.52, 0], 0.3, 0.07, 10);
        group.add(at(cylinder(0.11, 0.16, material("body")), 0, 0.66));
      },
      C2: (group, material) => {
        const y = 1.72;
        group.add(at(cone(0.62, 0.36, 0.2, material("body")), 0, y - 0.12));
        group.add(at(head(0.62, material("body"), "up"), 0, y));
        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(0.64, 0.035, 10, 48),
          material("body"),
        );
        rim.rotation.x = Math.PI / 2;
        group.add(at(rim, 0, y));
        boltRing(group, material("structure"), "y", [0, y, 0], 0.64, 16, 0.08);
        const eye = new THREE.Mesh(
          new THREE.TorusGeometry(0.05, 0.015, 8, 20),
          material("structure"),
        );
        group.add(at(eye, 0, y + 0.37));
      },
      C3: (group, material) => {
        for (const x of [-0.16, 0.16])
          group.add(at(box(0.07, 0.72, 0.12, material("body")), x, 1.1));
        group.add(at(cylinder(0.2, 0.08, material("body")), 0, 1.48));
        group.add(at(cylinder(0.14, 0.06, material("body")), 0, 0.76));
        group.add(at(cylinder(0.028, 0.8, material("machined")), 0, 1.1));
        group.add(at(box(0.1, 0.08, 0.08, material("machined")), 0, 1.02));
        group.add(at(box(0.12, 0.02, 0.03, material("machined")), 0.1, 1.02, 0.03));
      },
      C4: (group, material) => {
        group.add(at(box(0.42, 0.4, 0.22, material("structure")), 0.5, 1.12, 0.02));
        // Mounting bracket from the yoke leg to the positioner case.
        group.add(at(box(0.12, 0.2, 0.03, material("structure")), 0.24, 1.12, 0.0));
        for (const y of [1.2, 1.02]) {
          group.add(at(cylinder(0.06, 0.04, material("machined"), "x"), 0.74, y, 0.02));
        }
        // Instrument tubing to the diaphragm casing.
        group.add(
          tube(
            [
              [0.46, 1.33, 0.02],
              [0.46, 1.45, 0.02],
              [0.52, 1.58, 0.0],
            ],
            0.012,
            material("machined"),
          ),
        );
        group.add(
          tube(
            [
              [0.6, 0.92, 0.02],
              [0.66, 0.78, 0.02],
              [0.9, 0.76, 0.0],
              [1.3, 0.76, -0.05],
            ],
            0.012,
            material("machined"),
          ),
        );
      },
      C5: (group, material) => {
        flangePair(group, material, "x", [-0.5, 0, 0], 0.32, 0.07, 12);
        pipeRun(group, material, -0.54, -2.8, pipe);
      },
      C6: (group, material) => {
        flangePair(group, material, "x", [0.5, 0, 0], 0.32, 0.07, 12);
        pipeRun(group, material, 0.54, 2.8, pipe);
      },
    },
  };
})();

/** Handwheel gate valve `valve38` on a horizontal line; pipe axis on x at y = 0. */
const GATE_VALVE: ModelSpec = (() => {
  const pipe = 0.17;
  const floor = -0.95;
  return {
    subject: "the handwheel gate valve",
    camera: [2.4, 1.6, 4.8],
    target: [0, 0.45, 0],
    distance: [1.6, 14],
    floor,
    extent: 3.5,
    context: pipeStands([-2.0, 2.0], floor, -pipe),
    parts: {
      G1: (group, material) => {
        const body = cylinder(0.27, 0.62, material("body"));
        body.scale.set(1, 1, 0.72);
        group.add(at(body, 0, -0.02));
        const belly = new THREE.Mesh(
          new THREE.SphereGeometry(0.27, 24, 14, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
          material("body"),
        );
        belly.scale.set(1, 0.5, 0.72);
        group.add(at(belly, 0, -0.33));
        group.add(at(cylinder(0.2, 0.84, material("body"), "x"), 0, 0));
        for (const x of [-0.42, 0.42]) {
          group.add(at(cylinder(0.33, 0.07, material("body"), "x"), x, 0));
        }
        boltRing(group, material("structure"), "x", [-0.42, 0, 0], 0.27, 8, 0.12);
        boltRing(group, material("structure"), "x", [0.42, 0, 0], 0.27, 8, 0.12);
      },
      G2: (group, material) => {
        flangePair(group, material, "y", [0, 0.34, 0], 0.3, 0.06, 10);
        const dome = head(0.24, material("body"), "up");
        dome.scale.set(1, 0.9, 0.9);
        group.add(at(dome, 0, 0.38));
        group.add(at(cylinder(0.1, 0.16, material("body")), 0, 0.64));
      },
      G3: (group, material) => {
        for (const x of [-0.1, 0.1])
          group.add(at(box(0.06, 0.52, 0.08, material("body")), x, 0.98));
        group.add(at(box(0.3, 0.07, 0.14, material("body")), 0, 1.26));
        group.add(at(cylinder(0.024, 1.3, material("machined")), 0, 1.25));
      },
      G4: (group, material) => {
        const y = 1.36;
        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(0.42, 0.03, 10, 48),
          material("structure"),
        );
        rim.rotation.x = Math.PI / 2;
        group.add(at(rim, 0, y));
        group.add(at(cylinder(0.06, 0.08, material("structure")), 0, y));
        for (let index = 0; index < 5; index += 1) {
          const spoke = box(0.42, 0.025, 0.03, material("structure"));
          spoke.rotation.y = (index / 5) * Math.PI * 2;
          spoke.position.set(
            Math.cos((index / 5) * Math.PI * 2) * 0.21,
            y,
            -Math.sin((index / 5) * Math.PI * 2) * 0.21,
          );
          group.add(spoke);
        }
      },
      G5: (group, material) => {
        group.add(at(cylinder(0.33, 0.07, material("machined"), "x"), -0.5, 0));
        pipeRun(group, material, -0.54, -2.8, pipe);
      },
      G6: (group, material) => {
        group.add(at(cylinder(0.33, 0.07, material("machined"), "x"), 0.5, 0));
        pipeRun(group, material, 0.54, 2.8, pipe);
      },
    },
  };
})();

// ────────────────────────────────────────────────────────────────────────────────────────────
// Instruments
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Electromagnetic flowmeter `instrumentation31`, inline on a horizontal line. */
const FLOWMETER: ModelSpec = (() => {
  const pipe = 0.17;
  const floor = -0.95;
  return {
    subject: "the electromagnetic flowmeter",
    camera: [2.1, 1.35, 4.1],
    target: [0, 0.35, 0],
    distance: [1.4, 12],
    floor,
    extent: 3,
    context: pipeStands([-1.4, 1.4], floor, -pipe),
    parts: {
      F1: (group, material) => {
        group.add(at(cylinder(0.3, 0.64, material("body"), "x"), 0, 0));
        group.add(at(cylinder(0.24, 0.8, material("body"), "x"), 0, 0));
      },
      F2: (group, material) => {
        const y = 0.98;
        group.add(at(box(0.3, 0.3, 0.26, material("body")), -0.12, y));
        group.add(at(cylinder(0.2, 0.2, material("body"), "z"), 0.04, y, 0.02));
        const bezel = new THREE.Mesh(
          new THREE.TorusGeometry(0.19, 0.035, 10, 36),
          material("machined"),
        );
        group.add(at(bezel, 0.04, y, 0.13));
        group.add(at(cylinder(0.14, 0.01, material("machined"), "z"), 0.04, y, 0.125));
      },
      F3: (group, material) => {
        group.add(at(cylinder(0.08, 0.5, material("body")), 0, 0.53));
        group.add(at(cylinder(0.16, 0.04, material("machined")), 0, 0.66));
        boltRing(group, material("structure"), "y", [0, 0.66, 0], 0.13, 6, 0.07);
      },
      F4: (group, material) => {
        for (const y of [1.06, 0.92])
          group.add(at(cylinder(0.035, 0.1, material("machined"), "x"), -0.31, y));
        group.add(
          tube(
            [
              [-0.36, 1.06, 0],
              [-0.46, 0.95, 0.02],
              [-0.5, 0.6, 0.05],
              [-0.44, 0.34, 0.08],
            ],
            0.016,
            material("structure"),
          ),
        );
        group.add(
          tube(
            [
              [-0.36, 0.92, 0],
              [-0.42, 0.8, 0.03],
              [-0.45, 0.55, 0.06],
              [-0.4, 0.33, 0.1],
            ],
            0.016,
            material("structure"),
          ),
        );
      },
      F5: (group, material) => {
        flangePair(group, material, "x", [-0.48, 0, 0], 0.36, 0.07, 8);
        pipeRun(group, material, -0.52, -2.4, pipe);
      },
      F6: (group, material) => {
        flangePair(group, material, "x", [0.48, 0, 0], 0.36, 0.07, 8);
        pipeRun(group, material, 0.52, 2.4, pipe);
      },
    },
  };
})();

/**
 * Temperature transmitter `instrumentation25`: head on an extension neck, flanged
 * thermowell, nozzle on a weld boss, on a section of clad insulated pipe along x.
 */
const TEMPERATURE: ModelSpec = (() => {
  const clad = 0.42;
  const floor = -1.0;
  return {
    subject: "the temperature transmitter on its pipe",
    camera: [2.3, 1.9, 4.4],
    target: [0, 0.75, 0],
    distance: [1.4, 12],
    floor,
    extent: 3,
    context: pipeStands([-1.8, 1.8], floor, -clad),
    parts: {
      T6: (group, material) => {
        group.add(at(cylinder(clad, 4.4, material("body"), "x"), 0, 0));
        // Cladding bands, as strapped in the photograph.
        for (const x of [-1.1, 1.1]) {
          const band = new THREE.Mesh(
            new THREE.TorusGeometry(clad + 0.006, 0.012, 8, 48),
            material("structure"),
          );
          band.rotation.y = Math.PI / 2;
          group.add(at(band, x, 0));
        }
      },
      T5: (group, material) => {
        const boss = cone(0.07, 0.12, 0.06, material("machined"));
        group.add(at(boss, 0, clad + 0.01));
        group.add(at(cylinder(0.055, 0.3, material("machined")), 0, clad + 0.18));
      },
      T4: (group, material) =>
        flangePair(group, material, "y", [0, clad + 0.37, 0], 0.17, 0.05, 8),
      T3: (group, material) => {
        const base = clad + 0.42;
        // Stem, hex union, threaded lagging extension and sleeve, bottom to top.
        group.add(at(cylinder(0.045, 0.2, material("machined")), 0, base + 0.1));
        const union = new THREE.Mesh(
          new THREE.CylinderGeometry(0.075, 0.075, 0.08, 6),
          material("machined"),
        );
        group.add(at(union, 0, base + 0.24));
        group.add(at(cylinder(0.04, 0.24, material("machined")), 0, base + 0.4));
        group.add(at(cylinder(0.055, 0.1, material("machined")), 0, base + 0.57));
      },
      T1: (group, material) => {
        const y = clad + 1.3; // housing axis; its underside meets the extension sleeve
        group.add(at(cylinder(0.08, 0.06, material("body")), 0, y - 0.23));
        group.add(at(cylinder(0.26, 0.3, material("body"), "z"), 0, y, 0.02));
        group.add(at(box(0.44, 0.42, 0.26, material("body")), 0, y, -0.1));
        const bezel = new THREE.Mesh(
          new THREE.TorusGeometry(0.19, 0.03, 10, 36),
          material("machined"),
        );
        group.add(at(bezel, 0, y, 0.17));
        group.add(at(cylinder(0.16, 0.01, material("machined"), "z"), 0, y, 0.165));
      },
      T2: (group, material) => {
        const y = clad + 1.38;
        group.add(at(cylinder(0.04, 0.12, material("machined"), "x"), 0.28, y));
        group.add(
          tube(
            [
              [0.34, y, 0],
              [0.55, y - 0.05, 0.02],
              [0.75, y - 0.6, 0.05],
              [1.1, clad + 0.15, 0.1],
            ],
            0.022,
            material("structure"),
          ),
        );
      },
    },
  };
})();

/** Radar level transmitter `instrumentation42` on a section of vessel roof. */
const RADAR_LEVEL: ModelSpec = (() => {
  // A shallow dome: sphere of radius 6 cut to a cap 2.1 m across, crown at y = 0.
  const domeRadius = 6;
  const cap = 0.36;
  return {
    subject: "the radar level transmitter on its vessel roof",
    camera: [2.4, 2.0, 4.4],
    target: [0, 0.9, 0],
    distance: [1.5, 12],
    floor: -domeRadius * (1 - Math.cos(cap)) - 0.02,
    extent: 3,
    parts: {
      L1: (group, material) => {
        const roof = new THREE.Mesh(
          new THREE.SphereGeometry(domeRadius, 64, 16, 0, Math.PI * 2, 0, cap),
          material("body"),
        );
        group.add(at(roof, 0, -domeRadius));
      },
      L2: (group, material) => {
        group.add(at(cylinder(0.28, 0.52, material("body")), 0, 0.24));
        const weld = new THREE.Mesh(
          new THREE.TorusGeometry(0.29, 0.02, 8, 36),
          material("machined"),
        );
        weld.rotation.x = Math.PI / 2;
        group.add(at(weld, 0, 0.01));
      },
      L3: (group, material) =>
        flangePair(group, material, "y", [0, 0.56, 0], 0.46, 0.08, 8),
      L4: (group, material) => {
        // Stand-off post from the roof to above the clamp.
        group.add(at(cylinder(0.035, 1.48, material("structure")), 0.62, 0.71));
        group.add(at(box(0.5, 0.06, 0.07, material("structure")), 0.38, 1.3));
        group.add(
          tube(
            [
              [0.42, 2.02, 0],
              [0.6, 1.92, 0.03],
              [0.64, 1.3, 0.05],
              [0.58, 0.72, 0.06],
            ],
            0.018,
            material("structure"),
          ),
        );
      },
      L5: (group, material) => {
        group.add(at(cylinder(0.22, 0.12, material("machined")), 0, 0.68));
        group.add(at(cone(0.12, 0.2, 0.56, material("machined")), 0, 1.02));
        group.add(at(cylinder(0.17, 0.05, material("machined")), 0, 1.32));
      },
      L6: (group, material) => {
        group.add(at(cylinder(0.13, 0.3, material("body")), 0, 1.48));
        group.add(at(cylinder(0.32, 0.36, material("body"), "z"), 0, 1.95));
        group.add(at(box(0.5, 0.5, 0.3, material("body")), 0, 1.95, -0.08));
        const bezel = new THREE.Mesh(
          new THREE.TorusGeometry(0.22, 0.03, 10, 36),
          material("machined"),
        );
        group.add(at(bezel, 0, 1.95, 0.19));
        group.add(at(cylinder(0.2, 0.01, material("machined"), "z"), 0, 1.95, 0.185));
        for (const x of [-0.36, 0.36])
          group.add(at(cylinder(0.045, 0.12, material("machined"), "x"), x, 2.02));
      },
    },
  };
})();

/** Model per scene id. A scene with no entry shows the photo and table without a model. */
export const SCENE_MODELS: Readonly<Record<string, ModelSpec>> = {
  "SCN-EXCHANGER": EXCHANGER,
  "SCN-KO-DRUM": KNOCKOUT_DRUM,
  "SCN-CONTROL-VALVE": CONTROL_VALVE,
  "SCN-GATE-VALVE": GATE_VALVE,
  "SCN-MAGMETER": FLOWMETER,
  "SCN-TEMPERATURE": TEMPERATURE,
  "SCN-RADAR-LEVEL": RADAR_LEVEL,
};

/**
 * Build a model's pickable parts into one root group: one child group per detection id,
 * with every descendant tagged, and a material cache per part so a part's meshes share one
 * material per tone (selection repaints a part as a unit).
 */
export function buildModel(
  spec: ModelSpec,
  createMaterial: (tone: Tone) => THREE.Material,
): { readonly root: THREE.Group; readonly parts: ReadonlyMap<string, THREE.Group> } {
  const root = new THREE.Group();
  const parts = new Map<string, THREE.Group>();
  if (spec.context) {
    const context = new THREE.Group();
    const cache = new Map<Tone, THREE.Material>();
    spec.context(context, (tone) => {
      let material = cache.get(tone);
      if (!material) cache.set(tone, (material = createMaterial(tone)));
      return material;
    });
    context.userData.context = true;
    root.add(context);
  }
  for (const [id, build] of Object.entries(spec.parts)) {
    const group = new THREE.Group();
    const cache = new Map<Tone, THREE.Material>();
    build(group, (tone) => {
      let material = cache.get(tone);
      if (!material) cache.set(tone, (material = createMaterial(tone)));
      return material;
    });
    group.traverse((child) => {
      child.userData.detection = id;
    });
    group.userData.detection = id;
    parts.set(id, group);
    root.add(group);
  }
  return { root, parts };
}

/** Free every geometry and material under a root. */
export function disposeModel(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const material = child.material as THREE.Material | THREE.Material[];
      for (const m of Array.isArray(material) ? material : [material]) materials.add(m);
    }
  });
  for (const material of materials) material.dispose();
}
