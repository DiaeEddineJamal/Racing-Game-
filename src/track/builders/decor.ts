import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildContext } from './context';
import { color, normalizeForMerge, paintGeometry, track, trackMesh } from './context';
import { makeWindowTexture, makeBillboardTexture } from '../textures';
import { lerp } from '../../core/math';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

/** Merge several coloured parts into one non-indexed geometry with vertex colours. */
export function mergeParts(parts: { geo: THREE.BufferGeometry; color: number | THREE.Color; keepColor?: boolean }[]): THREE.BufferGeometry {
  const geos = parts.map((p) => {
    const g = normalizeForMerge(p.geo);
    if (!(p.keepColor && g.getAttribute('color'))) {
      paintGeometry(g, p.color instanceof THREE.Color ? p.color : new THREE.Color(p.color));
    }
    return g;
  });
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) throw new Error('mergeParts failed');
  merged.computeBoundingSphere();
  return merged;
}

export interface ScatterPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Deterministic scatter of positions around the track: within [minDist, maxDist] metres of the
 * centerline (minDist is added to wallHalfWidth + 3), outside the start/grandstand zone.
 */
export function scatter(ctx: BuildContext, count: number, minDist: number, maxDist: number, extraReject?: (x: number, z: number) => boolean): ScatterPoint[] {
  const { cl, field, rng } = ctx;
  const pts: ScatterPoint[] = [];
  const margin = maxDist + 10;
  const x0 = cl.minX - margin;
  const x1 = cl.maxX + margin;
  const z0 = cl.minZ - margin;
  const z1 = cl.maxZ + margin;
  const startX = cl.px[0];
  const startZ = cl.pz[0];
  const inner = cl.maxWallHalfWidth + 3 + minDist;
  let tries = 0;
  while (pts.length < count && tries < count * 60) {
    tries++;
    const x = lerp(x0, x1, rng());
    const z = lerp(z0, z1, rng());
    const d = field.distanceToTrack(x, z);
    if (d < inner || d > maxDist) continue;
    // keep the start area clear for the grandstands / gantry
    const dsx = x - startX;
    const dsz = z - startZ;
    if (dsx * dsx + dsz * dsz < 55 * 55) continue;
    if (extraReject && extraReject(x, z)) continue;
    pts.push({ x, y: field.heightAt(x, z), z });
  }
  return pts;
}

function fillInstances(
  mesh: THREE.InstancedMesh,
  pts: ScatterPoint[],
  rng: () => number,
  scaleMin: number,
  scaleMax: number,
  yOffset = 0,
  tilt = 0,
  colorFn?: (rng: () => number) => THREE.Color,
  nonUniform = false,
): void {
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const s = lerp(scaleMin, scaleMax, rng());
    _p.set(p.x, p.y + yOffset, p.z);
    _e.set((rng() - 0.5) * tilt, rng() * Math.PI * 2, (rng() - 0.5) * tilt);
    _q.setFromEuler(_e);
    if (nonUniform) _s.set(s * lerp(0.7, 1.3, rng()), s * lerp(0.6, 1.4, rng()), s * lerp(0.7, 1.3, rng()));
    else _s.set(s, s, s);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    if (colorFn) mesh.setColorAt(i, colorFn(rng));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function makeInstanced(ctx: BuildContext, geo: THREE.BufferGeometry, mat: THREE.Material, count: number, name: string, shadows = true): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.name = name;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  trackMesh(ctx, mesh);
  return mesh;
}

const stdMat = (extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, ...extra });

/** Themed instanced decorations (>= 300 instances of 2-3 kinds). */
export function buildDecorations(ctx: BuildContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'decor';
  switch (ctx.def.theme) {
    case 'desert':
    case 'volcano':
      buildDesert(ctx, group);
      break;
    case 'snow':
      buildSnow(ctx, group);
      break;
    case 'neon':
      buildNeon(ctx, group);
      break;
    default:
      buildGrassland(ctx, group);
  }
  return group;
}

// ------------------------------------------------------------------ grassland
function buildGrassland(ctx: BuildContext, group: THREE.Group): void {
  const rng = ctx.rng;
  // broadleaf trees (~7.8 m base, scaled 0.8..1.25 -> 6..10 m)
  const trunk = new THREE.CylinderGeometry(0.3, 0.46, 3.2, 7);
  trunk.translate(0, 1.6, 0);
  const canopy = new THREE.IcosahedronGeometry(2.7, 1);
  canopy.scale(1, 1.12, 1);
  canopy.translate(0, 5.3, 0);
  const canopy2 = new THREE.IcosahedronGeometry(1.7, 1);
  canopy2.translate(1.4, 6.4, 0.6);
  const canopy3 = new THREE.IcosahedronGeometry(1.4, 1);
  canopy3.translate(-1.3, 6.0, -0.8);
  const treeGeo = mergeParts([
    { geo: trunk, color: 0x6b4a2b },
    { geo: canopy, color: 0x3f8f36 },
    { geo: canopy2, color: 0x4fa33e },
    { geo: canopy3, color: 0x3a8a34 },
  ]);
  const treePts = scatter(ctx, 200, 4, 220);
  const trees = makeInstanced(ctx, treeGeo, stdMat(), treePts.length, 'trees');
  fillInstances(trees, treePts, rng, 0.8, 1.25, -0.15, 0.06, (r) => _c.setHSL(0.3 + (r() - 0.5) * 0.06, 0.55, 0.42 + (r() - 0.5) * 0.15));
  group.add(trees);

  // tall poplars / conifers for silhouette variety (9.5 m base, scaled 0.75..1.1)
  const pTrunk = new THREE.CylinderGeometry(0.22, 0.36, 3.4, 6);
  pTrunk.translate(0, 1.7, 0);
  const pCone = new THREE.ConeGeometry(1.7, 7.2, 8);
  pCone.translate(0, 6.2, 0);
  const pCone2 = new THREE.ConeGeometry(1.2, 4.2, 8);
  pCone2.translate(0, 8.3, 0);
  const poplarGeo = mergeParts([
    { geo: pTrunk, color: 0x5e4327 },
    { geo: pCone, color: 0x2f7a33 },
    { geo: pCone2, color: 0x3a8a3c },
  ]);
  const poplarPts = scatter(ctx, 90, 6, 230);
  const poplars = makeInstanced(ctx, poplarGeo, stdMat(), poplarPts.length, 'poplars');
  fillInstances(poplars, poplarPts, rng, 0.75, 1.1, -0.15, 0.04, (r) => _c.setHSL(0.32 + (r() - 0.5) * 0.05, 0.5, 0.4 + (r() - 0.5) * 0.12));
  group.add(poplars);

  // bushes
  const bushGeo = mergeParts([{ geo: new THREE.IcosahedronGeometry(0.9, 1).scale(1.2, 0.8, 1.2), color: 0x3d8a2f }]);
  const bushPts = scatter(ctx, 200, 0.5, 90);
  const bushes = makeInstanced(ctx, bushGeo, stdMat(), bushPts.length, 'bushes');
  fillInstances(bushes, bushPts, rng, 0.9, 1.9, 0.2, 0.2, (r) => _c.setHSL(0.28 + (r() - 0.5) * 0.08, 0.6, 0.38 + (r() - 0.5) * 0.12), true);
  group.add(bushes);

  // flower clusters: dense near the road, sparser further out
  const petals = [0xff5da2, 0xffd93a, 0xffffff, 0xff8a3a, 0xb56cff, 0xff4d6d];
  const parts: { geo: THREE.BufferGeometry; color: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + (i % 2) * 0.3;
    const r = i < 3 ? 0.18 : 0.45 + (i % 3) * 0.22;
    const stem = new THREE.CylinderGeometry(0.02, 0.028, 0.5, 3, 1, true);
    stem.translate(Math.cos(a) * r, 0.25, Math.sin(a) * r);
    const head = new THREE.IcosahedronGeometry(0.13, 0);
    head.translate(Math.cos(a) * r, 0.54, Math.sin(a) * r);
    parts.push({ geo: stem, color: 0x3f8f36 }, { geo: head, color: petals[(i * 2) % petals.length] });
  }
  const flowerGeo = mergeParts(parts);
  const flowerPts = scatter(ctx, 340, 0, 18).concat(scatter(ctx, 120, 18, 60));
  const flowers = makeInstanced(ctx, flowerGeo, stdMat({ roughness: 0.6 }), flowerPts.length, 'flowers', false);
  fillInstances(flowers, flowerPts, rng, 1.1, 1.9, 0, 0);
  flowers.castShadow = false;
  group.add(flowers);
}

// ------------------------------------------------------------------ desert
function buildDesert(ctx: BuildContext, group: THREE.Group): void {
  const rng = ctx.rng;
  // saguaro cactus
  const body = new THREE.CylinderGeometry(0.36, 0.46, 4.4, 8);
  body.translate(0, 2.2, 0);
  const cap = new THREE.SphereGeometry(0.36, 8, 6);
  cap.translate(0, 4.4, 0);
  const armL = new THREE.CylinderGeometry(0.22, 0.24, 1.5, 7);
  armL.rotateZ(Math.PI / 2);
  armL.translate(-0.9, 2.3, 0);
  const armLUp = new THREE.CylinderGeometry(0.22, 0.22, 1.6, 7);
  armLUp.translate(-1.55, 3.0, 0);
  const armLCap = new THREE.SphereGeometry(0.22, 7, 5);
  armLCap.translate(-1.55, 3.8, 0);
  const armR = new THREE.CylinderGeometry(0.2, 0.22, 1.2, 7);
  armR.rotateZ(Math.PI / 2);
  armR.translate(0.75, 1.7, 0.1);
  const armRUp = new THREE.CylinderGeometry(0.2, 0.2, 1.3, 7);
  armRUp.translate(1.3, 2.25, 0.1);
  const armRCap = new THREE.SphereGeometry(0.2, 7, 5);
  armRCap.translate(1.3, 2.9, 0.1);
  const green = 0x4f8f45;
  const cactusGeo = mergeParts([
    { geo: body, color: green },
    { geo: cap, color: 0x5ea351 },
    { geo: armL, color: green },
    { geo: armLUp, color: green },
    { geo: armLCap, color: 0x5ea351 },
    { geo: armR, color: green },
    { geo: armRUp, color: green },
    { geo: armRCap, color: 0x5ea351 },
  ]);
  // saguaros stand 6-9 m: base geometry is ~4.8 m, scaled up 1.4 then 0.9..1.35 per instance
  cactusGeo.scale(1.4, 1.4, 1.4);
  const cactusPts = scatter(ctx, 150, 1, 160);
  const cacti = makeInstanced(ctx, cactusGeo, stdMat({ roughness: 0.75 }), cactusPts.length, 'cacti');
  fillInstances(cacti, cactusPts, rng, 0.9, 1.35, -0.1, 0.06, (r) => _c.setHSL(0.3 + (r() - 0.5) * 0.05, 0.4, 0.36 + (r() - 0.5) * 0.1));
  group.add(cacti);

  // rocks (boulders up to ~5 m)
  const rockGeo = mergeParts([{ geo: new THREE.DodecahedronGeometry(1.1, 0), color: 0xb07a4a }]);
  const rockPts = scatter(ctx, 220, 0.5, 200);
  const rocks = makeInstanced(ctx, rockGeo, stdMat({ roughness: 1 }), rockPts.length, 'rocks');
  fillInstances(rocks, rockPts, rng, 0.7, 3.4, -0.4, 0.6, (r) => _c.setHSL(0.07 + (r() - 0.5) * 0.03, 0.45, 0.42 + (r() - 0.5) * 0.18), true);
  group.add(rocks);

  // palms (oasis feel, nearer the track)
  const trunk = new THREE.CylinderGeometry(0.22, 0.34, 6.5, 7);
  trunk.translate(0, 3.25, 0);
  const palmParts: { geo: THREE.BufferGeometry; color: number }[] = [{ geo: trunk, color: 0x7a5a3a }];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const frond = new THREE.PlaneGeometry(0.7, 3.4, 1, 3);
    // droop: bend the frond down along its length
    const pos = frond.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      const y = pos.getY(v);
      const k = (y + 1.7) / 3.4;
      pos.setY(v, -k * k * 1.4);
      pos.setZ(v, k * 3.2);
      pos.setX(v, pos.getX(v) * (1 - k * 0.7));
    }
    frond.rotateY(a);
    frond.translate(0, 6.6, 0);
    palmParts.push({ geo: frond, color: i % 2 === 0 ? 0x3f8f3a : 0x4fa844 });
  }
  const palmGeo = mergeParts(palmParts);
  palmGeo.scale(1.25, 1.25, 1.25);
  const palmPts = scatter(ctx, 70, 0.5, 60);
  const palms = makeInstanced(ctx, palmGeo, stdMat({ side: THREE.DoubleSide, roughness: 0.7 }), palmPts.length, 'palms');
  fillInstances(palms, palmPts, rng, 0.85, 1.3, -0.15, 0.1);
  group.add(palms);
}

// ------------------------------------------------------------------ snow
function buildSnow(ctx: BuildContext, group: THREE.Group): void {
  const rng = ctx.rng;
  const trunk = new THREE.CylinderGeometry(0.18, 0.26, 1.4, 6);
  trunk.translate(0, 0.7, 0);
  const c1 = new THREE.ConeGeometry(1.6, 2.8, 7);
  c1.translate(0, 2.3, 0);
  const c2 = new THREE.ConeGeometry(1.2, 2.3, 7);
  c2.translate(0, 3.7, 0);
  const c3 = new THREE.ConeGeometry(0.8, 1.9, 7);
  c3.translate(0, 5.0, 0);
  const snowCap = new THREE.ConeGeometry(0.45, 0.9, 7);
  snowCap.translate(0, 5.8, 0);
  const pineGeo = mergeParts([
    { geo: trunk, color: 0x5a3d26 },
    { geo: c1, color: 0x1f5a3a },
    { geo: c2, color: 0x256a44 },
    { geo: c3, color: 0x2c7a4e },
    { geo: snowCap, color: 0xf4faff },
  ]);
  const pinePts = scatter(ctx, 260, 2, 240, (x, z) => ctx.field.heightAt(x, z) < ctx.cl.minY - 8);
  const pines = makeInstanced(ctx, pineGeo, stdMat(), pinePts.length, 'pines');
  fillInstances(pines, pinePts, rng, 0.8, 1.7, -0.1, 0.06, (r) => _c.setHSL(0.4, 0.3, 0.5 + (r() - 0.5) * 0.2));
  group.add(pines);

  // snowmen
  const b1 = new THREE.SphereGeometry(0.8, 10, 8);
  b1.translate(0, 0.75, 0);
  const b2 = new THREE.SphereGeometry(0.58, 10, 8);
  b2.translate(0, 1.95, 0);
  const b3 = new THREE.SphereGeometry(0.42, 10, 8);
  b3.translate(0, 2.8, 0);
  const nose = new THREE.ConeGeometry(0.08, 0.5, 6);
  nose.rotateX(-Math.PI / 2);
  nose.translate(0, 2.85, -0.6);
  const hat = new THREE.CylinderGeometry(0.28, 0.28, 0.45, 8);
  hat.translate(0, 3.35, 0);
  const brim = new THREE.CylinderGeometry(0.45, 0.45, 0.06, 8);
  brim.translate(0, 3.14, 0);
  const scarf = new THREE.TorusGeometry(0.42, 0.09, 6, 12);
  scarf.rotateX(Math.PI / 2);
  scarf.translate(0, 2.4, 0);
  const snowmanGeo = mergeParts([
    { geo: b1, color: 0xffffff },
    { geo: b2, color: 0xffffff },
    { geo: b3, color: 0xffffff },
    { geo: nose, color: 0xff7a1a },
    { geo: hat, color: 0x161616 },
    { geo: brim, color: 0x161616 },
    { geo: scarf, color: 0xe03030 },
  ]);
  const snowmanPts = scatter(ctx, 45, 0.5, 45, (x, z) => ctx.field.heightAt(x, z) < ctx.cl.minY - 8);
  const snowmen = makeInstanced(ctx, snowmanGeo, stdMat({ roughness: 0.7 }), snowmanPts.length, 'snowmen');
  fillInstances(snowmen, snowmanPts, rng, 0.7, 1.1, -0.1, 0.05);
  group.add(snowmen);

  // ice spikes
  const spikeGeo = mergeParts([{ geo: new THREE.ConeGeometry(0.6, 3.6, 5), color: 0xb8e8ff }]);
  spikeGeo.translate(0, 1.6, 0);
  const spikePts = scatter(ctx, 170, 0.5, 120, (x, z) => ctx.field.heightAt(x, z) < ctx.cl.minY - 8);
  const spikes = makeInstanced(ctx, spikeGeo, stdMat({ roughness: 0.15, metalness: 0.1, emissive: 0x0b2a3d, emissiveIntensity: 0.5 }), spikePts.length, 'iceSpikes');
  fillInstances(spikes, spikePts, rng, 0.5, 1.8, -0.2, 0.5, (r) => _c.setHSL(0.55, 0.5, 0.75 + (r() - 0.5) * 0.2), true);
  group.add(spikes);
}

// ------------------------------------------------------------------ neon city
function buildNeon(ctx: BuildContext, group: THREE.Group): void {
  const rng = ctx.rng;
  const { field } = ctx;

  // skyscrapers: merged boxes with per-building UV scaling so windows keep their size
  const win = makeWindowTexture(77);
  track(ctx, win.map, win.emissive);
  const buildingGeos: THREE.BufferGeometry[] = [];
  const bpts = scatter(ctx, 130, 22, 300);
  for (const p of bpts) {
    const w = lerp(10, 26, rng());
    const d = lerp(10, 26, rng());
    const h = lerp(18, 95, Math.pow(rng(), 1.6));
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    // BoxGeometry groups: +x,-x (d x h), +y,-y (w x d), +z,-z (w x h)
    const sizes: [number, number][] = [
      [d, h],
      [d, h],
      [w, d],
      [w, d],
      [w, h],
      [w, h],
    ];
    for (let f = 0; f < 6; f++) {
      const [su, sv] = sizes[f];
      for (let v = f * 4; v < f * 4 + 4; v++) {
        const isRoof = f === 2 || f === 3;
        uv.setXY(v, isRoof ? 0 : (uv.getX(v) * su) / 3.2, isRoof ? 0 : (uv.getY(v) * sv) / 3.6);
      }
    }
    g.translate(p.x, field.heightAt(p.x, p.z) + h / 2 - 0.5, p.z);
    g.rotateY(0); // keep axis aligned for a city-grid feel
    buildingGeos.push(normalizeForMerge(g));
  }
  const cityGeo = mergeGeometries(buildingGeos, false);
  for (const g of buildingGeos) g.dispose();
  if (cityGeo) {
    cityGeo.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({
      map: win.map,
      emissive: 0xffffff,
      emissiveMap: win.emissive,
      emissiveIntensity: 1.3,
      roughness: 0.6,
      metalness: 0.3,
    });
    const city = new THREE.Mesh(cityGeo, mat);
    city.name = 'skyscrapers';
    city.castShadow = true;
    city.receiveShadow = true;
    trackMesh(ctx, city);
    group.add(city);
  }

  // pylons (dark body) + glowing caps
  const pylonGeo = mergeParts([{ geo: new THREE.BoxGeometry(0.6, 13, 0.6).translate(0, 6.5, 0), color: 0x1c1c2a }]);
  const pylonPts = scatter(ctx, 150, 1, 70);
  const pylons = makeInstanced(ctx, pylonGeo, stdMat({ roughness: 0.4, metalness: 0.7 }), pylonPts.length, 'pylons');
  fillInstances(pylons, pylonPts, rng, 0.8, 1.4, -0.1, 0);
  group.add(pylons);
  const capGeo = new THREE.BoxGeometry(0.9, 0.5, 0.9);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 2.0 });
  const caps = makeInstanced(ctx, capGeo, capMat, pylonPts.length, 'pylonCaps', false);
  for (let i = 0; i < pylonPts.length; i++) {
    pylons.getMatrixAt(i, _m);
    _m.decompose(_p, _q, _s);
    _p.y += 13 * _s.y;
    _m.compose(_p, _q, _s);
    caps.setMatrixAt(i, _m);
    caps.setColorAt(i, _c.setHex(i % 2 === 0 ? ctx.def.palette.curb : ctx.def.palette.roadStripe));
  }
  caps.instanceMatrix.needsUpdate = true;
  if (caps.instanceColor) caps.instanceColor.needsUpdate = true;
  group.add(caps);
  // blinking caps
  ctx.updaters.push((_dt, elapsed) => {
    capMat.emissiveIntensity = 1.4 + Math.sin(elapsed * 2.2) * 0.6 + (Math.sin(elapsed * 9.1) > 0.92 ? 1.2 : 0);
  });

  // holo billboards (two designs) on poles
  const boardPts = scatter(ctx, 36, 2, 60);
  const poleGeo = mergeParts([{ geo: new THREE.CylinderGeometry(0.18, 0.22, 8, 6).translate(0, 4, 0), color: 0x202030 }]);
  const poles = makeInstanced(ctx, poleGeo, stdMat({ roughness: 0.5, metalness: 0.6 }), boardPts.length, 'billboardPoles');
  fillInstances(poles, boardPts, rng, 1, 1, -0.1, 0);
  group.add(poles);
  const boardGeo = new THREE.PlaneGeometry(8, 4);
  boardGeo.translate(0, 10, 0);
  const mats: THREE.MeshStandardMaterial[] = [];
  for (let variant = 0; variant < 2; variant++) {
    const tex = makeBillboardTexture(variant);
    track(ctx, tex);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 1.5,
      side: THREE.DoubleSide,
      roughness: 0.5,
    });
    mats.push(mat);
    const mine = boardPts.filter((_, i) => i % 2 === variant);
    const boards = makeInstanced(ctx, boardGeo, mat, mine.length, `billboards${variant}`, false);
    for (let i = 0; i < mine.length; i++) {
      const p = mine[i];
      // face roughly toward the track centre for readability
      const cx = field.centerX;
      const cz = field.centerZ;
      const yaw = Math.atan2(cx - p.x, cz - p.z) + (rng() - 0.5) * 0.6;
      _p.set(p.x, p.y, p.z);
      _e.set(0, yaw, 0);
      _q.setFromEuler(_e);
      _s.set(1, 1, 1);
      _m.compose(_p, _q, _s);
      boards.setMatrixAt(i, _m);
    }
    boards.instanceMatrix.needsUpdate = true;
    group.add(boards);
  }
  ctx.updaters.push((_dt, elapsed) => {
    mats[0].emissiveIntensity = 1.2 + 0.5 * Math.sin(elapsed * 3.1) + (Math.sin(elapsed * 17.3) > 0.97 ? -0.9 : 0);
    mats[1].emissiveIntensity = 1.2 + 0.5 * Math.sin(elapsed * 2.3 + 1.5) + (Math.sin(elapsed * 13.7 + 2) > 0.97 ? -0.9 : 0);
  });
}
