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

const STEEL = 0x8a96a8;
const PAINT = 0x5f7da3;
const HANDWHEEL = 0xb83a2e;
const TINT: Record<PartTint, number> = {
  selected: 0x1d4ed8,
  hover: 0x3b82f6,
  warn: 0xd08a12,
  alarm: 0xc62828,
};

type PartBuilder = (
  group: THREE.Group,
  material: (colour: number) => THREE.Material,
) => void;

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

/** A gate valve: body, bonnet, stem and a red handwheel, oriented along a pipe axis. */
function valve(
  group: THREE.Group,
  material: (colour: number) => THREE.Material,
  pipeAxis: "x" | "y",
) {
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 16), material(PAINT));
  body.scale.set(pipeAxis === "x" ? 1.25 : 1, pipeAxis === "y" ? 1.25 : 1, 1);
  group.add(body);
  for (const side of [-1, 1]) {
    const flange = cylinder(0.3, 0.06, material(STEEL), pipeAxis);
    if (pipeAxis === "x") flange.position.x = side * 0.32;
    else flange.position.y = side * 0.32;
    group.add(flange);
  }
  // The bonnet stands off the pipe on z for a vertical pipe, on y for a horizontal one.
  const bonnet = cylinder(0.1, 0.42, material(PAINT), pipeAxis === "x" ? "y" : "z");
  const wheel = new THREE.Mesh(
    new THREE.TorusGeometry(0.24, 0.035, 10, 32),
    material(HANDWHEEL),
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
    const shell = cylinder(0.85, 5.2, material(PAINT), "x");
    group.add(at(shell, -0.3, 0));
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.85, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2),
      material(PAINT),
    );
    cap.rotation.z = Math.PI / 2;
    cap.scale.set(0.45, 1, 1);
    group.add(at(cap, -2.9, 0));
    for (const x of [-1.4, 0.9])
      group.add(at(cylinder(0.88, 0.05, material(STEEL), "x"), x, 0));
  },
  D2: (group, material) => {
    group.add(at(cylinder(1.02, 0.12, material(STEEL), "x"), 2.36, 0));
    group.add(at(cylinder(0.86, 0.9, material(PAINT), "x"), 2.86, 0));
    group.add(at(cylinder(1.02, 0.12, material(STEEL), "x"), 3.36, 0));
    const bolts = material(0x3c4658);
    for (let index = 0; index < 20; index += 1) {
      const angle = (index / 20) * Math.PI * 2;
      const bolt = cylinder(0.035, 0.3, bolts, "x");
      group.add(at(bolt, 2.36, Math.sin(angle) * 0.95, Math.cos(angle) * 0.95));
    }
  },
  D3: (group, material) => {
    group.add(at(cylinder(0.2, 0.7, material(PAINT)), 1.2, 1.1));
    group.add(at(cylinder(0.32, 0.08, material(STEEL)), 1.2, 1.46));
  },
  D4: (group, material) => {
    group.add(at(cylinder(0.18, 0.6, material(PAINT)), 1.5, -1.05));
    group.add(at(cylinder(0.3, 0.08, material(STEEL)), 1.5, -1.36));
  },
  D5: (group, material) => {
    group.add(at(cylinder(0.2, 0.5, material(STEEL)), 1.2, 1.75));
    const holder = at(new THREE.Group(), 1.2, 2.32);
    valve(holder, material, "y");
    group.add(holder);
    group.add(at(cylinder(0.2, 0.9, material(STEEL)), 1.2, 3.0));
  },
  D6: (group, material) => {
    group.add(at(cylinder(0.16, 2.2, material(STEEL)), -5.2, 1.1));
    const holder = at(new THREE.Group(), -5.2, 1.3);
    valve(holder, material, "y");
    group.add(holder);
  },
  D7: (group, material) => {
    const holder = at(new THREE.Group(), 3.9, -2.05);
    valve(holder, material, "x");
    group.add(holder);
    group.add(at(cylinder(0.18, 0.9, material(STEEL), "x"), 4.8, -2.05));
  },
  D8: (group, material) => {
    group.add(at(cylinder(0.04, 0.5, material(STEEL)), 2.86, 1.1));
    const dial = cylinder(0.2, 0.08, material(0xe9edf2), "z");
    group.add(at(dial, 2.86, 1.5, 0.02));
    group.add(
      at(
        new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.025, 8, 28), material(STEEL)),
        2.86,
        1.5,
        0.07,
      ),
    );
  },
  D9: (group, material) => {
    group.add(at(cylinder(0.04, 0.3, material(STEEL)), -2.0, 0.98));
    group.add(
      at(
        new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.18), material(0x3a4d6b)),
        -2.0,
        1.22,
      ),
    );
    group.add(at(cylinder(0.1, 0.1, material(0xdfe5ee), "z"), -2.0, 1.22, 0.12));
  },
  D10: (group, material) => saddle(group, material, -1.9),
  D11: (group, material) => saddle(group, material, 1.2),
  D12: (group, material) => {
    group.add(at(cylinder(0.2, 2.0, material(STEEL), "x"), -4.2, 0));
    group.add(at(cylinder(0.32, 0.08, material(STEEL), "x"), -3.24, 0));
    const elbow = new THREE.Mesh(
      new THREE.TorusGeometry(0.2, 0.17, 12, 24, Math.PI / 2),
      material(STEEL),
    );
    elbow.rotation.z = Math.PI;
    group.add(at(elbow, -5.2, 0.0));
  },
  D13: (group, material) => {
    group.add(at(cylinder(0.18, 0.55, material(STEEL)), 1.5, -1.68));
    group.add(at(cylinder(0.18, 2.1, material(STEEL), "x"), 2.5, -2.05));
  },
};

function saddle(
  group: THREE.Group,
  material: (colour: number) => THREE.Material,
  x: number,
) {
  const web = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.25, 1.5), material(0x4a5568));
  group.add(at(web, x, -1.0));
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 1.8), material(0x3c4658));
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
    const home = new THREE.Vector3(5.5, 4.6, 13.5);
    camera.position.copy(home);

    scene.add(new THREE.HemisphereLight(0xf4f7fb, 0x404a5a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(6, 10, 8);
    scene.add(sun);

    // Skid and ground grid: context, not parts, so they are not pickable.
    const skid = new THREE.Mesh(
      new THREE.BoxGeometry(11.5, 0.16, 3.2),
      new THREE.MeshStandardMaterial({ color: 0x9aa6b6, roughness: 0.9 }),
    );
    skid.position.set(-0.4, -1.74, 0);
    scene.add(skid);
    const grid = new THREE.GridHelper(24, 24, 0xb4bfce, 0xd5dce6);
    grid.position.y = -1.83;
    scene.add(grid);

    const groups = new Map<string, THREE.Group>();
    const pickable: THREE.Object3D[] = [];
    for (const [id, build] of Object.entries(PARTS)) {
      const group = new THREE.Group();
      group.userData.detection = id;
      build(
        group,
        (colour) =>
          new THREE.MeshStandardMaterial({
            color: colour,
            roughness: 0.55,
            metalness: 0.35,
          }),
      );
      group.traverse((child) => {
        child.userData.detection = id;
        if (child instanceof THREE.Mesh) pickable.push(child);
      });
      groups.set(id, group);
      scene.add(group);
    }

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

    api.current = {
      paint: (current, hovered, highlight) => {
        for (const [id, group] of groups) {
          const tint: PartTint | undefined =
            id === current ? "selected" : id === hovered ? "hover" : highlight.get(id);
          group.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            const material = child.material as THREE.MeshStandardMaterial;
            material.emissive.setHex(tint ? TINT[tint] : 0x000000);
            material.emissiveIntensity = tint === "hover" ? 0.35 : tint ? 0.6 : 0;
          });
        }
        render();
      },
      reset: () => {
        camera.position.copy(home);
        controls.target.set(-0.4, 0.2, 0);
        controls.update();
      },
    };

    return () => {
      api.current = null;
      observer.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
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
