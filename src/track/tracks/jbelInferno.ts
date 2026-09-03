import type { TrackDefinition } from '../../core/types';
import { VOLCANIC_ASH } from '../weather';

/**
 * Jbel Inferno - volcano circuit.
 * A climb out of the ash field with a kink and a sweeper, a chicane across the
 * crater lip, then a plunging descent through two esses, a tight hairpin at the
 * lava runs and a triple switchback back to the line. ~1200 m.
 */
export const jbelInferno: TrackDefinition = {
  id: 'jbel',
  name: 'Jbel Inferno',
  theme: 'volcano',
  laps: 3,
  description: 'Climb the caldera rim, cross the crater lip flat out, then fall back down through the lava runs.',
  difficulty: 3,
  controlPoints: [
    { x: 0, y: 0, z: 0 }, // 0 finish line, ash field
    { x: 0, y: 1.5, z: -62 },
    { x: 6, y: 3.5, z: -118 }, // kink right, into the climb
    { x: 30, y: 5.5, z: -160 },
    { x: 62, y: 7.5, z: -186 }, // sweeper onto the rim
    { x: 104, y: 9, z: -196 },
    { x: 150, y: 9, z: -190 }, // crater lip chicane, right then left
    { x: 166, y: 9, z: -154 },
    { x: 200, y: 8.5, z: -146 },
    { x: 214, y: 7, z: -122 }, // over the edge, the plunge starts
    { x: 210, y: 4.5, z: -84 }, // esse right
    { x: 186, y: 2.5, z: -60 }, // esse left
    { x: 190, y: 1, z: -24 },
    { x: 214, y: 0, z: 12 }, // out to the lava runs
    { x: 232, y: 0, z: 30 }, // hairpin in
    { x: 238, y: 0, z: 56 }, // hairpin apex
    { x: 214, y: 0, z: 74 }, // hairpin out
    { x: 200, y: 0, z: 86 },
    { x: 172, y: 0, z: 112 }, // double-apex left
    { x: 140, y: 0, z: 118 },
    { x: 116, y: 0, z: 142 },
    { x: 82, y: 0, z: 158 }, // switchback back onto the ash field
    { x: 48, y: 0, z: 150 },
    { x: 18, y: 0, z: 140 },
    { x: 2, y: 0, z: 108 },
    { x: 0, y: 0, z: 62 },
  ],
  halfWidth: 8.5,
  halfWidths: [9, 9, 8.5, 8.5, 8.5, 8.5, 8, 8, 8.5, 8.5, 8, 8, 8.5, 8.5, 8.5, 9, 9, 8.5, 8, 8, 8.5, 8.5, 8, 8, 8.5, 9],
  wallHalfWidthFactor: 1.45,
  itemBoxRows: [0.12, 0.36, 0.6, 0.85],
  boostPads: [0.26, 0.52, 0.78],
  environment: {
    skyTop: 0x2a1220,
    skyHorizon: 0xc4491c,
    skyBottom: 0x5a1c10,
    fogColor: 0x7a2a16,
    fogDensity: 0.0042,
    sunColor: 0xffb066,
    sunIntensity: 1.9,
    sunDirection: { x: 0.5, y: 0.5, z: -0.7 },
    ambientSky: 0xff7a3c,
    ambientGround: 0x3a1408,
    ambientIntensity: 0.75,
    weather: VOLCANIC_ASH,
  },
  palette: {
    road: 0x33313a,
    roadStripe: 0xf0e6d8,
    curb: 0xff5a1e,
    curbAlt: 0x24222a,
    offroad: 0x4a3128,
    wall: 0x201c22,
    ground: 0x3b2a24,
  },
};
