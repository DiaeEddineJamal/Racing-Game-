import * as THREE from 'three';
import type { Checkpoint, ITrack, MinimapData, StartSlot, SurfaceQuery, SurfaceType, TrackDefinition, TrackSample } from '../core/types';
import { CHECKPOINT_COUNT, ITEM_BOX_ROW_SIZE, KART_COUNT } from '../core/constants';
import { lerp, seededRandom, smoothstep, trackDelta, wrap01 } from '../core/math';
import { Centerline } from './Centerline';
import { TerrainField } from './TerrainField';
import type { BuildContext, Updater } from './builders/context';
import { buildRoad } from './builders/road';
import { buildBarriers, isVoidT } from './builders/barriers';
import { buildMountains, buildTerrain } from './builders/terrain';
import { buildSky } from './builders/sky';
import { buildDecorations } from './builders/decor';
import { BOOST_PAD_LENGTH, buildBoostPads, buildGantry, buildGrandstands, buildSponsorBridges, computeItemBoxPositions, type BoostPadInfo } from './builders/props';
import { buildAnimatedProps } from './builders/animated';
import { buildLandmarks } from './builders/landmarks';

/** Half length (metres) of the 'boost' surface strip centred on each boost pad t (= the visible strip). */
const BOOST_PAD_HALF_LENGTH = BOOST_PAD_LENGTH / 2;
/** Lateral distance beyond the wall line over which groundY blends from the road level to the terrain. */
const OFFROAD_BLEND_START = 0.5;
const OFFROAD_BLEND_END = 4.5;

export function createTrackSample(): TrackSample {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: 8,
    wallHalfWidth: 12,
    t: 0,
  };
}

export function createSurfaceQuery(): SurfaceQuery {
  return {
    t: 0,
    surface: 'road',
    groundY: 0,
    groundNormal: new THREE.Vector3(0, 1, 0),
    lateral: 0,
    halfWidth: 8,
    wallHalfWidth: 12,
    tangent: new THREE.Vector3(0, 0, -1),
    binormal: new THREE.Vector3(1, 0, 0),
    center: new THREE.Vector3(),
  };
}

// Module scratch (hot paths are allocation-free).
const _qs = createTrackSample();
const _gs = createTrackSample();

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A fully procedural race track: centerline maths + all geometry/environment for one
 * TrackDefinition. Construction is synchronous.
 */
export class Track implements ITrack {
  readonly def: TrackDefinition;
  readonly object: THREE.Group;
  readonly length: number;
  readonly checkpoints: readonly Checkpoint[];
  readonly startGrid: readonly StartSlot[];
  readonly itemBoxPositions: readonly THREE.Vector3[];
  readonly boostPads: readonly BoostPadInfo[];
  readonly minimap: MinimapData;

  private readonly cl: Centerline;
  private readonly field: TerrainField;
  private readonly updaters: Updater[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly timeUniform = { value: 0 };
  private readonly boostPadTs: number[];
  /** Lateral half extent of each pad's visible strip (same order as boostPadTs). */
  private readonly boostPadHalfWidths: Float64Array;
  private disposed = false;

  constructor(def: TrackDefinition) {
    this.def = def;
    this.cl = new Centerline(def);
    this.length = this.cl.length;
    this.field = new TerrainField(def, this.cl);
    this.boostPadTs = def.boostPads.map((t) => wrap01(t));

    const ctx: BuildContext = {
      def,
      cl: this.cl,
      field: this.field,
      rng: seededRandom(hashString(def.id)),
      disposables: this.disposables,
      updaters: this.updaters,
      timeUniform: this.timeUniform,
    };

    // ------------------------------------------------------------ gameplay data
    this.checkpoints = this.buildCheckpoints();
    this.startGrid = this.buildStartGrid();
    this.itemBoxPositions = computeItemBoxPositions(ctx, ITEM_BOX_ROW_SIZE);
    this.minimap = this.buildMinimap();

    // ------------------------------------------------------------ geometry
    const root = new THREE.Group();
    root.name = `track:${def.id}`;
    root.add(buildSky(ctx));
    root.add(buildTerrain(ctx));
    root.add(buildMountains(ctx));
    root.add(buildRoad(ctx));
    root.add(buildBarriers(ctx));
    root.add(buildDecorations(ctx));
    root.add(buildLandmarks(ctx));
    root.add(buildGrandstands(ctx));
    root.add(buildGantry(ctx));
    root.add(buildSponsorBridges(ctx));
    const pads: BoostPadInfo[] = [];
    const padGroup = buildBoostPads(ctx, pads);
    if (padGroup) root.add(padGroup);
    this.boostPads = pads;
    this.boostPadHalfWidths = new Float64Array(this.boostPadTs.length);
    for (let i = 0; i < pads.length && i < this.boostPadHalfWidths.length; i++) this.boostPadHalfWidths[i] = pads[i].halfWidth;
    root.add(buildAnimatedProps(ctx));
    this.object = root;
  }

  // ---------------------------------------------------------------------------------------
  // Centerline queries
  // ---------------------------------------------------------------------------------------

  sample(t: number, out?: TrackSample): TrackSample {
    return this.cl.sample(t, out ?? createTrackSample());
  }

  closestT(position: THREE.Vector3, hintT?: number): number {
    return this.cl.closestT(position.x, position.z, hintT);
  }

  query(position: THREE.Vector3, hintT?: number, out?: SurfaceQuery): SurfaceQuery {
    const q = out ?? createSurfaceQuery();
    const t = this.cl.closestT(position.x, position.z, hintT);
    this.cl.sample(t, _qs);
    q.t = t;
    q.center.copy(_qs.position);
    q.tangent.copy(_qs.tangent);
    q.binormal.copy(_qs.binormal);
    q.halfWidth = _qs.halfWidth;
    q.wallHalfWidth = _qs.wallHalfWidth;
    const dx = position.x - _qs.position.x;
    const dz = position.z - _qs.position.z;
    const lateral = dx * _qs.binormal.x + dz * _qs.binormal.z;
    q.lateral = lateral;
    const a = Math.abs(lateral);
    const hw = _qs.halfWidth;
    const whw = _qs.wallHalfWidth;

    let surface: SurfaceType;
    if (a <= hw) surface = this.isBoostAt(t, a) ? 'boost' : 'road';
    else if (a <= whw) surface = 'offroad';
    else surface = isVoidT(this.def, t) ? 'void' : 'wall';
    q.surface = surface;

    const roadY = _qs.position.y;
    if (a <= whw + OFFROAD_BLEND_START) {
      q.groundY = roadY;
      q.groundNormal.copy(_qs.normal);
    } else {
      const k = smoothstep(whw + OFFROAD_BLEND_START, whw + OFFROAD_BLEND_END, a);
      const terrain = this.field.heightAt(position.x, position.z);
      q.groundY = lerp(roadY, terrain, k);
      // terrain normal from central differences
      const e = 0.6;
      const hx1 = this.field.heightAt(position.x + e, position.z);
      const hx0 = this.field.heightAt(position.x - e, position.z);
      const hz1 = this.field.heightAt(position.x, position.z + e);
      const hz0 = this.field.heightAt(position.x, position.z - e);
      const nx = (hx0 - hx1) / (2 * e);
      const nz = (hz0 - hz1) / (2 * e);
      q.groundNormal.set(lerp(_qs.normal.x, nx, k), lerp(_qs.normal.y, 1, k), lerp(_qs.normal.z, nz, k)).normalize();
    }
    return q;
  }

  heightAt(x: number, z: number): number {
    return this.field.heightAt(x, z);
  }

  /** True if (t, |lateral|) lies on a pad's visible strip (length and width match the rendered strip). */
  private isBoostAt(t: number, absLateral: number): boolean {
    const pads = this.boostPadTs;
    const hws = this.boostPadHalfWidths;
    const len = this.length;
    for (let i = 0; i < pads.length; i++) {
      if (absLateral <= hws[i] && Math.abs(trackDelta(pads[i], t)) * len <= BOOST_PAD_HALF_LENGTH) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------------------------

  update(dt: number, elapsed: number): void {
    this.timeUniform.value = elapsed;
    for (let i = 0; i < this.updaters.length; i++) this.updaters[i](dt, elapsed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const seen = new Set<{ dispose(): void }>();
    for (const d of this.disposables) {
      if (seen.has(d)) continue;
      seen.add(d);
      d.dispose();
    }
    // Catch anything a builder forgot to register.
    this.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry && !seen.has(mesh.geometry)) {
        seen.add(mesh.geometry);
        mesh.geometry.dispose();
      }
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      const mats = Array.isArray(m) ? m : [m];
      for (const mat of mats) {
        if (seen.has(mat)) continue;
        seen.add(mat);
        mat.dispose();
      }
    });
    this.updaters.length = 0;
    this.disposables.length = 0;
    this.object.clear();
    this.object.removeFromParent();
  }

  // ---------------------------------------------------------------------------------------
  // Gameplay data builders
  // ---------------------------------------------------------------------------------------

  private buildCheckpoints(): Checkpoint[] {
    const out: Checkpoint[] = [];
    for (let i = 0; i < CHECKPOINT_COUNT; i++) {
      const t = i / CHECKPOINT_COUNT;
      this.cl.sample(t, _gs);
      out.push({
        index: i,
        t,
        position: _gs.position.clone(),
        forward: _gs.tangent.clone(),
        halfWidth: _gs.halfWidth,
        isFinishLine: i === 0,
      });
    }
    return out;
  }

  private buildStartGrid(): StartSlot[] {
    const slots: StartSlot[] = [];
    const rowSpacing = 4.5;
    const lateral = 2.2;
    const firstRow = 6;
    const count = Math.max(KART_COUNT, 8);
    const euler = new THREE.Euler();
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2; // 0 = left (pole), 1 = right, staggered half a row back
      const sBack = firstRow + row * rowSpacing + (col === 1 ? rowSpacing * 0.5 : 0);
      const t = this.cl.tOf(-sBack);
      this.cl.sample(t, _gs);
      const lat = col === 0 ? -lateral : lateral;
      const position = new THREE.Vector3(
        _gs.position.x + _gs.binormal.x * lat,
        _gs.position.y,
        _gs.position.z + _gs.binormal.z * lat,
      );
      const heading = Math.atan2(-_gs.tangent.x, -_gs.tangent.z);
      euler.set(0, heading, 0);
      const quaternion = new THREE.Quaternion().setFromEuler(euler);
      slots.push({ position, quaternion, t });
    }
    return slots;
  }

  private buildMinimap(): MinimapData {
    const N = 200;
    const points: { x: number; y: number }[] = [];
    const leftEdge: { x: number; y: number }[] = [];
    const rightEdge: { x: number; y: number }[] = [];
    const cw: THREE.Vector3[] = [];
    const lw: THREE.Vector3[] = [];
    const rw: THREE.Vector3[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < N; k++) {
      this.cl.sample(k / N, _gs);
      const c = _gs.position.clone();
      const l = new THREE.Vector3(c.x - _gs.binormal.x * _gs.halfWidth, c.y, c.z - _gs.binormal.z * _gs.halfWidth);
      const r = new THREE.Vector3(c.x + _gs.binormal.x * _gs.halfWidth, c.y, c.z + _gs.binormal.z * _gs.halfWidth);
      cw.push(c);
      lw.push(l);
      rw.push(r);
      for (const p of [l, r]) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
    }
    const w = maxX - minX;
    const h = maxZ - minZ;
    const size = Math.max(w, h) * 1.08;
    const ox = minX - (size - w) / 2;
    const oz = minZ - (size - h) / 2;
    const worldToMap = (x: number, z: number): { x: number; y: number } => ({ x: (x - ox) / size, y: (z - oz) / size });
    for (let k = 0; k < N; k++) {
      points.push(worldToMap(cw[k].x, cw[k].z));
      leftEdge.push(worldToMap(lw[k].x, lw[k].z));
      rightEdge.push(worldToMap(rw[k].x, rw[k].z));
    }
    return { points, leftEdge, rightEdge, worldToMap };
  }
}
