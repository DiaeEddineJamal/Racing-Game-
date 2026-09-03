import type { TrackDefinition } from '../../core/types';
import { SEA_SPRAY } from '../weather';

/**
 * Agadir Coast - seafront circuit.
 * Long promenade straight -> wide bay sweeper -> marina chicane -> a fast run
 * back down the beach -> a broad U-turn under the palms onto the promenade.
 * ~1150 m.
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
    { x: 0, y: 0, z: -76.8 },
    { x: 0, y: 0.6, z: -153.6 },
    { x: 4.8, y: 1.2, z: -223.2 },
    { x: 31.2, y: 1.6, z: -276 }, // bay sweeper
    { x: 81.6, y: 1.8, z: -307.2 },
    { x: 139.2, y: 1.8, z: -309.6 },
    { x: 184.8, y: 1.4, z: -283.2 },
    { x: 208.8, y: 0.8, z: -237.6 },
    { x: 211.2, y: 0.4, z: -184.8 },
    { x: 187.2, y: 0, z: -141.6 }, // marina chicane, left then right
    { x: 153.6, y: 0, z: -115.2 },
    { x: 156, y: 0, z: -69.6 },
    { x: 187.2, y: 0, z: -33.6 },
    { x: 199.2, y: 0, z: 16.8 }, // beach straight
    { x: 184.8, y: 0, z: 64.8 },
    { x: 144, y: 0, z: 96 },
    { x: 93.6, y: 0, z: 103.2 }, // palm U-turn
    { x: 48, y: 0, z: 93.6 },
    { x: 14.4, y: 0, z: 64.8 },
    { x: 0, y: 0, z: 24 },
  ],
  halfWidth: 8.5,
  halfWidths: [9, 9, 9, 8.5, 8.5, 8.5, 8.5, 8.5, 8.5, 8, 7.5, 7.5, 7.5, 8, 8.5, 8.5, 8.5, 9, 9, 9, 9],
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
