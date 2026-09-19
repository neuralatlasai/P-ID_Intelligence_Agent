/**
 * Small, honest process views for the field scenes that are not heat exchangers.
 *
 * Each asset class gets the one relation an engineer would reach for first when looking at
 * it — holdup and head pressure for a vessel, the inherent characteristic for a control
 * valve, port area against stem travel for a gate valve, velocity to volumetric flow for a
 * magnetic meter, and time of flight for a radar gauge. Every relation is a textbook one
 * with its units stated; every basis figure (bore, Kvs, density, reference height) is an
 * assumption held here, in one place, and shown in the view as assumed. None of it is plant
 * data, and the view says so.
 */

/** Standard gravity, m/s². */
const G = 9.80665;
/** Speed of light, m/s. Radar in vapour space; the refractive-index correction is below 0.1 %. */
const C = 299_792_458;

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

// ────────────────────────────────────────────────────────────────────────────────────────────
// Vertical vessel: holdup, head pressure, time to alarm
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface VesselBasis {
  /** Inside diameter, m. */
  readonly idM: number;
  /** Tangent-to-tangent shell height, m. */
  readonly tangentM: number;
  /** Liquid height, measured from the bottom of the lower head, that reads 100 %. */
  readonly spanM: number;
  /** Liquid density, kg/m³. */
  readonly densityKgM3: number;
  /** Vapour-space pressure, barg. */
  readonly operatingBarg: number;
  /** Design liquid outflow, m³/h, for residence time. */
  readonly outflowM3h: number;
  /** Level alarm set points, % of span. Matches the register's level alarms. */
  readonly alarmLowPct: number;
  readonly alarmHighPct: number;
  readonly fluid: string;
}

/**
 * Liquid volume in a vertical vessel with 2:1 semi-elliptical heads, m³.
 *
 * The lower head is an ellipsoid of revolution with depth c = D/4, so a slice at height u
 * has area πR²(2u/c − u²/c²); integrating gives πR²(z²/c − z³/3c²), which reaches the
 * familiar πD³/24 at z = c. Above the head the shell is a plain cylinder; the upper head
 * mirrors the lower one.
 */
export function vesselVolume(basis: VesselBasis, heightM: number): number {
  const r = basis.idM / 2;
  const c = basis.idM / 4;
  const area = Math.PI * r * r;
  const head = (z: number) => area * ((z * z) / c - (z * z * z) / (3 * c * c));
  const full = head(c);
  const total = basis.tangentM + 2 * c;
  const z = clamp(heightM, 0, total);
  if (z <= c) return head(z);
  if (z <= c + basis.tangentM) return full + area * (z - c);
  return 2 * full + area * basis.tangentM - head(total - z);
}

export interface VesselState {
  readonly heightM: number;
  readonly holdupM3: number;
  /** Pressure at the bottom outlet nozzle: vapour space plus liquid head, barg. */
  readonly bottomBarg: number;
  /** Residence time at the design outflow, min. */
  readonly residenceMin: number;
  /**
   * Minutes until the level reaches the alarm the imbalance is driving it towards, or
   * undefined when the level is steady or already past it.
   */
  readonly toAlarmMin: number | undefined;
  readonly toward: "high" | "low" | undefined;
}

export function vesselState(
  basis: VesselBasis,
  levelPct: number,
  imbalanceM3h: number,
): VesselState {
  const heightM = (clamp(levelPct, 0, 100) / 100) * basis.spanM;
  const holdupM3 = vesselVolume(basis, heightM);
  const bottomBarg = basis.operatingBarg + (basis.densityKgM3 * G * heightM) / 1e5;
  const toward = imbalanceM3h > 0 ? "high" : imbalanceM3h < 0 ? "low" : undefined;
  let toAlarmMin: number | undefined;
  if (toward) {
    const alarm = toward === "high" ? basis.alarmHighPct : basis.alarmLowPct;
    const target = vesselVolume(basis, (alarm / 100) * basis.spanM);
    const hours = (target - holdupM3) / imbalanceM3h;
    toAlarmMin = hours > 0 ? hours * 60 : undefined;
  }
  return {
    heightM,
    holdupM3,
    bottomBarg,
    residenceMin: (holdupM3 / basis.outflowM3h) * 60,
    toAlarmMin,
    toward,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Control valve: equal-percentage inherent characteristic
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface ControlValveBasis {
  /** Flow coefficient at rated travel, m³/h at 1 bar ΔP with water. */
  readonly kvs: number;
  /** Inherent rangeability Kvs / Kv₀. */
  readonly rangeability: number;
  /** Default pressure drop across the valve, bar. */
  readonly dpBar: number;
  /** Specific gravity of the liquid the equivalent flow is quoted for. */
  readonly sg: number;
}

/**
 * Kv at a travel fraction, for an equal-percentage trim: Kv = Kvs · R^(x − 1).
 * Each increment of travel changes Kv by the same *percentage* of its current value, which
 * is what keeps loop gain roughly constant as the installed ΔP falls with rising flow. The
 * curve's theoretical intercept at x = 0 is Kvs/R; the seat shuts there, so 0 is returned.
 */
export function equalPercentageKv(basis: ControlValveBasis, travel: number): number {
  const x = clamp(travel, 0, 1);
  return x <= 0 ? 0 : basis.kvs * basis.rangeability ** (x - 1);
}

/** Liquid flow through a coefficient, IEC 60534 basic form, non-choked: Q = Kv·√(ΔP/SG). */
export function liquidFlowM3h(kv: number, dpBar: number, sg: number): number {
  return kv * Math.sqrt(Math.max(0, dpBar) / sg);
}

/** Percentage change in flow for one percent of travel, at constant ΔP: ln(R). */
export function equalPercentageGainPct(basis: ControlValveBasis): number {
  return Math.log(basis.rangeability);
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Gate valve: port area against stem travel
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface GateValveBasis {
  /** Round port bore, mm. */
  readonly portMm: number;
  /** Stem advance per handwheel turn, mm. */
  readonly leadMm: number;
}

/**
 * Open fraction of a round port as a flat gate lifts through it.
 *
 * With the gate raised by h, the open part of a port of radius r is the circular segment of
 * height h: r²·acos((r − h)/r) − (r − h)·√(2rh − h²), divided by πr². This is geometry, not a
 * flow characteristic — and it is why a gate valve is an isolation valve: half the travel
 * already opens half the port, and the last third barely changes the flow area.
 */
export function gateOpenFraction(travel: number): number {
  const h = clamp(travel, 0, 1) * 2; // gate lift over a port of radius 1
  const r = 1;
  if (h <= 0) return 0;
  if (h >= 2) return 1;
  const segment = r * r * Math.acos((r - h) / r) - (r - h) * Math.sqrt(2 * r * h - h * h);
  return segment / (Math.PI * r * r);
}

export function gateTurns(basis: GateValveBasis, travel: number): number {
  return (clamp(travel, 0, 1) * basis.portMm) / basis.leadMm;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Electromagnetic flowmeter: velocity to volumetric flow
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface MagmeterBasis {
  /** Inside bore of the flow tube, m. */
  readonly boreM: number;
  /** Flow at 20 mA, m³/h. */
  readonly urvM3h: number;
  /** Velocity window the meter is specified for, m/s. */
  readonly velocityMin: number;
  readonly velocityMax: number;
}

/** Q = v · πD²/4, in m³/h. Faraday's law makes the electrode EMF proportional to v. */
export function magmeterFlowM3h(basis: MagmeterBasis, velocity: number): number {
  return Math.max(0, velocity) * ((Math.PI * basis.boreM * basis.boreM) / 4) * 3600;
}

/** A 4–20 mA output over 0–URV, clamped to the NAMUR NE 43 signal band 3.8–20.5 mA. */
export function loopCurrentMa(value: number, lrv: number, urv: number): number {
  return clamp(4 + (16 * (value - lrv)) / (urv - lrv), 3.8, 20.5);
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Radar level transmitter: reading against true level
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface RadarBasis {
  /** Reference point (flange face) above the vessel bottom, m. */
  readonly referenceM: number;
  /** Near-zone below the antenna where the echo cannot be separated, m. */
  readonly blockingM: number;
  /** Level at 4 mA and 20 mA, m above the bottom. */
  readonly lrvM: number;
  readonly urvM: number;
}

export interface RadarState {
  /** Distance from the reference point to the liquid surface, m. */
  readonly distanceM: number;
  /** Echo round trip, ns: t = 2d/c. */
  readonly roundTripNs: number;
  /** Level the transmitter reports, m; undefined inside the blocking distance. */
  readonly readingM: number | undefined;
  readonly currentMa: number | undefined;
}

export function radarState(basis: RadarBasis, trueLevelM: number): RadarState {
  const level = clamp(trueLevelM, 0, basis.referenceM);
  const distanceM = basis.referenceM - level;
  const valid = distanceM >= basis.blockingM;
  const readingM = valid ? basis.referenceM - distanceM : undefined;
  return {
    distanceM,
    roundTripNs: ((2 * distanceM) / C) * 1e9,
    readingM,
    currentMa:
      readingM === undefined ? undefined : loopCurrentMa(readingM, basis.lrvM, basis.urvM),
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Temperature transmitter: Pt100 in a thermowell
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface TemperatureBasis {
  /** Temperature at 4 mA and 20 mA, °C. */
  readonly lrvC: number;
  readonly urvC: number;
  /** First-order time constant of sensor in thermowell, s. */
  readonly tauS: number;
  /** Line temperature before the step, °C. */
  readonly initialC: number;
}

/** IEC 60751 Callendar–Van Dusen coefficients for a Pt100, valid 0–850 °C. */
const PT100 = { r0: 100, a: 3.9083e-3, b: -5.775e-7 } as const;

/** Pt100 resistance, Ω, for 0 °C ≤ t ≤ 850 °C: R = R₀(1 + At + Bt²). */
export function pt100Ohms(temperatureC: number): number {
  const t = clamp(temperatureC, 0, 850);
  return PT100.r0 * (1 + PT100.a * t + PT100.b * t * t);
}

/**
 * What a sensor in a thermowell reads a time after the line steps from one temperature to
 * another: a first-order lag, T(t) = T₀ + (T₁ − T₀)(1 − e^(−t/τ)). It reaches 63 % of the step
 * at one time constant and 98 % at four — which is why a thermowell reading trails the line.
 */
export function laggedReadingC(
  basis: TemperatureBasis,
  stepToC: number,
  secondsAfter: number,
): number {
  const t = Math.max(0, secondsAfter);
  return basis.initialC + (stepToC - basis.initialC) * (1 - Math.exp(-t / basis.tauS));
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Per-scene process specification
// ────────────────────────────────────────────────────────────────────────────────────────────

export type ProcessSpec =
  | { readonly kind: "exchanger" }
  | { readonly kind: "vessel"; readonly basis: VesselBasis }
  | { readonly kind: "control-valve"; readonly basis: ControlValveBasis }
  | { readonly kind: "isolation-valve"; readonly basis: GateValveBasis }
  | { readonly kind: "flowmeter"; readonly basis: MagmeterBasis }
  | { readonly kind: "temperature-transmitter"; readonly basis: TemperatureBasis }
  | { readonly kind: "level-transmitter"; readonly basis: RadarBasis };
