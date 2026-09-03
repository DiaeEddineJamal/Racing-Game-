import type { TrackDefinition } from '../../core/types';
import { SNOWFALL } from '../weather';

/**
 * Frostbite Falls - icy mountain plateau.
 * High start straight -> tight chicane -> big downhill sweeper -> frozen-lake causeway with
 * no barriers (void off the edge!) -> long climb -> second chicane -> final corner.
 * ~1200 m.
 */
export const atlasFrostbite: TrackDefinition = {
  id: 'atlas',
  name: 'Atlas Frostbite',
  theme: 'snow',
  laps: 3,
  description: 'A plunging descent off the High Atlas onto a frozen lake causeway. Nothing but ice and a long drop.',
  difficulty: 2,
  controlPoints: [
    { x: 0, y: 8, z: 0 }, // 0 finish line (plateau)
    { x: 8, y: 8, z: -64 },
    { x: -2, y: 8, z: -122 }, // opening kink
    { x: -8, y: 7.5, z: -150 }, // chicane 1
    { x: -8, y: 6.5, z: -184 },
    { x: 2, y: 5.5, z: -206 },
    { x: 0, y: 4.5, z: -240 },
    { x: 52, y: 2, z: -296 }, // big downhill sweeper
    { x: 130, y: 0, z: -298 },
    { x: 206, y: -1, z: -266 }, // frozen lake sweep (void)
    { x: 240, y: -1, z: -192 },
    { x: 238, y: -1, z: -142 },
    { x: 206, y: -1, z: -114 }, // hairpin at the end of the lake
    { x: 216, y: 0, z: -78 },
    { x: 248, y: 0.5, z: -56 },
    { x: 252, y: 1.5, z: -6 }, // long climb
    { x: 232, y: 3, z: 42 }, // climb esse
    { x: 246, y: 4.5, z: 88 },
    { x: 206, y: 5.5, z: 126 },
    { x: 160, y: 6.5, z: 132 },
    { x: 128, y: 7.5, z: 118 }, // chicane 2
    { x: 96, y: 8.5, z: 122 },
    { x: 74, y: 9, z: 132 },
    { x: 44, y: 8.5, z: 126 },
    { x: 0, y: 8, z: 80 }, // final corner onto the straight
  ],
  halfWidth: 8,
  halfWidths: [8.5, 8.5, 8, 8, 8, 8, 8.5, 9, 9, 8.5, 8.5, 8, 8, 8, 8.5, 8.5, 8, 8, 8.5, 8.5, 8, 8, 8, 8.5, 8.5],
  wallHalfWidthFactor: 1.5,
  itemBoxRows: [0.08, 0.36, 0.62, 0.9],
  boostPads: [0.22, 0.66, 0.935],
  voidRanges: [[0.315, 0.545]],
  environment: {
    skyTop: 0x1e3f7a,
    skyHorizon: 0x9ccbf0,
    skyBottom: 0xe3f1ff,
    fogColor: 0xbcd8f2,
    fogDensity: 0.0032,
    sunColor: 0xdfeaff,
    sunIntensity: 2.0,
    sunDirection: { x: 0.36, y: 0.66, z: -0.66 },
    ambientSky: 0xa9cdf5,
    ambientGround: 0x8fa8c4,
    ambientIntensity: 1.0,
    weather: SNOWFALL,
  },
  palette: {
    road: 0x55606e,
    roadStripe: 0xe8f6ff,
    curb: 0x2f6fb5,
    curbAlt: 0xffffff,
    offroad: 0xeaf3fb,
    wall: 0x8fd0f2,
    ground: 0xe6eff8,
  },
};
