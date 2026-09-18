/**
 * Deterministic noise for simulated training signals.
 *
 * A real loss trace is two things superimposed: per-step sampling noise (each optimiser step
 * sees a different batch) and a slow wander (data-mixture drift, learning-rate schedule
 * interacting with curvature). Re-rolling one random value per coarse bucket — what this
 * module replaces — produces neither: it draws flat plateaus joined by cliffs, which reads as
 * a staircase the moment a chart zooms in.
 *
 * Everything here is a pure function of a seed and a coordinate, so two tabs agree, a paused
 * run is frozen byte-for-byte, and a test can ask for step 70,000 directly. Seeds are hashed
 * once per key and then mixed with integers, which keeps a few thousand samples per render
 * well under a millisecond.
 */

import { hashString } from "@/lib/canvas/engineering";

/** A 32-bit seed for a stable string key. Hash once, reuse for every sample. */
export function seedOf(key: string): number {
  return hashString(key);
}

/**
 * Uniform value in [0, 1) for (seed, integer). Murmur3's 32-bit finaliser over the two
 * words combined: every output bit depends on every input bit, so neighbouring integers are
 * uncorrelated.
 */
export function unit(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index | 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Uniform value in [-1, 1) — independent per integer. */
export function white(seed: number, index: number): number {
  return unit(seed, index) * 2 - 1;
}

/** Approximately standard-normal value per integer (Box–Muller over two lattice draws). */
export function gaussian(seed: number, index: number): number {
  const u1 = Math.max(1e-12, unit(seed, index * 2));
  const u2 = unit(seed, index * 2 + 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Quintic ease: zero first and second derivative at both ends, so joins are invisible. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smooth value noise in [-1, 1] with unit lattice spacing. Continuous in `x`. */
export function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const t = fade(x - i);
  const a = white(seed, i);
  const b = white(seed, i + 1);
  return a + (b - a) * t;
}

/**
 * Fractal noise: `octaves` layers of value noise, each at twice the frequency and half the
 * amplitude of the last, normalised back into roughly [-1, 1]. Gives a signal that wanders
 * at large scale and still has texture when zoomed.
 */
export function fbm(seed: number, x: number, octaves = 3): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += amplitude * valueNoise(seed + octave * 0x2545f491, x * frequency);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}

/** Linear interpolation between `a` and `b`. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
