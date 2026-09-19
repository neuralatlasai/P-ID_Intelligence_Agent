"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  buildModel,
  disposeModel,
  SCENE_MODELS,
  type ModelSpec,
  type Tone,
} from "./models";
import styles from "./DigitalTwin.module.css";

/**
 * Procedural 3D model of the equipment in the selected field photograph.
 *
 * One renderer serves every scene. The lights, grid, controls and canvas are created once;
 * choosing another scene disposes the previous model's geometry and materials and builds the
 * new one in the same WebGL context, so paging through the filmstrip never allocates a
 * second renderer.
 *
 * Every part is tagged with the detection id of the matching box in the photo, so the model,
 * the photo and the drawing share one selection. Rendering is on demand: a frame is drawn
 * when the camera moves, the size changes, or the selection, highlight or scene does. Nothing
 * spins in a loop, so an idle twin costs no GPU time.
 */

export type PartTint = "selected" | "hover" | "warn" | "alarm";

/**
 * Surface tones.
 *
 * The scene is technical, not cinematic: the materials are neutral, and one part is told
 * from the next by geometry, edge contrast and the light falling on it — never by hue. The
 * three steps of that value ladder live in tokens.css, so the scene is retuned by editing the
 * token file rather than this component.
 */
const TONE_TOKEN: Record<Tone, string> = {
  /* Structure, fastening and ancillary hardware: supports, bolting, handwheels, cable and
     instrument enclosures — everything that carries or clamps rather than contains. */
  structure: "--scene-material-low",
  /* The painted pressure envelope: shells, heads, nozzles, valve bodies, bonnets, housings. */
  body: "--scene-material",
  /* Bare machined steel and instrument faces: flanges, stems, pipe runs, dials. */
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

function supportsWebGL(): boolean {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

interface ModelApi {
  show: (
    sceneId: string,
    selected: string | undefined,
    hover: string | undefined,
    tints: ReadonlyMap<string, PartTint>,
  ) => void;
  reset: () => void;
}

export function TwinModel({
  sceneId,
  selected,
  tints,
  onSelect,
  labelOf,
  summary,
}: {
  /** The field scene whose model to show; the model is rebuilt when it changes. */
  readonly sceneId: string;
  readonly selected: string | undefined;
  /** Detection id → tint for scenario highlighting. Selection wins over scenario tint. */
  readonly tints: ReadonlyMap<string, PartTint>;
  readonly onSelect: (id: string) => void;
  readonly labelOf: (id: string) => string;
  /** Text alternative: what the model shows and what is selected in it. */
  readonly summary: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<ModelApi | null>(null);
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
    // Shadows establish contact between the equipment and what carries it. Soft and shallow:
    // a depth cue, not drama.
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
    const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 200);

    // One soft key light and a weak ambient fill — the lighting of a workshop bay, not a
    // product shot. Form comes from the key; the ambient only keeps the shadow side readable.
    scene.add(new THREE.AmbientLight(tokenColour("--scene-ambient"), 0.6));
    const sun = new THREE.DirectionalLight(tokenColour("--scene-key-light"), 1.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    // Curved primitives self-shadow badly without a normal bias; this keeps the contact
    // shadows without speckling the shells.
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);

    // Reference grid: context, not a part, so it is not pickable. Moved to each model's floor.
    const grid = new THREE.GridHelper(
      24,
      24,
      tokenColour("--rule-strong"),
      TONES.structure,
    );
    scene.add(grid);

    const createMaterial = (tone: Tone) => {
      const material = new THREE.MeshStandardMaterial({
        color: TONES[tone],
        ...TONE_FINISH[tone],
      });
      material.userData.tone = tone;
      return material;
    };

    /*
     * Selection edge.
     *
     * Selection brightens the material and rings the part with a thin outline in world
     * space, so it stays on the geometry as the camera moves. It never tints the part.
     */
    const outlineMaterial = new THREE.LineBasicMaterial({ color: OUTLINE, fog: false });
    const outlines = new THREE.Group();
    scene.add(outlines);
    const clearOutlines = () => {
      for (const edge of [...outlines.children]) {
        outlines.remove(edge);
        if (edge instanceof THREE.LineSegments) edge.geometry.dispose();
      }
    };

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.maxPolarAngle = Math.PI * 0.52;

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

    // The loaded model. Replaced wholesale on a scene change.
    let loaded:
      | {
          readonly id: string;
          readonly spec: ModelSpec;
          readonly root: THREE.Group;
          readonly parts: ReadonlyMap<string, THREE.Group>;
          readonly pickable: readonly THREE.Object3D[];
        }
      | undefined;

    const home = new THREE.Vector3();
    const homeTarget = new THREE.Vector3();

    const load = (id: string) => {
      const spec = SCENE_MODELS[id];
      clearOutlines();
      if (loaded) {
        scene.remove(loaded.root);
        disposeModel(loaded.root);
        loaded = undefined;
      }
      if (!spec) return;
      const { root, parts } = buildModel(spec, createMaterial);
      const pickable: THREE.Object3D[] = [];
      root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.castShadow = true;
        child.receiveShadow = true;
        if (typeof child.userData.detection === "string") pickable.push(child);
      });
      scene.add(root);
      loaded = { id, spec, root, parts, pickable };

      // Camera, orbit limits, light and grid follow the model's scale.
      home.set(...spec.camera);
      homeTarget.set(...spec.target);
      camera.position.copy(home);
      controls.target.copy(homeTarget);
      controls.minDistance = spec.distance[0];
      controls.maxDistance = spec.distance[1];
      controls.update();
      grid.position.y = spec.floor;
      const e = spec.extent;
      sun.position.set(
        homeTarget.x + e * 0.66,
        homeTarget.y + e * 1.1,
        homeTarget.z + e * 0.9,
      );
      sun.target.position.copy(homeTarget);
      sun.shadow.camera.left = -e;
      sun.shadow.camera.right = e;
      sun.shadow.camera.top = e;
      sun.shadow.camera.bottom = -e;
      sun.shadow.camera.near = 0.1;
      sun.shadow.camera.far = e * 4;
      sun.shadow.camera.updateProjectionMatrix();
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (event: PointerEvent): string | undefined => {
      if (!loaded) return undefined;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects([...loaded.pickable], false)[0]?.object.userData
        .detection as string | undefined;
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
     * (Changing scene is a cut: it is a different object, not a new view of the same one.)
     */
    let flight = 0;
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
      show: (id, current, hovered, highlight) => {
        if (loaded?.id !== id) {
          if (flight) cancelAnimationFrame(flight);
          flight = 0;
          load(id);
        }
        if (!loaded) {
          render();
          return;
        }
        for (const [partId, group] of loaded.parts) {
          const tint: PartTint | undefined =
            partId === current
              ? "selected"
              : partId === hovered
                ? "hover"
                : highlight.get(partId);
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
        clearOutlines();
        const group = current ? loaded.parts.get(current) : undefined;
        if (group) {
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
        }
        render();
      },
      reset: flyHome,
    };
    resize();

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
      clearOutlines();
      if (loaded) disposeModel(loaded.root);
      outlineMaterial.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, [failed]);

  useEffect(() => {
    api.current?.show(sceneId, selected, hover, tints);
  }, [sceneId, selected, hover, tints]);

  if (failed) {
    return (
      <div className={styles.modelFallback} role="note" aria-label={summary}>
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
        aria-label={`${summary} Drag to orbit, scroll to zoom, click a part to select it. Every part is also listed in the mapping table.`}
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
