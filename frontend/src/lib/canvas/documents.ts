/**
 * The content behind every document and work order the register lists.
 *
 * A file named `FIT-1003_Datasheet.pdf` in the files panel is only useful if opening it shows
 * FIT-1003's datasheet — its service, its line, its range and alarms, the valve it drives.
 * This module produces that content from the register, so every field on a document is the
 * same value the rest of the workspace shows for that tag: the line number on the datasheet
 * is the line the canvas highlights, the loop diagram's final element is the loop partner the
 * popover names, the inspection findings are the failure modes the overview ranks.
 *
 * Values the register does not hold — ranges, materials, wiring addresses — are derived
 * deterministically from the tag, follow the governing convention (ISA-20 datasheet fields,
 * ANSI/FCI 70-2 leakage classes, TEMA exchanger types, 4–20 mA HART signalling), and are
 * labelled simulated wherever they are shown.
 */

import {
  FAILURE_MODES,
  hashString,
  seededRandom,
  type AssetDocument,
  type AssetRecord,
  type FailureCode,
  type PlantRegister,
  type WorkOrder,
} from "./engineering";

export type DocumentBlock =
  | {
      readonly kind: "fields";
      readonly heading: string;
      readonly rows: readonly (readonly [string, string])[];
    }
  | {
      readonly kind: "table";
      readonly heading: string;
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly kind: "loop"; readonly heading: string; readonly loop: LoopWiring }
  | { readonly kind: "drawing"; readonly heading: string }
  | { readonly kind: "notes"; readonly heading: string; readonly items: readonly string[] };

export interface DocumentContent {
  readonly number: string;
  readonly title: string;
  readonly revision: string;
  readonly blocks: readonly DocumentBlock[];
}

/** One field-to-controller signal path, in the order a loop drawing lays it out. */
export interface LoopWiring {
  readonly loop: string;
  readonly nodes: readonly {
    readonly role: "field" | "junction" | "marshalling" | "io" | "controller";
    readonly tag: string;
    readonly detail: string;
  }[];
  readonly signal: string;
  /** The final element the controller drives, if the loop has one. */
  readonly output?: { readonly tag: string; readonly detail: string } | undefined;
}

/** Maintenance tasks that address each failure mode, with a typical interval. */
export const MAINTENANCE_TASKS: Record<
  FailureCode,
  readonly (readonly [string, string])[]
> = {
  AIR: [
    ["Compare against redundant or adjacent measurement", "3 months"],
    ["Five-point calibration check", "12 months"],
  ],
  ELP: [
    ["Walk-down leak check of packing, gaskets and flanges", "1 month"],
    ["Re-torque bolting to specification", "On finding"],
  ],
  ERO: [
    ["Inspect impulse lines and manifold for blockage", "6 months"],
    ["Check loop wiring, shielding and terminations", "12 months"],
  ],
  FTC: [
    ["Full stroke test, record stroke time", "6 months"],
    ["Inspect actuator, positioner and air supply", "12 months"],
  ],
  FTO: [
    ["Full stroke test, record stroke time", "6 months"],
    ["Inspect actuator, positioner and air supply", "12 months"],
  ],
  FTS: [
    ["Start-up function test", "3 months"],
    ["Check motor starter and interlocks", "12 months"],
  ],
  INL: [
    ["Internal visual inspection", "Turnaround"],
    ["Leak test between process sides", "Turnaround"],
  ],
  LCP: [
    ["Seat leakage test to ANSI/FCI 70-2", "24 months"],
    ["Lap or replace seat and plug", "On finding"],
  ],
  LOO: [
    ["Performance test against design curve", "12 months"],
    ["Inspect impeller and wear rings", "Turnaround"],
  ],
  NOI: [
    ["Acoustic survey on operator rounds", "1 month"],
    ["Check for cavitation at duty point", "6 months"],
  ],
  OHE: [
    ["Bearing temperature trend review", "1 month"],
    ["Lubrication oil analysis", "3 months"],
  ],
  PDE: [
    ["As-found / as-left calibration", "12 months"],
    ["Review drift trend against tolerance", "3 months"],
  ],
  SPO: [
    ["Review trip and event log", "1 month"],
    ["Proof test of trip function", "12 months"],
  ],
  STD: [
    ["Ultrasonic thickness survey at CMLs", "24 months"],
    ["External corrosion and coating inspection", "12 months"],
  ],
  VIB: [
    ["Overall velocity reading to ISO 10816", "1 month"],
    ["Spectrum analysis on alert", "On finding"],
  ],
};

const LEAKAGE_CLASS = ["Class IV", "Class V", "Class VI"] as const;
const BODY_MATERIAL: Record<string, string> = {
  A: "ASTM A216 WCB carbon steel",
  B: "ASTM A217 WC6 1¼Cr-½Mo",
  C: "ASTM A351 CF8M 316 stainless",
  D: "ASTM A217 C12A 9Cr-1Mo-V",
};
const RATING: Record<string, string> = {
  "1": "Class 150",
  "2": "Class 300",
  "3": "Class 600",
  "4": "Class 900",
};

/** Everything a document needs to know about where its tag sits. */
export interface DocumentContext {
  readonly register: PlantRegister;
  readonly sheet: string;
  /** Equipment the tag is joined to, nearest first, as the canvas computes it. */
  readonly joined: readonly { readonly id: string; readonly hops: number }[];
}

function lineOf(asset: AssetRecord, register: PlantRegister) {
  const line = register.lines.get(asset.lines[0] ?? "");
  const pipeClass = line?.pipeClass ?? "A1A";
  return {
    number: line?.number ?? "Not on a pipe run",
    size: line ? `${line.sizeInches}"` : "—",
    material: BODY_MATERIAL[pipeClass[0] ?? "A"] ?? BODY_MATERIAL.A!,
    rating: RATING[pipeClass[1] ?? "1"] ?? "Class 300",
  };
}

function loopPartner(asset: AssetRecord, register: PlantRegister): AssetRecord | undefined {
  if (!asset.loop) return undefined;
  for (const other of register.assets.values()) {
    if (other.loop === asset.loop && other.tag !== asset.tag) return other;
  }
  return undefined;
}

/** The loop wiring for an instrument or control valve, from its register loop. */
export function loopWiring(asset: AssetRecord, register: PlantRegister): LoopWiring {
  const partner = loopPartner(asset, register);
  const transmitter = asset.category === "instrument" ? asset : partner;
  const valve = asset.category === "control-valve" ? asset : partner;
  // Seeded from the measuring end, so the transmitter's and the valve's drawings agree.
  const random = seededRandom(hashString(`loop#${(transmitter ?? asset).tag}`));
  const number = (transmitter ?? asset).tag.split("-")[1] ?? "000";
  const letter = (transmitter ?? asset).tag[0] ?? "X";
  const box = `JB-${number.slice(0, 2)}${1 + Math.floor(random() * 4)}`;
  const cabinet = `MC-${1 + Math.floor(random() * 3)}`;
  const card = 1 + Math.floor(random() * 12);
  const channel = 1 + Math.floor(random() * 8);
  return {
    loop: asset.loop ?? `${letter}-${number}`,
    signal: "4–20 mA HART, 24 V DC loop-powered, 2-core 1.5 mm² shielded twisted pair",
    nodes: [
      {
        role: "field",
        tag: (transmitter ?? asset).tag,
        detail: (transmitter ?? asset).name,
      },
      { role: "junction", tag: box, detail: `Terminals ${channel * 2 - 1}–${channel * 2}` },
      { role: "marshalling", tag: cabinet, detail: `TB-${card} / ${channel}` },
      {
        role: "io",
        tag: `AI-${String(card).padStart(2, "0")}-${channel}`,
        detail: "DCS analogue input",
      },
      ...(valve
        ? [
            {
              role: "controller" as const,
              tag: `${letter}IC-${number}`,
              detail: "PID controller",
            },
          ]
        : [
            {
              role: "controller" as const,
              tag: `${letter}I-${number}`,
              detail: "Indication and alarm",
            },
          ]),
    ],
    output: valve
      ? {
          tag: valve.tag,
          detail: `${valve.name} via AO-${String(card).padStart(2, "0")}-${channel}`,
        }
      : undefined,
  };
}

function instrumentRange(asset: AssetRecord): readonly [number, number] {
  const high = asset.telemetry?.alarmHigh ?? 100;
  const top = Math.ceil((high * 1.25) / 5) * 5;
  return [0, top];
}

function datasheet(
  asset: AssetRecord,
  doc: AssetDocument,
  context: DocumentContext,
): DocumentBlock[] {
  const { register } = context;
  const line = lineOf(asset, register);
  const random = seededRandom(hashString(`datasheet#${asset.tag}`));
  const general: [string, string][] = [
    ["Tag number", asset.tag],
    ["Description", asset.name],
    ["Service", `${register.service.name} — ${register.system}`],
    ["Location", `${register.area} · ${register.unit}`],
    ["P&ID", context.sheet],
    ["Line number", line.number],
    ["Line size / rating", `${line.size} · ${line.rating}`],
    ["Status", asset.status],
  ];
  const blocks: DocumentBlock[] = [{ kind: "fields", heading: "General", rows: general }];

  if (asset.category === "instrument" && asset.telemetry) {
    const [lo, hi] = instrumentRange(asset);
    const t = asset.telemetry;
    blocks.push({
      kind: "fields",
      heading: "Process and measurement",
      rows: [
        ["Measured variable", t.measurement],
        ["Calibrated range", `${lo} – ${hi} ${t.unit}`],
        ["Normal operating", `${t.normal[0]} – ${t.normal[1]} ${t.unit}`],
        ["Alarm low / high", `${t.alarmLow} / ${t.alarmHigh} ${t.unit}`],
        ["Accuracy", `±${(0.04 + random() * 0.06).toFixed(3)} % of span`],
        [
          "Output",
          /Transmitter/.test(asset.name) ? "4–20 mA with HART 7" : "Local indication",
        ],
        ["Process connection", `½" NPT-F via 2-valve manifold`],
        ["Wetted parts", "316L stainless steel"],
        ["Enclosure / area", "IP66 · Ex db IIC T4 Gb"],
        ["Loop", asset.loop ?? "Indication only"],
      ],
    });
  } else if (asset.category.endsWith("valve")) {
    const manual = asset.category === "hand-valve";
    const safety = asset.category === "safety-valve";
    blocks.push({
      kind: "fields",
      heading: "Valve body and trim",
      rows: [
        ["Valve type", asset.name],
        ["Body size / rating", `${line.size} · ${line.rating} RF`],
        ["Body material", line.material],
        ["Trim", "316 SS with Stellite 6 seat facing"],
        [
          "Seat leakage",
          safety ? "API 527" : `ANSI/FCI 70-2 ${LEAKAGE_CLASS[Math.floor(random() * 3)]}`,
        ],
        ...(manual
          ? ([["Operator", "Handwheel, rising stem"]] as [string, string][])
          : safety
            ? ([
                ["Set pressure", `${(14 + random() * 6).toFixed(1)} barg`],
                ["Orifice", ["J", "K", "L", "M"][Math.floor(random() * 4)]!],
              ] as [string, string][])
            : ([
                ["Rated Cv", (40 + random() * 220).toFixed(0)],
                ["Characteristic", random() > 0.5 ? "Equal percentage" : "Linear"],
                ["Actuator", "Pneumatic spring-diaphragm, 4–6 barg supply"],
                ["Positioner", "Digital, 4–20 mA HART"],
                ["Fail position", random() > 0.5 ? "Fail closed (FC)" : "Fail open (FO)"],
                [
                  "Controlled by",
                  asset.loop
                    ? `${loopPartner(asset, register)?.tag ?? "—"} in loop ${asset.loop}`
                    : "—",
                ],
              ] as [string, string][])),
      ],
    });
  } else if (asset.category === "exchanger") {
    blocks.push({
      kind: "fields",
      heading: "Thermal and mechanical design",
      rows: [
        ["TEMA type", "AES"],
        ["Heat duty (design)", "10 350 kW"],
        ["Surface area", "110 m²"],
        ["Shell side", "Process · 240 °C in / 125 °C out · design 18 barg @ 280 °C"],
        ["Tube side", "Cooling water · 32 °C in / 66 °C out · design 10 barg @ 90 °C"],
        ["Clean U / fouling allowance", "727 W/m²·K / 0.00035 m²·K/W"],
        ["Shell / tubes", 'SA-516 Gr.70 / SA-179 seamless, ¾" 14 BWG'],
        ["Design code", "ASME VIII Div. 1 · TEMA R"],
      ],
    });
  } else {
    blocks.push({
      kind: "fields",
      heading: "Mechanical design",
      rows: [
        ["Design pressure", `${(10 + random() * 20).toFixed(1)} barg`],
        ["Design temperature", `${Math.round(150 + random() * 150)} °C`],
        ["Material", line.material],
        ["Design code", "ASME VIII Div. 1"],
      ],
    });
  }
  blocks.push({
    kind: "table",
    heading: "Revision history",
    columns: ["Rev", "Date", "Description", "By"],
    rows: [
      ["A", doc.date, "Issued for design", "PCE"],
      ["0", doc.date, "Issued for construction", "PCE"],
    ],
  });
  return blocks;
}

function manual(asset: AssetRecord): DocumentBlock[] {
  return [
    {
      kind: "notes",
      heading: "Contents",
      items: [
        "1 Safety",
        "2 Installation",
        "3 Commissioning",
        "4 Operation",
        "5 Maintenance",
        "6 Troubleshooting",
        "7 Spare parts",
      ],
    },
    {
      kind: "table",
      heading: "5 Maintenance schedule",
      columns: ["Failure mode addressed", "Task", "Interval"],
      rows: asset.failureModes.flatMap((mode) =>
        MAINTENANCE_TASKS[mode.code].map(([task, interval]) => [
          `${mode.code} ${mode.name}`,
          task,
          interval,
        ]),
      ),
    },
    {
      kind: "table",
      heading: "6 Troubleshooting",
      columns: ["Symptom", "Likely failure mode", "Likelihood"],
      rows: asset.failureModes.map((mode) => [
        mode.indicator,
        `${mode.code} ${mode.name}`,
        mode.likelihood,
      ]),
    },
  ];
}

function inspection(asset: AssetRecord, doc: AssetDocument): DocumentBlock[] {
  const random = seededRandom(hashString(`inspection#${asset.tag}`));
  const nominal = asset.category === "exchanger" ? 12.7 : 9.5;
  const readings = [
    "CML-01 Shell top",
    "CML-02 Shell bottom",
    "CML-03 Inlet nozzle",
    "CML-04 Outlet nozzle",
    "CML-05 Head",
  ].map((point) => {
    const measured = nominal - random() * 1.6;
    const rate = (nominal - measured) / 8;
    const retire = nominal * 0.6;
    return [
      point,
      nominal.toFixed(1),
      measured.toFixed(2),
      rate.toFixed(3),
      `${Math.max(1, Math.floor((measured - retire) / rate))} y`,
    ];
  });
  const worst = [...asset.failureModes].sort(
    (a, b) =>
      ["High", "Medium", "Low"].indexOf(a.likelihood) -
      ["High", "Medium", "Low"].indexOf(b.likelihood),
  )[0];
  return [
    {
      kind: "fields",
      heading: "Inspection summary",
      rows: [
        ["Inspection date", doc.date],
        ["Inspection type", "External visual + UT thickness (API 510)"],
        [
          "Overall condition",
          worst?.likelihood === "High"
            ? "Fit for service — follow-up required"
            : "Fit for service",
        ],
        [
          "Governing damage mechanism",
          worst ? `${worst.code} ${worst.name}` : "None identified",
        ],
      ],
    },
    {
      kind: "table",
      heading: "Thickness readings (mm)",
      columns: ["Location", "Nominal", "Measured", "Rate mm/y", "Remaining life"],
      rows: readings,
    },
    {
      kind: "table",
      heading: "Findings by failure mode",
      columns: ["Mode", "What was checked", "Assessment"],
      rows: asset.failureModes.map((mode) => [
        `${mode.code} ${mode.name}`,
        mode.indicator,
        mode.likelihood === "High"
          ? "Action required"
          : mode.likelihood === "Medium"
            ? "Monitor"
            : "No finding",
      ]),
    },
  ];
}

/** The content of one listed document for one asset. */
export function documentContent(
  asset: AssetRecord,
  doc: AssetDocument,
  context: DocumentContext,
): DocumentContent {
  const number = `${context.register.unit.replace(/\D/g, "") || "100"}-${doc.kind === "P&ID" ? "PID" : doc.kind === "Datasheet" ? "DS" : doc.kind === "Loop diagram" ? "LD" : doc.kind === "IOM manual" ? "IOM" : "IR"}-${asset.tag}`;
  switch (doc.kind) {
    case "P&ID": {
      const joined = context.joined.slice(0, 12).map(({ id, hops }) => {
        const other = context.register.assets.get(id);
        return [other?.tag ?? id, other?.name ?? "Symbol", String(hops)];
      });
      return {
        number: doc.name,
        title: `${asset.tag} on ${context.sheet}`,
        revision: "Corpus source",
        blocks: [
          { kind: "drawing", heading: "As drawn" },
          {
            kind: "table",
            heading: `Connected equipment (${context.joined.length})`,
            columns: ["Tag", "Description", "Hops"],
            rows: joined,
          },
        ],
      };
    }
    case "Datasheet":
      return {
        number,
        title: `${asset.name} datasheet`,
        revision: "Rev 0",
        blocks: datasheet(asset, doc, context),
      };
    case "Loop diagram": {
      const wiring = loopWiring(asset, context.register);
      return {
        number,
        title: `Loop ${wiring.loop}`,
        revision: "Rev 0",
        blocks: [
          { kind: "loop", heading: "Signal path", loop: wiring },
          {
            kind: "fields",
            heading: "Cable",
            rows: [
              ["Signal", wiring.signal],
              ["Field cable", `C-${asset.tag}-01`],
              ["Home-run cable", `MC-${asset.tag}-02`],
            ],
          },
        ],
      };
    }
    case "IOM manual":
      return {
        number,
        title: `${asset.name} — installation, operation and maintenance`,
        revision: "Ed. 3",
        blocks: manual(asset),
      };
    case "Inspection report":
      return {
        number,
        title: `Inspection report — ${asset.tag}`,
        revision: doc.date,
        blocks: inspection(asset, doc),
      };
  }
}

/** The detail behind a work order: what to look for, what to do, which documents to take. */
export function workOrderDetail(order: WorkOrder, asset: AssetRecord) {
  const mode = FAILURE_MODES[order.failureCode];
  return {
    symptom: mode.indicator,
    failure: `${order.failureCode} ${mode.name}`,
    tasks: MAINTENANCE_TASKS[order.failureCode].map(([task]) => task),
    documents: asset.documents.filter((doc) =>
      order.type === "Inspection"
        ? doc.kind !== "Loop diagram"
        : doc.kind !== "Inspection report",
    ),
    permit:
      order.type === "Inspection" || order.failureCode === "INL"
        ? "Hot work / confined space permit, isolate and drain"
        : "Cold work permit, bypass loop in DCS",
  };
}

export type { AssetDocument };
