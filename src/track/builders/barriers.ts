import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildContext } from './context';
import { color, headingFromDir, indexAtS, paintGeometry, track, trackMesh } from './context';
import { makeSandstoneTexture } from '../textures';
import { wrap01 } from '../../core/math';
import type { TrackDefinition } from '../../core/types';

/** True if t lies inside any void range (ranges may wrap around 0). */
export function isVoidT(def: TrackDefinition, t: number): boolean {
  const ranges = def.voidRanges;
  if (!ranges || ranges.length === 0) return false;
  const tw = wrap01(t);
  for (const [a, b] of ranges) {
    if (a <= b) {
      if (tw >= a && tw <= b) return true;
    } else if (tw >= a || tw <= b) {
      return true;
    }
  }
  return false;
}

/** Distance (metres) from t to the nearest void range edge, or Infinity. */
function distToVoidEdge(def: TrackDefinition, t: number, length: number): number {
  const ranges = def.voidRanges;
  if (!ranges) return Infinity;
  let best = Infinity;
  for (const [a, b] of ranges) {
    for (const e of [a, b]) {
      let d = Math.abs(wrap01(t) - e);
      if (d > 0.5) d = 1 - d;
      best = Math.min(best, d * length);
    }
  }
  return best;
}

interface Slot {
  x: number;
  y: number;
  z: number;
  heading: number;
  side: number;
  t: number;
  s: number;
}

/** Enumerate barrier slots along both wall lines. */
function wallSlots(ctx: BuildContext, spacing: number, lateralOffset: number, includeVoid: boolean): Slot[] {
  const { cl, def } = ctx;
  const slots: Slot[] = [];
  const count = Math.floor(cl.length / spacing);
  const actual = cl.length / count;
  for (let side = -1; side <= 1; side += 2) {
    for (let k = 0; k < count; k++) {
      const s = k * actual + (side > 0 ? actual * 0.5 : 0);
      const t = s / cl.length;
      if (!includeVoid && isVoidT(def, t)) continue;
      const i = indexAtS(cl, s);
      const lat = cl.whw[i] + lateralOffset;
      slots.push({
        x: cl.px[i] + cl.bx[i] * side * lat,
        y: cl.py[i],
        z: cl.pz[i] + cl.bz[i] * side * lat,
        heading: headingFromDir(cl.tx[i], cl.tz[i]),
        side,
        t,
        s,
      });
    }
  }
  return slots;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

function setInstance(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, heading: number, sx = 1, sy = 1, sz = 1, tilt = 0): void {
  _p.set(x, y, z);
  _e.set(tilt, heading, 0);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  _m.compose(_p, _q, _s);
  mesh.setMatrixAt(i, _m);
}

/** Themed barriers along the wall line (none in void ranges: warning posts instead). */
export function buildBarriers(ctx: BuildContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'barriers';
  const theme = ctx.def.theme;
  if (theme === 'grassland' || theme === 'beach') buildTyres(ctx, group);
  else if (theme === 'desert' || theme === 'volcano') buildSandstone(ctx, group);
  else if (theme === 'snow') buildIceBlocks(ctx, group);
  else buildNeonRails(ctx, group);

  if (ctx.def.voidRanges && ctx.def.voidRanges.length > 0) buildWarningPosts(ctx, group);
  return group;
}

// ------------------------------------------------------------------ grassland: stacked tyres
const TYRE_SPACING = 1.02;

function buildTyres(ctx: BuildContext, group: THREE.Group): void {
  // Three thin kart tyres per stack: outer diameter ~0.96 m, stack height ~0.88 m (about one kart tall).
  // 3 x (4 x 8 segments) = 192 tris per instance.
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const t = new THREE.TorusGeometry(0.33, 0.145, 4, 8);
    t.rotateX(Math.PI / 2);
    t.translate((k % 2) * 0.03, 0.145 + k * 0.29, k === 1 ? 0.03 : 0);
    parts.push(t);
  }
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  const slots = wallSlots(ctx, TYRE_SPACING, 0.5, false);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, slots.length);
  const rng = ctx.rng;
  for (let i = 0; i < slots.length; i++) {
    const sl = slots[i];
    setInstance(mesh, i, sl.x, sl.y, sl.z, sl.heading + (rng() - 0.5) * 0.5, 1, 0.96 + rng() * 0.08, 1);
    const k = Math.floor(sl.s / TYRE_SPACING);
    if (k % 8 === 0) _c.setHex(0xe9e9e9);
    else if (k % 8 === 4) _c.setHex(0xd12b2b);
    else _c.setHex(0x1d1d22).offsetHSL(0, 0, (rng() - 0.5) * 0.04);
    mesh.setColorAt(i, _c);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'tyreBarriers';
  trackMesh(ctx, mesh);
  group.add(mesh);
}

// ------------------------------------------------------------------ desert: sandstone blocks + canyon walls
function buildSandstone(ctx: BuildContext, group: THREE.Group): void {
  const geo = new THREE.BoxGeometry(0.8, 0.9, 2.0);
  const tex = makeSandstoneTexture(ctx.def.palette.wall);
  track(ctx, tex);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.95, metalness: 0 });
  const slots = wallSlots(ctx, 2.05, 0.5, false);
  // Canyon: tall stacked walls in the descent section.
  const canyon: [number, number][] = ctx.def.id === 'dune_drift' ? [[0.49, 0.685]] : [];
  const rows = 7;
  let extra = 0;
  for (const sl of slots) if (inRanges(canyon, sl.t)) extra += rows;
  const mesh = new THREE.InstancedMesh(geo, mat, slots.length + extra);
  const rng = ctx.rng;
  let idx = 0;
  const base = color(ctx.def.palette.wall);
  for (const sl of slots) {
    const canyonHere = inRanges(canyon, sl.t);
    const nRows = canyonHere ? rows + 1 : 1;
    for (let r = 0; r < nRows; r++) {
      const sy = 0.95 + rng() * 0.15;
      const yaw = sl.heading + (rng() - 0.5) * 0.06;
      // odd rows offset half a block along the wall for a brick pattern
      const off = r % 2 === 1 ? 1.0 : 0;
      const dx = -Math.sin(yaw) * off;
      const dz = -Math.cos(yaw) * off;
      // walls lean slightly outward as they rise
      const lean = r * 0.14 * sl.side;
      const lx = Math.cos(yaw) * lean;
      const lz = -Math.sin(yaw) * lean;
      setInstance(mesh, idx, sl.x + dx + lx, sl.y + 0.45 + r * 0.9, sl.z + dz + lz, yaw, 1 + r * 0.08, sy, 1 + r * 0.12);
      _c.copy(base).offsetHSL((rng() - 0.5) * 0.02, 0, (rng() - 0.5) * 0.12 - r * 0.012);
      mesh.setColorAt(idx, _c);
      idx++;
    }
  }
  mesh.count = idx;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'sandstoneBarriers';
  trackMesh(ctx, mesh);
  group.add(mesh);
}

function inRanges(ranges: [number, number][], t: number): boolean {
  for (const [a, b] of ranges) if (t >= a && t <= b) return true;
  return false;
}

// ------------------------------------------------------------------ snow: ice blocks
function buildIceBlocks(ctx: BuildContext, group: THREE.Group): void {
  // Kart-height ice blocks: 0.9 m tall (x0.85..1.15 variation, never above ~1.05 m).
  const geo = new THREE.BoxGeometry(0.7, 0.9, 1.35, 1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.12,
    metalness: 0.05,
    emissive: 0x0d2a3f,
    emissiveIntensity: 0.6,
  });
  const slots = wallSlots(ctx, 1.48, 0.45, false);
  const mesh = new THREE.InstancedMesh(geo, mat, slots.length);
  const rng = ctx.rng;
  for (let i = 0; i < slots.length; i++) {
    const sl = slots[i];
    const sy = 0.85 + rng() * 0.3;
    setInstance(mesh, i, sl.x, sl.y + 0.45 * sy - 0.02, sl.z, sl.heading + (rng() - 0.5) * 0.1, 1, sy, 1, (rng() - 0.5) * 0.05);
    _c.setHex(rng() < 0.5 ? 0xa8e2fb : 0xc7edff).offsetHSL(0, 0, (rng() - 0.5) * 0.08);
    mesh.setColorAt(i, _c);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'iceBarriers';
  trackMesh(ctx, mesh);
  group.add(mesh);
}

// ------------------------------------------------------------------ warning posts for void edges
function buildWarningPosts(ctx: BuildContext, group: THREE.Group): void {
  const post = new THREE.CylinderGeometry(0.07, 0.09, 1.0, 6);
  post.translate(0, 0.5, 0);
  paintGeometry(post, new THREE.Color(0xf0f0f0));
  const band = new THREE.CylinderGeometry(0.085, 0.085, 0.32, 6);
  band.translate(0, 0.78, 0);
  paintGeometry(band, new THREE.Color(0xff3b30));
  const top = new THREE.SphereGeometry(0.13, 8, 6);
  top.translate(0, 1.08, 0);
  paintGeometry(top, new THREE.Color(0xffd23a));
  const geo = mergeGeometries([post, band, top], false);
  post.dispose();
  band.dispose();
  top.dispose();
  const { cl, def } = ctx;
  const slots = wallSlots(ctx, 7.5, 0.35, true).filter((sl) => isVoidT(def, sl.t) || distToVoidEdge(def, sl.t, cl.length) < 4);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0x331100, emissiveIntensity: 0.4 });
  const mesh = new THREE.InstancedMesh(geo, mat, slots.length);
  for (let i = 0; i < slots.length; i++) {
    const sl = slots[i];
    setInstance(mesh, i, sl.x, sl.y, sl.z, sl.heading);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.name = 'warningPosts';
  trackMesh(ctx, mesh);
  group.add(mesh);
}

// ------------------------------------------------------------------ neon: posts + glowing rails
function buildNeonRails(ctx: BuildContext, group: THREE.Group): void {
  const { cl, def } = ctx;
  // posts (waist height)
  const postGeo = new THREE.BoxGeometry(0.16, 0.86, 0.16);
  postGeo.translate(0, 0.43, 0);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x1b1b28, roughness: 0.4, metalness: 0.7 });
  const slots = wallSlots(ctx, 2.5, 0.4, false);
  const posts = new THREE.InstancedMesh(postGeo, postMat, slots.length);
  for (let i = 0; i < slots.length; i++) {
    const sl = slots[i];
    setInstance(posts, i, sl.x, sl.y, sl.z, sl.heading);
  }
  posts.instanceMatrix.needsUpdate = true;
  posts.castShadow = true;
  posts.name = 'neonPosts';
  trackMesh(ctx, posts);
  group.add(posts);

  // rails: two thin glowing ribbons per side (top rail at ~0.8 m, second at knee height)
  const rails: { y0: number; y1: number; col: number }[] = [
    { y0: 0.76, y1: 0.84, col: def.palette.curb },
    { y0: 0.4, y1: 0.45, col: def.palette.roadStripe },
  ];
  const step = 2;
  const n = cl.n;
  const perSide = Math.floor(n / step) + 1;
  for (const rail of rails) {
    const verts = new Float32Array(perSide * 2 * 2 * 3);
    const idx = new Uint32Array((perSide - 1) * 2 * 6);
    let vi = 0;
    let ii = 0;
    for (let side = -1; side <= 1; side += 2) {
      const base = vi;
      for (let k = 0; k < perSide; k++) {
        const i = (k * step) % n;
        const lat = cl.whw[i] + 0.4;
        const x = cl.px[i] + cl.bx[i] * side * lat;
        const z = cl.pz[i] + cl.bz[i] * side * lat;
        const y = cl.py[i];
        verts[vi * 3] = x;
        verts[vi * 3 + 1] = y + rail.y0;
        verts[vi * 3 + 2] = z;
        verts[(vi + 1) * 3] = x;
        verts[(vi + 1) * 3 + 1] = y + rail.y1;
        verts[(vi + 1) * 3 + 2] = z;
        vi += 2;
      }
      for (let k = 0; k < perSide - 1; k++) {
        const a = base + k * 2;
        idx[ii++] = a;
        idx[ii++] = a + 1;
        idx[ii++] = a + 2;
        idx[ii++] = a + 1;
        idx[ii++] = a + 3;
        idx[ii++] = a + 2;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: new THREE.Color(rail.col),
      emissiveIntensity: 1.8,
      roughness: 0.4,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'neonRail';
    trackMesh(ctx, mesh);
    group.add(mesh);
  }
}
