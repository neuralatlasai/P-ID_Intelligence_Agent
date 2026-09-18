"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import styles from "./ModelLab.module.css";

/**
 * A procedural 3D model of the device a field reference shows.
 *
 * No CAD or point cloud exists for these assets, so the geometry is built from primitives to
 * the proportions of the photographed device class — a diaphragm-actuated globe valve, a
 * handwheel gate valve, a head-mounted temperature transmitter — and is labelled procedural
 * wherever it appears. It turns slowly while on screen so it reads as a live model, stops
 * when the reader drags it, and does not animate at all under reduced motion or off screen.
 */

type Build = (group: THREE.Group, m: Materials) => void;

/**
 * The scene is technical, not cinematic: every part is the same neutral scene material and
 * the parts are told apart by metallic response, the way a CAD viewer tells them apart.
 * Materials are named for the role they play, not for a colour they no longer carry.
 */
interface Materials {
  readonly steel: THREE.Material;
  readonly dark: THREE.Material;
  readonly housing: THREE.Material;
  readonly operator: THREE.Material;
  readonly shell: THREE.Material;
  readonly face: THREE.Material;
  readonly indicator: THREE.Material;
}

const cyl = (
  r: number,
  h: number,
  mat: THREE.Material,
  axis: "x" | "y" | "z" = "y",
  seg = 32,
) => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  if (axis === "x") mesh.rotation.z = Math.PI / 2;
  if (axis === "z") mesh.rotation.x = Math.PI / 2;
  return mesh;
};
const box = (w: number, h: number, d: number, mat: THREE.Material) =>
  new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z = 0): T => {
  o.position.set(x, y, z);
  return o;
};

/** A run of pipe along x with bolted flanges at both valve ends. */
function pipeRun(g: THREE.Group, m: Materials, radius = 0.32, gap = 0.9) {
  g.add(at(cyl(radius, 2.2, m.steel, "x"), -gap - 1.1, 0));
  g.add(at(cyl(radius, 2.2, m.steel, "x"), gap + 1.1, 0));
  for (const side of [-1, 1]) {
    for (const offset of [0, 0.1]) {
      g.add(at(cyl(radius * 1.75, 0.08, m.shell, "x"), side * (gap - offset), 0));
    }
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      g.add(
        at(
          cyl(0.035, 0.28, m.dark, "x", 8),
          side * (gap - 0.05),
          Math.sin(a) * radius * 1.5,
          Math.cos(a) * radius * 1.5,
        ),
      );
    }
  }
}

function handwheel(g: THREE.Group, m: Materials, y: number, r = 0.55) {
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(r, 0.045, 12, 40), m.operator);
  wheel.rotation.x = Math.PI / 2;
  g.add(at(wheel, 0, y));
  for (let i = 0; i < 5; i += 1) {
    const spoke = cyl(0.025, r * 2, m.operator, "x", 8);
    spoke.rotation.y = (i / 5) * Math.PI;
    g.add(at(spoke, 0, y));
  }
  g.add(at(cyl(0.09, 0.12, m.dark), 0, y));
}

const BUILDERS: { readonly match: RegExp; readonly build: Build }[] = [
  {
    match: /control valve/,
    build: (g, m) => {
      pipeRun(g, m);
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 20), m.shell);
      body.scale.set(1.15, 0.9, 0.95);
      g.add(body);
      g.add(at(cyl(0.5, 0.14, m.shell), 0, 0.6));
      g.add(at(cyl(0.34, 0.3, m.shell), 0, 0.82));
      for (const side of [-1, 1])
        g.add(at(box(0.08, 1.1, 0.14, m.housing), side * 0.28, 1.5));
      g.add(at(cyl(0.035, 1.2, m.steel), 0, 1.45));
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(0.85, 36, 16, 0, Math.PI * 2, 0, Math.PI / 2),
        m.housing,
      );
      dome.scale.set(1, 0.45, 1);
      g.add(at(dome, 0, 2.2));
      g.add(at(cyl(0.9, 0.1, m.housing), 0, 2.15));
      const lower = new THREE.Mesh(
        new THREE.SphereGeometry(0.85, 36, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        m.housing,
      );
      lower.scale.set(1, 0.25, 1);
      g.add(at(lower, 0, 2.1));
      g.add(at(box(0.6, 0.55, 0.3, m.shell), 0.75, 1.5, 0.05));
      for (const y of [1.62, 1.38]) g.add(at(cyl(0.08, 0.05, m.face, "z"), 1.06, y, 0.05));
    },
  },
  {
    match: /gate valve|handwheel/,
    build: (g, m) => {
      pipeRun(g, m);
      const body = cyl(0.48, 1.0, m.housing);
      g.add(at(body, 0, 0.05));
      const bottom = new THREE.Mesh(
        new THREE.SphereGeometry(0.48, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        m.housing,
      );
      g.add(at(bottom, 0, -0.45));
      g.add(at(cyl(0.62, 0.12, m.housing), 0, 0.6));
      g.add(at(cyl(0.3, 0.55, m.housing), 0, 0.95));
      for (const side of [-1, 1])
        g.add(at(box(0.08, 0.8, 0.14, m.housing), side * 0.18, 1.6));
      g.add(at(cyl(0.04, 1.8, m.steel), 0, 1.9));
      handwheel(g, m, 2.1);
    },
  },
  {
    match: /differential/,
    build: (g, m) => {
      g.add(at(box(1.2, 0.35, 0.6, m.steel), 0, 0));
      for (const x of [-0.4, 0, 0.4]) g.add(at(cyl(0.06, 0.4, m.dark), x, 0.35, 0.2));
      g.add(at(box(0.7, 0.6, 0.5, m.shell), 0, 0.55));
      g.add(at(cyl(0.38, 0.7, m.housing, "x"), 0, 1.15));
      g.add(at(cyl(0.34, 0.08, m.face, "x"), 0.38, 1.15));
      for (const x of [-0.45, 0.45]) g.add(at(cyl(0.05, 1.8, m.steel), x, -1.0));
    },
  },
  {
    match: /pressure transmitter/,
    build: (g, m) => {
      g.add(at(cyl(0.3, 3.2, m.steel, "x"), 0, -1.2));
      g.add(at(cyl(0.05, 1.0, m.steel), 0, -0.6));
      g.add(at(box(0.55, 0.3, 0.4, m.steel), 0, 0));
      g.add(at(cyl(0.22, 0.35, m.shell), 0, 0.3));
      g.add(at(cyl(0.36, 0.8, m.housing, "x"), 0, 0.72));
      g.add(at(cyl(0.3, 0.06, m.face, "x"), 0.41, 0.72));
    },
  },
  {
    match: /pressure gauge/,
    build: (g, m) => {
      g.add(at(cyl(0.3, 3.2, m.steel, "x"), 0, -1.3));
      g.add(at(cyl(0.05, 0.9, m.steel), 0, -0.7));
      const siphon = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 8, 24), m.steel);
      g.add(at(siphon, 0, -0.1));
      g.add(at(cyl(0.6, 0.22, m.dark, "z"), 0, 0.7));
      g.add(at(cyl(0.54, 0.05, m.face, "z"), 0, 0.7, 0.12));
      const needle = box(0.42, 0.03, 0.02, m.operator);
      needle.rotation.z = 0.7;
      g.add(at(needle, 0.12, 0.8, 0.16));
    },
  },
  {
    match: /temperature/,
    build: (g, m) => {
      g.add(at(cyl(0.4, 3.2, m.steel, "x"), 0, -1.2));
      g.add(at(cyl(0.08, 1.3, m.steel), 0, -0.45));
      g.add(at(cyl(0.12, 0.2, m.shell), 0, 0.3));
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2),
        m.housing,
      );
      g.add(at(cyl(0.42, 0.45, m.housing), 0, 0.62));
      g.add(at(head, 0, 0.85));
      g.add(at(cyl(0.08, 0.35, m.shell, "x"), 0.55, 0.6));
    },
  },
  {
    match: /flow/,
    build: (g, m) => {
      pipeRun(g, m, 0.36, 0.75);
      g.add(cyl(0.6, 1.3, m.housing, "x"));
      g.add(at(box(0.5, 0.5, 0.5, m.shell), 0, 0.8));
      g.add(at(cyl(0.34, 0.5, m.housing), 0, 1.25));
      g.add(at(cyl(0.3, 0.05, m.face), 0, 1.52));
    },
  },
  {
    match: /level/,
    build: (g, m) => {
      const shell = cyl(1.6, 1.2, m.shell);
      g.add(at(shell, 0, -1.3));
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(1.6, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2),
        m.shell,
      );
      head.scale.set(1, 0.4, 1);
      g.add(at(head, 0, -0.7));
      g.add(at(cyl(0.3, 0.5, m.steel), 0, 0));
      g.add(at(cyl(0.48, 0.1, m.steel), 0, 0.28));
      g.add(at(cyl(0.3, 0.55, m.housing), 0, 0.62));
      g.add(at(box(0.5, 0.35, 0.3, m.housing), 0.4, 0.75));
    },
  },
  {
    match: /vibration/,
    build: (g, m) => {
      g.add(at(box(2.2, 1.1, 1.2, m.housing), 0, -0.6));
      g.add(at(cyl(0.25, 1.4, m.steel, "x"), 1.7, -0.5));
      g.add(at(cyl(0.18, 0.5, m.steel), 0, 0.2));
      g.add(at(cyl(0.12, 0.05, m.indicator), 0, 0.47));
      const cable = new THREE.Mesh(
        new THREE.TorusGeometry(0.5, 0.03, 8, 24, Math.PI),
        m.dark,
      );
      g.add(at(cable, -0.5, 0.45));
    },
  },
  {
    match: /switch/,
    build: (g, m) => {
      g.add(at(cyl(0.05, 1.6, m.steel), 0, -0.9));
      g.add(at(box(0.8, 0.9, 0.45, m.shell), 0, 0.2));
      g.add(at(cyl(0.12, 0.3, m.dark, "x"), 0.55, 0.3));
      g.add(at(box(0.6, 0.05, 0.02, m.indicator), 0, 0.45, 0.24));
      g.add(at(box(1.4, 0.1, 0.8, m.steel), 0, -1.7));
    },
  },
  {
    match: /heat exchanger|shell-and-tube/,
    build: (g, m) => {
      g.add(cyl(0.9, 4.2, m.shell, "x"));
      g.add(at(cyl(1.05, 0.14, m.steel, "x"), 2.15, 0));
      g.add(at(cyl(0.9, 0.8, m.housing, "x"), 2.6, 0));
      for (const x of [-1.2, 1.2]) g.add(at(box(0.25, 1.1, 1.4, m.dark), x, -1.1));
      g.add(at(cyl(0.22, 0.8, m.steel), 1.1, 1.2));
      g.add(at(cyl(0.22, 0.8, m.steel), 1.5, -1.2));
    },
  },
  {
    match: /drum|separator|vessel/,
    build: (g, m) => {
      g.add(at(cyl(1.0, 3.2, m.shell), 0, 0));
      for (const [y, flip] of [
        [1.6, 0],
        [-1.6, 1],
      ] as const) {
        const head = new THREE.Mesh(
          new THREE.SphereGeometry(
            1.0,
            32,
            16,
            0,
            Math.PI * 2,
            flip ? Math.PI / 2 : 0,
            Math.PI / 2,
          ),
          m.shell,
        );
        head.scale.set(1, 0.5, 1);
        g.add(at(head, 0, y));
      }
      g.add(at(cyl(1.0, 0.7, m.dark), 0, -2.3));
      for (const y of [0.9, -0.6]) g.add(at(cyl(0.18, 0.7, m.steel, "x"), 1.3, y));
      g.add(at(cyl(0.18, 0.6, m.steel), 0, 2.3));
    },
  },
];

function buildFor(fieldClass: string): Build {
  const text = fieldClass.toLowerCase();
  return BUILDERS.find((entry) => entry.match.test(text))?.build ?? BUILDERS[0]!.build;
}

function webgl(): boolean {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

export function DeviceModel({
  fieldClass,
  label,
}: {
  readonly fieldClass: string;
  readonly label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [supported] = useState(() => typeof window !== "undefined" && webgl());

  useEffect(() => {
    const element = host.current;
    if (!element || !supported) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.appendChild(renderer.domElement);

    // Every colour in the scene is a token, read once from the document.
    const style = getComputedStyle(document.documentElement);
    const token = (name: string) =>
      new THREE.Color(style.getPropertyValue(name).trim() || undefined);
    const neutral = token("--scene-material");
    const mark = token("--scene-outline");

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    // One soft key light over a weak ambient; nothing in the scene is tinted.
    scene.add(
      new THREE.HemisphereLight(token("--scene-ambient"), token("--scene-bg"), 1.7),
    );
    const key = new THREE.DirectionalLight(token("--scene-key-light"), 2.4);
    key.position.set(4, 6, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(token("--scene-ambient"), 0.8);
    fill.position.set(-5, 2, -4);
    scene.add(fill);

    // One neutral material throughout: parts separate by metallic response, not by hue.
    const materials: Materials = {
      steel: new THREE.MeshStandardMaterial({
        color: neutral,
        metalness: 0.75,
        roughness: 0.35,
      }),
      dark: new THREE.MeshStandardMaterial({
        color: token("--scene-bg"),
        metalness: 0.6,
        roughness: 0.45,
      }),
      housing: new THREE.MeshStandardMaterial({
        color: neutral,
        metalness: 0.3,
        roughness: 0.45,
      }),
      operator: new THREE.MeshStandardMaterial({
        color: neutral,
        metalness: 0.2,
        roughness: 0.5,
      }),
      shell: new THREE.MeshStandardMaterial({
        color: neutral,
        metalness: 0.55,
        roughness: 0.4,
      }),
      face: new THREE.MeshStandardMaterial({
        color: mark,
        metalness: 0.05,
        roughness: 0.6,
      }),
      indicator: new THREE.MeshStandardMaterial({
        color: mark,
        metalness: 0.1,
        roughness: 0.6,
      }),
    };
    const device = new THREE.Group();
    buildFor(fieldClass)(device, materials);
    // Frame whatever was built: centre it and fit the camera to its bounding sphere.
    const bounds = new THREE.Box3().setFromObject(device);
    const centre = bounds.getCenter(new THREE.Vector3());
    device.position.sub(centre);
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    // Turn about the device's own centre, not the origin its parts were modelled around.
    const pivot = new THREE.Group();
    pivot.add(device);
    scene.add(pivot);
    const floor = new THREE.GridHelper(
      radius * 5,
      16,
      token("--rule-strong"),
      token("--scene-fog"),
    );
    floor.position.y = bounds.min.y - centre.y - 0.02;
    scene.add(floor);

    const distance = radius / Math.sin((camera.fov * Math.PI) / 360);
    camera.position.set(distance * 0.62, distance * 0.36, distance * 0.72);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.minDistance = radius * 1.5;
    controls.maxDistance = distance * 2;
    controls.update();

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let visible = true;
    let dragging = false;
    let frame = 0;
    const render = () => renderer.render(scene, camera);
    const loop = () => {
      frame = 0;
      if (!reduced && visible && !dragging && document.visibilityState === "visible") {
        pivot.rotation.y += 0.0045;
        render();
        frame = requestAnimationFrame(loop);
      }
    };
    const start = () => {
      if (!frame && !reduced) frame = requestAnimationFrame(loop);
    };
    controls.addEventListener("start", () => {
      dragging = true;
    });
    controls.addEventListener("change", render);
    controls.addEventListener("end", () => {
      dragging = false;
      start();
    });

    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(element);
    const viewObserver = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) start();
    });
    viewObserver.observe(element);
    resize();
    start();

    return () => {
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      viewObserver.disconnect();
      controls.dispose();
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
      Object.values(materials).forEach((material) => material.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [fieldClass, supported]);

  return (
    <div className={styles.model}>
      {supported ? (
        <div
          ref={host}
          className={styles.modelHost}
          role="img"
          aria-label={`Procedural 3D model of the ${fieldClass.toLowerCase()} registered to ${label}. Drag to orbit.`}
        />
      ) : (
        <p className={styles.modelFallback}>
          3D view needs WebGL, which this browser did not provide.
        </p>
      )}
      <span className={styles.modelFrame} aria-hidden="true" />
      <span className={styles.modelChip}>{label}</span>
    </div>
  );
}

export default DeviceModel;
