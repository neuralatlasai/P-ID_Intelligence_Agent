/** Stroke icons for the model lab, drawn on a 24-unit grid in currentColor. */

const PATHS = {
  brand: "M12 3v10m0 0-4-4m4 4 4-4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3",
  home: "M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z",
  canvas: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4",
  assets:
    "M6 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm12-8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7.6 14.8l8.8-5.6M6 14V6m12 8v4",
  data: "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zm0 0v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  model: "M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9",
  simulation: "M12 3a9 9 0 1 0 9 9M12 7v5l3 3M17 3h4v4",
  deploy: "M5 19c2-6 6-10 14-14-4 8-8 12-14 14zm4-5 1 1M9 19v-4H5",
  monitoring: "M3 12h4l3-7 4 14 3-7h4",
  experiments: "M9 3h6M10 3v6L5 19a1 1 0 0 0 1 2h12a1 1 0 0 0 1-2l-5-10V3M7.5 14h9",
  reports: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8 3-2-1 .5-2.2-1.8-1.3-1.7 1.5L13 8l-1-2-1 2-2 .5-1.7-1.5-1.8 1.3L6 11l-2 1 2 1-.5 2.2 1.8 1.3 1.7-1.5 2 .5 1 2 1-2 2-.5 1.7 1.5 1.8-1.3L18 13z",
  clipboard: "M9 4h6v3H9zM7 5H5v16h14V5h-2M8 11h8M8 15h6",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  pause: "M8 5v14M16 5v14",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-10v6m0-9h.01",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4.3-4.3",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4",
  chevron: "M6 9l6 6 6-6",
  recipe: "M4 6h10M4 12h7M4 18h10M17 4v4M17 10v10M14 8h6M14 14h6",
  contract:
    "M5 5c0-1.1 3.1-2 7-2s7 .9 7 2-3.1 2-7 2-7-.9-7-2zm0 0v14c0 1.1 3.1 2 7 2s7-.9 7-2V5M5 12c0 1.1 3.1 2 7 2s7-.9 7-2",
  runtime: "M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9",
  sample: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  pulse: "M3 12h4l2-5 4 10 2-5h6",
  metrics: "M4 20V4h16v16zM8 8h8M8 12h8M8 16h5",
  checkpoint:
    "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zm0 0v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6",
  donut: "M12 3a9 9 0 1 0 9 9h-9z M14 3.3A9 9 0 0 1 20.7 10H14z",
  target:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  download: "M12 4v11m-5-5 5 5 5-5M5 20h14",
  check: "M5 12l5 5L20 7",
  cross: "M6 6l12 12M18 6 6 18",
  robot:
    "M8 8h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zm4-4v4M9 13h.01M15 13h.01M10 16h4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0",
  cube: "M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9",
  book: "M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h9",
  graph:
    "M6 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm12 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm-1 3-4 4m6-4 4 4M8 16h8",
  box: "M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8",
  code: "M9 8l-4 4 4 4m6-8 4 4-4 4",
  table: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  db: "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zm0 0v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  flag: "M5 21V4m0 0h11l-2 4 2 4H5",
  file: "M7 3h7l5 5v13H7zM14 3v5h5",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3m0 14v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M2 12h3m14 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  shield: "M12 3 5 6v6c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6zm-3 9 2 2 4-4",
  chart: "M5 20V10m5 10V4m5 16v-7m5 7v-4",
  rocket: "M5 19c2-6 6-10 14-14-4 8-8 12-14 14zm4-5 1 1M9 19v-4H5",
  play: "M8 5v14l11-7z",
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  zoomIn: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4.3-4.3M11 8v6m-3-3h6",
  zoomOut: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4.3-4.3M8 11h6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
}: {
  readonly name: IconName;
  readonly size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
