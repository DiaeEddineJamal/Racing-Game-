import type { TrackDefinition } from '../../core/types';
import { menaraMeadows } from './menaraMeadows';
import { merzougaDunes } from './merzougaDunes';
import { agadirCoast } from './agadirCoast';
import { atlasFrostbite } from './atlasFrostbite';
import { jbelInferno } from './jbelInferno';
import { casaNeon } from './casaNeon';

export { menaraMeadows, merzougaDunes, agadirCoast, atlasFrostbite, jbelInferno, casaNeon };

/** The six race circuits, in menu order (easy -> hard). */
export const TRACKS: TrackDefinition[] = [
  menaraMeadows,
  merzougaDunes,
  agadirCoast,
  atlasFrostbite,
  jbelInferno,
  casaNeon,
];

/** Look up a track by id; falls back to the first track for unknown ids. */
export function getTrackDef(id: string): TrackDefinition {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
