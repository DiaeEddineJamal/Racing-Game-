import * as THREE from 'three';
import type { TrackDefinition } from '../../core/types';
import type { Centerline } from '../Centerline';
import type { TerrainField } from '../TerrainField';

export type Updater = (dt: number, elapsed: number) => void;

/** Shared state handed to every geometry builder. */
export interface BuildContext {
  def: TrackDefinition;
  cl: Centerline;
  field: TerrainField;
  /** Deterministic RNG seeded from the track id. */
  rng: () => number;
  /** Everything that must be disposed with the track. */
  disposables: { dispose(): void }[];
  /** Per-frame animation callbacks. */
  updaters: Updater[];
  /** Shared time uniform for shader-driven animation. */
  timeUniform: { value: number };
}

/** Register objects for disposal; returns the first argument for chaining. */
export function track<T extends { dispose(): void }>(ctx: BuildContext, ...items: T[]): T {
  for (const it of items) ctx.disposables.push(it);
  return items[0];
}

/** Register geometry + material(s) of a mesh for disposal. */
export function trackMesh(ctx: BuildContext, mesh: THREE.Mesh | THREE.Points | THREE.Line): void {
  ctx.disposables.push(mesh.geometry);
  const m = mesh.material;
  if (Array.isArray(m)) ctx.disposables.push(...m);
  else ctx.disposables.push(m);
}

/** Convert hex colour to THREE.Color with optional HSL tweak. */
export function color(hex: number, dl = 0, ds = 0): THREE.Color {
  const c = new THREE.Color(hex);
  if (dl !== 0 || ds !== 0) {
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    c.setHSL(hsl.h, THREE.MathUtils.clamp(hsl.s + ds, 0, 1), THREE.MathUtils.clamp(hsl.l + dl, 0, 1));
  }
  return c;
}

/** Sample index (integer, wrapped) for an arc-length position in metres. */
export function indexAtS(cl: Centerline, s: number): number {
  const n = cl.n;
  const i = Math.round((s / cl.length) * n);
  return ((i % n) + n) % n;
}

/** Heading (Y rotation) so that -Z faces along the given horizontal direction. */
export function headingFromDir(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Set per-vertex colour for a geometry (all vertices). */
export function paintGeometry(geo: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const count = geo.getAttribute('position').count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Ensure geometry has uv + normal + color attributes so it can be merged with others. */
export function normalizeForMerge(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const count = g.getAttribute('position').count;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  if (!g.getAttribute('color')) paintGeometry(g, new THREE.Color(1, 1, 1));
  return g;
}
