/**
 * The field-reference scenes: one per photograph in the twelve-asset fusion set that shows
 * enough of the equipment to inspect it part by part.
 *
 * Each scene is anchored on the symbol the fusion set registers its photograph against
 * (`FUSION_ASSET_SPECS` in the investigation model — node id and drawn class, validated on
 * the one sheet the set was registered on), so the anchor is never inferred. The parts
 * around the equipment are then resolved through the drawing's real topology by the same
 * machinery as the exchanger scene, and anything the topology cannot support is left
 * unmapped with the reason.
 *
 * BOXES
 *
 * Every box was placed by hand on the native-resolution photograph (1448 × 1086) and checked
 * by rendering it back onto the image and inspecting the result, part by part. A box frames
 * the component it names, tightly enough to click, and no box is drawn around something the
 * photograph does not clearly show — a vessel's manway, for one, is not visible in the
 * knock-out drum photograph and so is not detected.
 *
 * All six photographs are generated images, and every process figure is an assumed basis;
 * both are labelled wherever they are shown.
 *
 * ONE SCENE PER SYMBOL
 *
 * No two scenes may anchor on the same node. The set's separator photograph is registered
 * to `tank67`, which the exchanger scene already anchors on (the drawing's printed tag reads
 * it as a steam generator), so showing both would present two different pieces of
 * equipment as one P&ID asset. That photograph is therefore not offered as a scene.
 */

import { HEAT_EXCHANGER_SCENE, type FieldScene } from "./scene";

/** Utility knock-out drum — `tank70`, fusion reference ANN-002. */
export const KNOCKOUT_DRUM_SCENE: FieldScene = {
  id: "SCN-KO-DRUM",
  title: "Knock-out drum — field inspection",
  equipment: "Vertical knock-out drum",
  duty: "Knocks entrained liquid out of the incoming line before the vapour passes on overhead.",
  image: "/demo/fusion/asset-tank70-knockout-drum.png",
  imageWidth: 1448,
  imageHeight: 1086,
  provenance: "generated",
  anchorRule: "registered",
  preferredAnchors: ["tank70"],
  expectedCategories: ["vessel"],
  process: {
    kind: "vessel",
    basis: {
      idM: 1.5,
      tangentM: 2.6,
      spanM: 2.4,
      densityKgM3: 882,
      operatingBarg: 10,
      outflowM3h: 3,
      alarmLowPct: 15,
      alarmHighPct: 85,
      fluid: "saturated water at 10 barg",
    },
  },
  impact: "liquid holdup, overpressure protection and what passes on to the vapour line",
  detections: [
    {
      id: "K1",
      label: "Shell and heads",
      cls: "shell",
      role: "anchor-body",
      box: [562, 190, 850, 790],
      description:
        "Short cylindrical shell closed by semi-elliptical top and bottom heads.",
    },
    {
      id: "K2",
      label: "Top outlet nozzle",
      cls: "nozzle",
      role: "outlet-side",
      run: 1,
      box: [620, 72, 798, 194],
      description: "Flanged overhead vapour outlet on the top head.",
    },
    {
      id: "K3",
      label: "Inlet nozzle N1",
      cls: "nozzle",
      role: "inlet-side",
      run: 0,
      box: [405, 365, 605, 562],
      description: "Flanged side inlet nozzle, bolted to the incoming line.",
    },
    {
      id: "K4",
      label: "Pressure relief valve",
      cls: "valve",
      role: "relief-valve",
      box: [818, 0, 992, 326],
      description:
        "Spring-loaded relief valve with lifting lever, on a shoulder nozzle; side discharge.",
    },
    {
      id: "K5",
      label: "Leg supports",
      cls: "support",
      role: "anchor-body",
      box: [520, 655, 885, 1000],
      description: "Welded legs with base plates bolted to the grating deck.",
    },
    {
      id: "K6",
      label: "Drain valve",
      cls: "valve",
      role: "valve",
      box: [668, 785, 812, 960],
      description: "Lever-operated quarter-turn valve on the bottom drain nozzle.",
    },
  ],
};

/** Actuated control valve — `valve43`, fusion reference ANN-003. */
export const CONTROL_VALVE_SCENE: FieldScene = {
  id: "SCN-CONTROL-VALVE",
  title: "Globe control valve — field inspection",
  equipment: "Pneumatic globe control valve",
  duty: "Modulates flow in its line on the positioner's signal; the final element of its loop.",
  image: "/demo/fusion/asset-valve43-control-valve.png",
  imageWidth: 1448,
  imageHeight: 1086,
  provenance: "generated",
  anchorRule: "registered",
  preferredAnchors: ["valve43"],
  expectedCategories: ["control-valve"],
  process: {
    kind: "control-valve",
    basis: { kvs: 250, rangeability: 50, dpBar: 2, sg: 1 },
  },
  impact: "the flow it controls and the loop it closes",
  detections: [
    {
      id: "C1",
      label: "Globe body and bonnet",
      cls: "valve",
      role: "anchor-body",
      box: [540, 565, 882, 1005],
      description: "Cast globe body with its bolted bonnet flange; the trim sits inside.",
    },
    {
      id: "C2",
      label: "Diaphragm actuator",
      cls: "actuator",
      role: "anchor-body",
      box: [440, 18, 960, 262],
      description: "Spring-and-diaphragm casing; air on the diaphragm strokes the stem.",
    },
    {
      id: "C3",
      label: "Yoke and stem",
      cls: "yoke",
      role: "anchor-body",
      box: [610, 258, 780, 528],
      description:
        "Yoke carrying the actuator, with the stem connector and travel indicator.",
    },
    {
      id: "C4",
      label: "Valve positioner",
      cls: "positioner",
      role: "anchor-body",
      box: [764, 290, 1000, 526],
      description:
        "Positioner with supply and output gauges, tubed to the actuator; closes the travel loop.",
    },
    {
      id: "C5",
      label: "Line flange and pipe (left)",
      cls: "flange",
      role: "inlet-side",
      run: 0,
      box: [0, 660, 540, 1010],
      description: "Bolted flange pair and pipe run on the left of the body.",
    },
    {
      id: "C6",
      label: "Line flange and pipe (right)",
      cls: "flange",
      role: "outlet-side",
      run: 1,
      box: [880, 670, 1448, 1060],
      description: "Bolted flange pair and pipe run on the right of the body.",
    },
  ],
};

/** Manual isolation valve — `valve38`, fusion reference ANN-004. */
export const ISOLATION_VALVE_SCENE: FieldScene = {
  id: "SCN-GATE-VALVE",
  title: "Handwheel gate valve — field inspection",
  equipment: "Handwheel gate valve",
  duty: "Isolates the line: operated fully open or fully closed, never used to throttle.",
  image: "/demo/fusion/asset-valve38-isolation-valve.png",
  imageWidth: 1448,
  imageHeight: 1086,
  provenance: "generated",
  anchorRule: "registered",
  preferredAnchors: ["valve38"],
  expectedCategories: ["hand-valve"],
  process: { kind: "isolation-valve", basis: { portMm: 150, leadMm: 6 } },
  impact: "the isolation boundary it forms and what it would leave pressurised",
  detections: [
    {
      id: "G1",
      label: "Gate body",
      cls: "valve",
      role: "anchor-body",
      box: [508, 605, 946, 980],
      description: "Cast wedge-gate body with integral end flanges.",
    },
    {
      id: "G2",
      label: "Bonnet",
      cls: "bonnet",
      role: "anchor-body",
      box: [576, 398, 870, 610],
      description: "Bolted bonnet enclosing the wedge in its raised position.",
    },
    {
      id: "G3",
      label: "Yoke and stem",
      cls: "yoke",
      role: "anchor-body",
      box: [645, 160, 805, 398],
      description: "Yoke over the gland, with the threaded rising stem.",
    },
    {
      id: "G4",
      label: "Handwheel",
      cls: "handwheel",
      role: "anchor-body",
      box: [505, 50, 968, 140],
      description: "Spoked handwheel driving the stem nut.",
    },
    {
      id: "G5",
      label: "Line flange and pipe (left)",
      cls: "flange",
      role: "inlet-side",
      run: 0,
      box: [0, 615, 515, 980],
      description: "Mating pipe flange and run on the left end.",
    },
    {
      id: "G6",
      label: "Line flange and pipe (right)",
      cls: "flange",
      role: "outlet-side",
      run: 1,
      box: [940, 615, 1448, 985],
      description: "Mating pipe flange and run on the right end.",
    },
  ],
};

/** Inline flow measurement — `instrumentation31`, fusion reference ANN-009. */
export const FLOWMETER_SCENE: FieldScene = {
  id: "SCN-MAGMETER",
  title: "Electromagnetic flowmeter — field inspection",
  equipment: "Electromagnetic flow meter",
  duty: "Measures volumetric flow of a conductive liquid from the EMF it induces in a magnetic field.",
  image: "/demo/fusion/asset-instrumentation31-magnetic-flowmeter.png",
  imageWidth: 1448,
  imageHeight: 1086,
  provenance: "generated",
  anchorRule: "registered",
  preferredAnchors: ["instrumentation31"],
  expectedCategories: ["instrument"],
  process: {
    kind: "flowmeter",
    // DN80 bore, matching the 3-inch run the register puts this meter on.
    basis: { boreM: 0.0779, urvM3h: 100, velocityMin: 0.3, velocityMax: 10 },
  },
  impact: "the flow reading and the loop it feeds",
  caveat:
    "A magnetic meter needs a conductive liquid and cannot meter steam; the register's main-steam line code for this run is therefore not a verified service.",
  detections: [
    {
      id: "F1",
      label: "Flow tube",
      cls: "flow-tube",
      role: "anchor-body",
      box: [582, 450, 935, 848],
      description: "Lined measuring tube housing the field coils and electrodes.",
    },
    {
      id: "F2",
      label: "Transmitter head",
      cls: "housing",
      role: "anchor-body",
      box: [598, 80, 908, 305],
      description: "Compact transmitter with local display and keypad.",
    },
    {
      id: "F3",
      label: "Sensor neck and adapter",
      cls: "housing",
      role: "anchor-body",
      box: [646, 305, 834, 452],
      description: "Neck and bolted adapter joining the transmitter to the flow tube.",
    },
    {
      id: "F4",
      label: "Cable glands and signal cable",
      cls: "cable",
      role: "anchor-body",
      box: [470, 108, 628, 452],
      description: "Two cable entries: power and the 4–20 mA signal.",
    },
    {
      id: "F5",
      label: "Process flange pair (left)",
      cls: "flange",
      role: "inlet-side",
      run: 0,
      box: [345, 415, 592, 900],
      description: "Meter flange bolted to the line flange on the left.",
    },
    {
      id: "F6",
      label: "Process flange pair (right)",
      cls: "flange",
      role: "outlet-side",
      run: 1,
      box: [895, 415, 1150, 870],
      description: "Meter flange bolted to the line flange on the right.",
    },
  ],
};

/** Vessel level measurement — `instrumentation42`, fusion reference ANN-010. */
export const RADAR_LEVEL_SCENE: FieldScene = {
  id: "SCN-RADAR-LEVEL",
  title: "Radar level transmitter — field inspection",
  equipment: "Radar level transmitter",
  duty: "Measures liquid level from the round-trip time of a microwave pulse to the surface.",
  image: "/demo/fusion/asset-instrumentation42-radar-level-transmitter.png",
  imageWidth: 1448,
  imageHeight: 1086,
  provenance: "generated",
  anchorRule: "registered",
  preferredAnchors: ["instrumentation42"],
  expectedCategories: ["instrument"],
  process: {
    kind: "level-transmitter",
    basis: { referenceM: 10, blockingM: 0.4, lrvM: 0.5, urvM: 9.0 },
  },
  impact: "the level reading and any interlock that trips on it",
  caveat:
    "This transmitter's symbol has no connection on the drawing, so the vessel it stands on cannot be identified; the vessel geometry in the process view is assumed.",
  detections: [
    {
      id: "L1",
      label: "Vessel roof",
      cls: "vessel",
      role: "host-vessel",
      box: [0, 850, 1448, 1086],
      description: "Domed roof of the vessel the transmitter is mounted on.",
    },
    {
      id: "L2",
      label: "Roof nozzle",
      cls: "nozzle",
      role: "host-vessel",
      box: [565, 838, 860, 985],
      description: "Instrument nozzle welded into the roof.",
    },
    {
      id: "L3",
      label: "Process flange pair",
      cls: "flange",
      role: "anchor-body",
      box: [478, 655, 935, 858],
      description: "Transmitter flange bolted to the nozzle flange.",
    },
    {
      id: "L4",
      label: "Mounting bracket and cable",
      cls: "cable",
      role: "anchor-body",
      box: [762, 455, 972, 690],
      description: "Clamp bracket on a stand-off post, carrying the signal cable.",
    },
    {
      id: "L5",
      label: "Antenna adapter",
      cls: "antenna",
      role: "anchor-body",
      box: [624, 432, 802, 702],
      description:
        "Stainless process connection carrying the horn antenna into the nozzle.",
    },
    {
      id: "L6",
      label: "Transmitter housing",
      cls: "housing",
      role: "anchor-body",
      box: [548, 68, 908, 432],
      description: "Dual-compartment housing with local display and cable glands.",
    },
  ],
};

/** Temperature measurement — `instrumentation25`, fusion reference ANN-008. */
export const TEMPERATURE_SCENE: FieldScene = {
  id: "SCN-TEMPERATURE",
  title: "Temperature transmitter — field inspection",
  equipment: "Head-mounted temperature transmitter",
  duty: "Measures line temperature with a sensor in a flanged thermowell and transmits it as 4–20 mA.",
  image: "/demo/fusion/asset-instrumentation25-temperature-transmitter.png",
  imageWidth: 1448,
  imageHeight: 1086,
  provenance: "generated",
  anchorRule: "registered",
  preferredAnchors: ["instrumentation25"],
  expectedCategories: ["instrument"],
  process: {
    kind: "temperature-transmitter",
    // Range spans the register's temperature alarms (150 / 245 °C) with margin.
    basis: { lrvC: 0, urvC: 300, tauS: 30, initialC: 200 },
  },
  impact: "the temperature reading and any loop or trip that acts on it",
  detections: [
    {
      id: "T1",
      label: "Transmitter housing",
      cls: "housing",
      role: "anchor-body",
      box: [560, 82, 862, 345],
      description: "Dual-compartment head with local display; the transmitter electronics.",
    },
    {
      id: "T2",
      label: "Cable gland",
      cls: "cable",
      role: "anchor-body",
      box: [852, 110, 932, 196],
      description: "Cable entry for the 4–20 mA signal cable.",
    },
    {
      id: "T3",
      label: "Extension neck",
      cls: "housing",
      role: "anchor-body",
      box: [655, 340, 760, 590],
      description:
        "Lagging extension and threaded union standing the head off the hot connection.",
    },
    {
      id: "T4",
      label: "Thermowell flange pair",
      cls: "flange",
      role: "anchor-body",
      box: [610, 585, 802, 700],
      description: "Flanged thermowell bolted to the nozzle flange.",
    },
    {
      id: "T5",
      label: "Thermowell nozzle",
      cls: "nozzle",
      role: "inlet-side",
      run: 0,
      box: [630, 695, 782, 835],
      description: "Short nozzle on a weld boss, carrying the thermowell into the line.",
    },
    {
      id: "T6",
      label: "Insulated process pipe",
      cls: "line",
      role: "inlet-side",
      run: 0,
      box: [0, 790, 1448, 1086],
      description: "Clad, insulated pipe run the thermowell measures.",
    },
  ],
};

/** Every scene the twin can show, the exchanger first so it opens on the familiar view. */
export const TWIN_SCENES: readonly FieldScene[] = [
  HEAT_EXCHANGER_SCENE,
  KNOCKOUT_DRUM_SCENE,
  CONTROL_VALVE_SCENE,
  ISOLATION_VALVE_SCENE,
  FLOWMETER_SCENE,
  TEMPERATURE_SCENE,
  RADAR_LEVEL_SCENE,
];
