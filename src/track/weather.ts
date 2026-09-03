/**
 * Weather presets, one per circuit.
 *
 * Kept out of the track files so the six definitions stay readable and so two
 * circuits can share a sky if they ever want to. Counts are budgets before the
 * quality profile scales them, and every layer is one draw call - see
 * fx/Weather.ts for how they are drawn.
 *
 * The layer order matters: the near/ground layer goes last so it composites
 * over the tall one.
 */
import type { WeatherDef } from '../core/types';

/** Atlas Frostbite: thick flakes plus spindrift skating over the ice. */
export const SNOWFALL: WeatherDef = {
  layers: [
    {
      kind: 'snow',
      // A tighter box around the camera: the same flakes read as real snowfall
      // instead of scattering thin over a volume most of which is too far away
      // to see.
      count: 1900,
      size: { x: 95, y: 48, z: 95 },
      yOffset: 12,
      fall: 3.4,
      wind: { x: 2.6, z: -1.4 },
      gust: 2.6,
      sway: 0.6,
      size0: 0.07,
      size1: 0.24,
      color: 0xffffff,
      opacity: 0.9,
      stretch: 1,
      settle: true,
    },
    {
      kind: 'snow',
      count: 520,
      size: { x: 100, y: 5, z: 100 },
      yOffset: -1.2,
      fall: 0.25,
      wind: { x: 8, z: -4 },
      gust: 5.5,
      sway: 0.25,
      size0: 0.05,
      size1: 0.18,
      color: 0xeaf4ff,
      opacity: 0.5,
      stretch: 0.55,
      settle: true,
    },
  ],
};

/** Merzouga Dunes: sand driven flat across the course by a hot side wind. */
export const SANDSTORM: WeatherDef = {
  layers: [
    {
      kind: 'sand',
      count: 1100,
      size: { x: 170, y: 55, z: 170 },
      yOffset: 10,
      fall: 0.8,
      wind: { x: 24, z: 9 },
      gust: 10,
      sway: 0.35,
      size0: 0.05,
      size1: 0.16,
      color: 0xe8c48a,
      opacity: 0.38,
      stretch: 0.35,
    },
    {
      kind: 'sand',
      count: 480,
      size: { x: 110, y: 4, z: 110 },
      yOffset: -1,
      fall: 0.1,
      wind: { x: 30, z: 11 },
      gust: 12,
      sway: 0.2,
      size0: 0.12,
      size1: 0.5,
      color: 0xd8b184,
      opacity: 0.22,
      stretch: 0.25,
    },
  ],
};

/** Agadir Coast: sea spray off the Atlantic and sun motes over the sand. */
export const SEA_SPRAY: WeatherDef = {
  layers: [
    {
      kind: 'spray',
      count: 420,
      size: { x: 140, y: 40, z: 140 },
      yOffset: 8,
      fall: 1.6,
      wind: { x: -7, z: 3.5 },
      gust: 4.5,
      sway: 0.5,
      size0: 0.06,
      size1: 0.2,
      color: 0xdff2ff,
      opacity: 0.32,
      stretch: 0.7,
      settle: true,
    },
    {
      kind: 'spray',
      count: 210,
      size: { x: 90, y: 26, z: 90 },
      yOffset: 5,
      fall: 0.3,
      wind: { x: -1.6, z: 0.8 },
      gust: 1.2,
      sway: 1.1,
      size0: 0.03,
      size1: 0.09,
      color: 0xfff0cc,
      opacity: 0.3,
      stretch: 1,
      additive: true,
    },
  ],
};

/** Menara Meadows: pollen catching the light, blossom drifting down through it. */
export const MEADOW_POLLEN: WeatherDef = {
  layers: [
    {
      kind: 'petals',
      count: 420,
      size: { x: 100, y: 40, z: 100 },
      yOffset: 6,
      fall: 0.5,
      wind: { x: 2.2, z: 1.2 },
      gust: 1.6,
      sway: 0.9,
      size0: 0.035,
      size1: 0.1,
      color: 0xfff3b0,
      opacity: 0.45,
      stretch: 1,
      additive: true,
    },
    {
      kind: 'petals',
      count: 180,
      size: { x: 90, y: 34, z: 90 },
      yOffset: 7,
      fall: 1.3,
      wind: { x: 2.8, z: 1.5 },
      gust: 2,
      sway: 1.7,
      size0: 0.09,
      size1: 0.22,
      color: 0xffc7e2,
      opacity: 0.75,
      stretch: 0.8,
      settle: true,
    },
  ],
};

/** Jbel Inferno: embers climbing out of the caldera, ash coming back down. */
export const VOLCANIC_ASH: WeatherDef = {
  layers: [
    {
      kind: 'ash',
      count: 750,
      size: { x: 130, y: 60, z: 130 },
      yOffset: 12,
      fall: 1.7,
      wind: { x: -2.2, z: 1.6 },
      gust: 2.2,
      sway: 0.7,
      size0: 0.05,
      size1: 0.16,
      color: 0x6b6158,
      opacity: 0.45,
      stretch: 1,
      settle: true,
    },
    {
      kind: 'embers',
      count: 320,
      size: { x: 110, y: 55, z: 110 },
      yOffset: 6,
      fall: -6,
      wind: { x: 1.5, z: -2 },
      gust: 3.5,
      sway: 0.9,
      size0: 0.05,
      size1: 0.17,
      color: 0xff8a2a,
      opacity: 0.7,
      stretch: 1.4,
      additive: true,
    },
  ],
};

/** Casa Neon: night rain, road mist and lightning over the harbour. */
export const NEON_RAIN: WeatherDef = {
  lightning: 11,
  lightningColor: 0xcfe0ff,
  layers: [
    {
      kind: 'rain',
      count: 1500,
      size: { x: 120, y: 65, z: 120 },
      yOffset: 14,
      fall: 27,
      wind: { x: 3.5, z: -1.5 },
      gust: 3,
      sway: 0.05,
      size0: 0.05,
      size1: 0.14,
      color: 0xbfd8ff,
      opacity: 0.4,
      stretch: 3.4,
      settle: true,
    },
    {
      kind: 'rain',
      count: 380,
      size: { x: 90, y: 4, z: 90 },
      yOffset: -0.8,
      fall: 0.1,
      wind: { x: 5, z: -2 },
      gust: 3,
      sway: 0.2,
      size0: 0.12,
      size1: 0.45,
      color: 0x9fc6ff,
      opacity: 0.15,
      stretch: 0.5,
    },
  ],
};
