import type { TrackDefinition } from '../../core/types';
import { VOLCANIC_ASH } from '../weather';

/**
 * Jbel Inferno - volcano circuit.
 * A long climb out of the ash field onto the caldera rim, a flat-out plateau
 * across the crater lip, then a plunging descent and a fast lower loop past the
 * lava runs. ~1150 m.
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
    { x: 0, y: 2, z: -69.6 },
    { x: 2.4, y: 5, z: -139.2 }, // the climb
    { x: 21.6, y: 8, z: -199.2 },
    { x: 64.8, y: 9, z: -240 },
    { x: 122.4, y: 9, z: -249.6 }, // crater lip, flat out
    { x: 177.6, y: 7, z: -230.4 },
    { x: 208.8, y: 4, z: -182.4 },
    { x: 213.6, y: 1, z: -124.8 }, // the plunge
    { x: 201.6, y: 0, z: -72 },
    { x: 172.8, y: 0, z: -28.8 },
    { x: 180, y: 0, z: 24 }, // lower loop past the lava runs
    { x: 206.4, y: 0, z: 67.2 },
    { x: 199.2, y: 0, z: 120 },
    { x: 166, y: 0, z: 156 }, // switchback out of the ash bowl
    { x: 122, y: 0, z: 168 },
    { x: 86, y: 0, z: 150 },
    { x: 48, y: 0, z: 152 },
    { x: 18, y: 0, z: 130 },
    { x: 4.8, y: 0, z: 88.8 },
    { x: 0, y: 0, z: 40.8 },
  ],
  halfWidth: 8.5,
  halfWidths: [9, 8.5, 8.5, 8, 8, 8.5, 8.5, 8, 8, 8, 8, 8, 8.5, 8.5, 8.5, 8.5, 8, 8, 8.5, 8.5, 9],
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
