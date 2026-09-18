"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import styles from "./DigitalTwin.module.css";

/**
 * Procedural 3D model of the exchanger skid in the field photograph.
 *
 * Every part is built from primitives and tagged with the detection id of the matching box in
 * the photo, so the model, the photo and the drawing share one selection. The layout follows
 * the photo — shell left to right, channel head at the right end, inlet nozzle on top, outlet
 * underneath — so a part is where an engineer who has just looked at the photo expects it.
 *
 * Rendering is on demand: a frame is drawn when the camera moves, the size changes, or the
 * selection or highlight does. Nothing spins in a loop, so an idle twin costs no GPU time.
 */

export type PartTint = "selected" | "hover" | "warn" | "alarm";

/**
 * Surface tones.
 *
 * The scene is technical, not cinematic: the materials are neutral, and one part is told
 * from the next by geometry, edge contrast and the light falling on it — never by hue. The
 * separation that is left is value, and the three steps of that ladder live in tokens.css,
 * so the scene is retuned by editing the token file rather than this component.
 *
 * Every part therefore sits on one of exactly three steps, grouped by what the part is made
 * of. Parts sharing a material role share a value; nothing is interpolated between steps.
 */
type Tone = "structure" | "body" | "machined";

const TONE_TOKEN: Record<Tone, string> = {
  /* Structure, fastening and ancillary hardware: saddles, skid, bolting, handwheels and
     instrument enclosures — everything that carries or clamps rather than contains. */
  structure: "--scene-material-low",
  /* The painted pressure envelope: shells, heads, nozzles, valve bodies, bonnets, bezels. */
  body: "--scene-material",
  /* Bare machined steel and instrument faces: flanges, stems, pipe runs, elbows, dials. */
  machined: "--scene-material-high",
};

/** Finish per material role. Restrained throughout — steel under a work light, not chrome. */
const TONE_FINISH: Record<Tone, { roughness: number; metalness: number }> = {
  structure: { roughness: 0.9, metalness: 0.08 },
  body: { roughness: 0.78, metalness: 0.14 },
  machined: { roughness: 0.62, metalness: 0.24 },
};

/** Read a CSS custom property as a colour. Safe outside a DOM, where it yields the default. */
function tokenColour(name: string): THREE.Color {
  const colour = new THREE.Color();
  try {
    if (typeof document === "undefined") return colour;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (value) colour.setStyle(value);
  } catch {
    // No computed style available: fall back to the THREE default rather than throwing.
  }
  return colour;
}

/** Read a CSS duration token in milliseconds. `0` under `prefers-reduced-motion`. */
function tokenDuration(name: string, fallback: number): number {
  try {
    if (typeof document === "undefined") return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (value.endsWith("ms")) return Number.parseFloat(value);
    if (value.endsWith("s")) return Number.parseFloat(value) * 1000;
  } catch {
    // Fall through to the caller's default.
  }
  return fallback;
}

/** Symmetric ease-in-out, so a camera move leaves and arrives without a jolt. */
const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;

type PartBuilder = (group: THREE.Group, material: (tone: Tone) => THREE.Material) => void;

const cylinder = (
  radius: number,
  length: number,
  material: THREE.Material,
  axis: "x" | "y" | "z" = "y",
) => {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 36),
    material,
  );
  if (axis === "x") mesh.rotation.z = Math.PI / 2;
  if (axis === "z") mesh.rotation.x = Math.PI / 2;
  return mesh;
};

const at = <T extends THREE.Object3D>(object: T, x: number, y: number, z = 0): T => {
  object.position.set(x, y, z);
  return object;
};

/** A gate valve: body, bonnet, stem and handwheel, oriented along a pipe axis. */
function valve(
  group: THREE.Group,
  material: (tone: Tone) => THREE.Material,
  pipeAxis: "x" | "y",
) {
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

/** Geometry for each detection id. Coordinates in metres, origin at the shell centre. */
const PARTS: Record<string, PartBuilder> = {
  D1: (group, material) => {
    const shell = cylinder(0.85, 5.2, material("body"), "x");
    group.add(at(shell, -0.3, 0));
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
    const bolts = material("structure");
    for (let index = 0; index < 20; index += 1) {
      const angle = (index / 20) * Math.PI * 2;
      const bolt = cylinder(0.035, 0.3, bolts, "x");
      group.add(at(bolt, 2.36, Math.sin(angle) * 0.95, Math.cos(angle) * 0.95));
    }
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
    valve(holder, material, "y");
    group.add(holder);
    group.add(at(cylinder(0.2, 0.9, material("machined")), 1.2, 3.0));
  },
  D6: (group, material) => {
    group.add(at(cylinder(0.16, 2.2, material("machined")), -5.2, 1.1));
    const holder = at(new THREE.Group(), -5.2, 1.3);
    valve(holder, material, "y");
    group.add(holder);
  },
  D7: (group, material) => {
    const holder = at(new THREE.Group(), 3.9, -2.05);
    valve(holder, material, "x");
    group.add(holder);
    group.add(at(cylinder(0.18, 0.9, material("machined"), "x"), 4.8, -2.05));
  },
  D8: (group, material) => {
    group.add(at(cylinder(0.04, 0.5, material("machined")), 2.86, 1.1));
    const dial = cylinder(0.2, 0.08, material("machined"), "z");
    group.add(at(dial, 2.86, 1.5, 0.02));
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
    group.add(
      at(
        new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.18), material("structure")),
        -2.0,
        1.22,
      ),
    );
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
};

function saddle(group: THREE.Group, material: (tone: Tone) => THREE.Material, x: number) {
  const web = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.25, 1.5), material("structure"));
  group.add(at(web, x, -1.0));
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 1.8), material("structure"));
  group.add(at(base, x, -1.62));
}

function supportsWebGL(): boolean {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

export function TwinModel({
  selected,
  tints,
  onSelect,
  labelOf,
}: {
  readonly selected: string | undefined;
  /** Detection id → tint for scenario highlighting. Selection wins over scenario tint. */
  readonly tints: ReadonlyMap<string, PartTint>;
  readonly onSelect: (id: string) => void;
  readonly labelOf: (id: string) => string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{
    paint: (
      selected: string | undefined,
      hover: string | undefined,
      tints: ReadonlyMap<string, PartTint>,
    ) => void;
    reset: () => void;
  } | null>(null);
  // Checked once, before any renderer exists; the model is client-only, so window is there.
  const [failed] = useState(() => !supportsWebGL());
  const [hover, setHover] = useState<string>();
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    const element = host.current;
    if (!element || failed) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      // The probe passed but the renderer still failed: leave the stage empty.
      return;
    }
    // Expensive 3D clamps its backing buffer, so a 3× display does not pay for 9× the pixels.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Shadows here establish contact between the equipment and the skid. They are soft and
    // shallow: depth cue, not drama.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    element.appendChild(renderer.domElement);

    // Tokens are read once, at setup, and passed to the materials and lights. Nothing in the
    // frame loop touches the computed style.
    const TONES: Record<Tone, THREE.Color> = (() => {
      const entries = Object.entries(TONE_TOKEN) as [Tone, string][];
      return Object.fromEntries(
        entries.map(([tone, token]) => [tone, tokenColour(token)]),
      ) as Record<Tone, THREE.Color>;
    })();
    const SELECTED = tokenColour("--scene-material-selected");
    const OUTLINE = tokenColour("--scene-outline");
    const DEGRADED = tokenColour("--status-degraded-mark");
    const DOWN = tokenColour("--status-down-mark");
    const UNLIT = new THREE.Color().setScalar(0);

    const scene = new THREE.Scene();
    scene.background = tokenColour("--scene-bg");
    // Just enough haze to let the far end of the grid recede; the equipment sits in front
    // of it and is never touched.
    scene.fog = new THREE.Fog(tokenColour("--scene-fog"), 22, 58);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
    const home = new THREE.Vector3(5.5, 4.6, 13.5);
    camera.position.copy(home);

    // One soft key light and a weak ambient fill — the lighting of a workshop bay, not a
    // product shot. Form comes from the key; the ambient only keeps the shadow side readable.
    scene.add(new THREE.AmbientLight(tokenColour("--scene-ambient"), 0.6));
    const sun = new THREE.DirectionalLight(tokenColour("--scene-key-light"), 1.4);
    sun.position.set(6, 10, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 34;
    sun.shadow.camera.left = -9;
    sun.shadow.camera.right = 9;
    sun.shadow.camera.top = 9;
    sun.shadow.camera.bottom = -9;
    // Curved primitives self-shadow badly without a normal bias; this keeps the contact
    // shadows on the skid without speckling the shells.
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);

    // Skid and ground grid: context, not parts, so they are not pickable.
    const skid = new THREE.Mesh(
      new THREE.BoxGeometry(11.5, 0.16, 3.2),
      new THREE.MeshStandardMaterial({
        color: TONES.structure,
        roughness: 0.95,
        metalness: 0,
      }),
    );
    skid.position.set(-0.4, -1.74, 0);
    skid.receiveShadow = true;
    scene.add(skid);
    const grid = new THREE.GridHelper(
      24,
      24,
      tokenColour("--rule-strong"),
      TONES.structure,
    );
    grid.position.y = -1.83;
    scene.add(grid);

    const groups = new Map<string, THREE.Group>();
    const pickable: THREE.Object3D[] = [];
    for (const [id, build] of Object.entries(PARTS)) {
      const group = new THREE.Group();
      group.userData.detection = id;
      build(group, (tone) => {
        const material = new THREE.MeshStandardMaterial({
          color: TONES[tone],
          ...TONE_FINISH[tone],
        });
        material.userData.tone = tone;
        return material;
      });
      group.traverse((child) => {
        child.userData.detection = id;
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          pickable.push(child);
        }
      });
      groups.set(id, group);
      scene.add(group);
    }

    /*
     * Selection edge.
     *
     * Selection brightens the material and rings the part with a thin outline in world
     * space, so it stays on the geometry as the camera moves. It never tints the part.
     */
    const outlineMaterial = new THREE.LineBasicMaterial({ color: OUTLINE, fog: false });
    const outlines = new THREE.Group();
    scene.add(outlines);
    const outlineSelection = (id: string | undefined) => {
      for (const edge of [...outlines.children]) {
        outlines.remove(edge);
        if (edge instanceof THREE.LineSegments) edge.geometry.dispose();
      }
      const group = id ? groups.get(id) : undefined;
      if (!group) return;
      scene.updateMatrixWorld(true);
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(child.geometry, 26),
          outlineMaterial,
        );
        edge.matrixAutoUpdate = false;
        edge.matrix.copy(child.matrixWorld);
        outlines.add(edge);
      });
    };

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(-0.4, 0.2, 0);
    controls.minDistance = 5;
    controls.maxDistance = 30;
    controls.maxPolarAngle = Math.PI * 0.52;
    controls.update();

    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);

    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (event: PointerEvent): string | undefined => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(pickable, false)[0]?.object.userData.detection as
        string | undefined;
    };

    // A click is a press and release without a drag; a drag orbits the camera.
    let down: { x: number; y: number } | undefined;
    const onDown = (event: PointerEvent) => (down = { x: event.clientX, y: event.clientY });
    const onUp = (event: PointerEvent) => {
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
      const id = pick(event);
      if (id) onSelectRef.current(id);
    };
    let lastHover: string | undefined;
    const onMove = (event: PointerEvent) => {
      if (event.buttons) return;
      const id = pick(event);
      if (id === lastHover) return;
      lastHover = id;
      renderer.domElement.style.cursor = id ? "pointer" : "grab";
      setHover(id);
    };
    const onLeave = () => {
      lastHover = undefined;
      setHover(undefined);
    };
    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    /*
     * A camera move is a move, not a cut: the view travels to its home over
     * `--duration-camera` with ease-in-out, so the eye keeps hold of the model on the way.
     * Under `prefers-reduced-motion` the token reads 0ms and the move lands immediately.
     */
    let flight = 0;
    const homeTarget = new THREE.Vector3(-0.4, 0.2, 0);
    const flyHome = () => {
      if (flight) cancelAnimationFrame(flight);
      const ms = tokenDuration("--duration-camera", 480);
      if (ms <= 0) {
        flight = 0;
        camera.position.copy(home);
        controls.target.copy(homeTarget);
        controls.update();
        return;
      }
      const fromPosition = camera.position.clone();
      const fromTarget = controls.target.clone();
      const started = performance.now();
      const step = () => {
        const progress = Math.min(1, (performance.now() - started) / ms);
        const eased = easeInOut(progress);
        camera.position.lerpVectors(fromPosition, home, eased);
        controls.target.lerpVectors(fromTarget, homeTarget, eased);
        controls.update();
        flight = progress < 1 ? requestAnimationFrame(step) : 0;
      };
      flight = requestAnimationFrame(step);
    };

    api.current = {
      paint: (current, hovered, highlight) => {
        for (const [id, group] of groups) {
          const tint: PartTint | undefined =
            id === current ? "selected" : id === hovered ? "hover" : highlight.get(id);
          group.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            const material = child.material as THREE.MeshStandardMaterial;
            const tone = material.userData.tone as Tone | undefined;
            const base = TONES[tone ?? "body"];
            // Selection and hover are carried by brightness alone; the part keeps its tone.
            if (tint === "selected") material.color.copy(SELECTED);
            else if (tint === "hover") material.color.copy(base).lerp(SELECTED, 0.5);
            else material.color.copy(base);
            // Scenario severity is state the simulation has determined, so it is the one
            // thing allowed a hue — a shallow wash at the non-text status mark, not a fill.
            const mark = tint === "alarm" ? DOWN : tint === "warn" ? DEGRADED : UNLIT;
            material.emissive.copy(mark);
            material.emissiveIntensity =
              tint === "alarm" ? 0.34 : tint === "warn" ? 0.2 : 0;
          });
        }
        outlineSelection(current);
        render();
      },
      reset: flyHome,
    };

    return () => {
      api.current = null;
      if (flight) cancelAnimationFrame(flight);
      observer.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      renderer.dispose();
      canvas.remove();
    };
  }, [failed]);

  useEffect(() => {
    api.current?.paint(selected, hover, tints);
  }, [selected, hover, tints]);

  if (failed) {
    return (
      <div className={styles.modelFallback}>
        <strong>3D view unavailable</strong>
        <p>
          This browser did not provide WebGL. The photograph and mapping table stay fully
          usable.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.model}>
      <div
        ref={host}
        className={styles.modelHost}
        role="img"
        aria-label="3D model of the exchanger skid. Drag to orbit, scroll to zoom, click a part to select it. Every part is also listed in the mapping table."
      />
      <div className={styles.modelHud} aria-live="polite">
        {hover
          ? labelOf(hover)
          : selected
            ? labelOf(selected)
            : "Drag to orbit · click a part"}
      </div>
      <button className={styles.modelReset} onClick={() => api.current?.reset()}>
        Reset view
      </button>
    </div>
  );
}

export default TwinModel;
