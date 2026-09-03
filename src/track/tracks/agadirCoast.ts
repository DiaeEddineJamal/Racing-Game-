import type { TrackDefinition } from '../../core/types';
import { SEA_SPRAY } from '../weather';

/**
 * Agadir Coast - seaside circuit.
 * A promenade esse onto the long bay sweeper, then the technical half: a tight
 * hairpin in the marina, a chicane across the beach straight and a kink into
 * the palm-lined run home. ~1200 m.
 */
export const agadirCoast: TrackDefinition = {
  id: 'agadir',
  name: 'Agadir Coast',
  theme: 'beach',
  laps: 3,
  description: 'Sea spray on the promenade, a chicane through the marina and sand waiting either side of it.',
  difficulty: 2,
  controlPoints: [
    { x: 0, y: 0, z: 0 }, // 0 finish line, promenade straight
    { x: 0, y: 0, z: -80 },
    { x: 14, y: 0.6, z: -116 }, // promenade esse
    { x: 4, y: 1, z: -160 },
    { x: 2, y: 1.2, z: -212 },
    { x: 28, y: 1.6, z: -270 }, // bay sweeper
    { x: 80, y: 1.8, z: -306 },
    { x: 140, y: 1.8, z: -310 },
    { x: 186, y: 1.4, z: -284 },
    { x: 210, y: 0.8, z: -238 },
    { x: 212, y: 0.4, z: -186 },
    { x: 188, y: 0, z: -150 }, // into the marina
    { x: 150, y: 0, z: -142 }, // marina hairpin in
    { x: 126, y: 0, z: -114 }, // apex
    { x: 146, y: 0, z: -88 }, // out
    { x: 186, y: 0, z: -84 },
    { x: 206, y: 0, z: -52 },
    { x: 200, y: 0, z: -8 }, // beach chicane
    { x: 214, y: 0, z: 34 },
    { x: 190, y: 0, z: 74 },
    { x: 146, y: 0, z: 100 },
    { x: 120, y: 0, z: 114 }, // kink into the palms
    { x: 80, y: 0, z: 104 },
    { x: 44, y: 0, z: 92 },
    { x: 12, y: 0, z: 64 },
    { x: 0, y: 0, z: 24 },
  ],
  halfWidth: 8.5,
  halfWidths: [9, 9, 8.5, 8.5, 8.5, 8.5, 9, 9, 8.5, 8.5, 8.5, 8, 8, 8.5, 8.5, 8.5, 8, 8, 8.5, 8.5, 8.5, 8, 8.5, 8.5, 9, 9],
  wallHalfWidthFactor: 1.5,
  itemBoxRows: [0.08, 0.33, 0.56, 0.8],
  boostPads: [0.2, 0.62, 0.9],
  environment: {
    skyTop: 0x1f7ad6,
    skyHorizon: 0xbfe6ff,
    skyBottom: 0xeaf7ff,
    fogColor: 0xd6efff,
    fogDensity: 0.0014,
    sunColor: 0xfff4dc,
    sunIntensity: 2.7,
    sunDirection: { x: -0.4, y: 0.76, z: 0.5 },
    ambientSky: 0xa8dcff,
    ambientGround: 0xd9c49a,
    ambientIntensity: 0.95,
    weather: SEA_SPRAY,
  },
  palette: {
    road: 0x4e5058,
    roadStripe: 0xf6f6ee,
    curb: 0x1f7ad6,
    curbAlt: 0xf5f5f5,
    offroad: 0xe0c893,
    wall: 0x2b2b30,
    ground: 0xe6cf9d,
  },
};
