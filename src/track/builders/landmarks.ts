import * as THREE from 'three';
import type { BuildContext } from './context';
import { headingFromDir, track, trackMesh } from './context';
import { mergeParts } from './decor';
import { makeBillboardTexture, makeLabelTexture } from '../textures';
import { fbm2, lerp, wrap01 } from '../../core/math';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();

interface Spot {
  x: number;
  y: number;
  z: number;
  /** Yaw so that local -Z faces the track. */
  facing: number;
}

/**
 * Find a clear spot beside the track near parameter t on the given side: walk outward from the
 * wall line until the whole footprint (radius) clears every part of the track.
 */
function findSpot(ctx: BuildContext, t: number, side: number, minClear: number, footprint: number): Spot {
  const { cl, field } = ctx;
  const i = Math.floor(wrap01(t) * cl.n) % cl.n;
  const need = cl.maxWallHalfWidth + footprint + 4;
  let lat = cl.whw[i] + minClear + footprint;
  let x = 0;
  let z = 0;
  for (let k = 0; k < 40; k++) {
    x = cl.px[i] + cl.bx[i] * side * lat;
    z = cl.pz[i] + cl.bz[i] * side * lat;
    if (field.distanceToTrack(x, z) >= need) break;
    lat += 4;
  }
  const dx = cl.px[i] - x;
  const dz = cl.pz[i] - z;
  return { x, y: field.heightAt(x, z), z, facing: headingFromDir(dx, dz) };
}

function placeAt(mesh: THREE.Object3D, spot: Spot, yaw = spot.facing, sink = 0.3): void {
  mesh.position.set(spot.x, spot.y - sink, spot.z);
  mesh.rotation.set(0, yaw, 0);
}

function staticMesh(ctx: BuildContext, geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  trackMesh(ctx, mesh);
  return mesh;
}

/** 2-3 large landmark props per track, visible from the road. */
export function buildLandmarks(ctx: BuildContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'landmarks';
  switch (ctx.def.theme) {
    case 'desert':
    case 'volcano':
      addMesas(ctx, group);
      addGiantCactus(ctx, group);
      break;
    case 'snow':
      addFrozenWaterfall(ctx, group);
      addIceCastle(ctx, group);
      break;
    case 'neon':
      addHoloBillboard(ctx, group);
      addMonorail(ctx, group);
      break;
    default:
      addWaterTower(ctx, group);
      addBarn(ctx, group);
  }
  return group;
}

// ------------------------------------------------------------------ grassland: water tower + barn
function addWaterTower(ctx: BuildContext, group: THREE.Group): void {
  const spot = findSpot(ctx, 0.27, 1, 14, 6);
  const legH = 16;
  const parts: { geo: THREE.BufferGeometry; color: number }[] = [];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.CylinderGeometry(0.22, 0.3, legH, 6);
    leg.translate(0, legH / 2, 0);
    // lean inward: bottom radius 4.2, top radius 3.2
    const pos = leg.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      const y = pos.getY(v);
      const r = lerp(4.4, 3.2, y / legH);
      pos.setX(v, pos.getX(v) + Math.cos(a) * r);
      pos.setZ(v, pos.getZ(v) + Math.sin(a) * r);
    }
    parts.push({ geo: leg, color: 0x8a8f96 });
    // cross braces
    for (let b = 1; b <= 3; b++) {
      const y = (b / 4) * legH;
      const r = lerp(4.4, 3.2, y / legH);
      const a2 = ((k + 1) / 4) * Math.PI * 2 + Math.PI / 4;
      const x0 = Math.cos(a) * r;
      const z0 = Math.sin(a) * r;
      const x1 = Math.cos(a2) * r;
      const z1 = Math.sin(a2) * r;
      const len = Math.hypot(x1 - x0, z1 - z0);
      const brace = new THREE.BoxGeometry(len, 0.12, 0.12);
      brace.rotateY(-Math.atan2(z1 - z0, x1 - x0));
      brace.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
      parts.push({ geo: brace, color: 0x6f747a });
    }
  }
  // tank floor + roof
  const floor = new THREE.CylinderGeometry(4.6, 3.6, 1.2, 16);
  floor.translate(0, legH + 0.6, 0);
  parts.push({ geo: floor, color: 0x9aa0a8 });
  const roof = new THREE.ConeGeometry(4.9, 2.6, 16);
  roof.translate(0, legH + 1.2 + 5.2 + 1.3, 0);
  parts.push({ geo: roof, color: 0xb23a3a });
  const finial = new THREE.SphereGeometry(0.35, 8, 6);
  finial.translate(0, legH + 1.2 + 5.2 + 2.7, 0);
  parts.push({ geo: finial, color: 0xf0f0f0 });
  const ladder = new THREE.BoxGeometry(0.5, legH + 2, 0.08);
  ladder.translate(0, (legH + 2) / 2, 4.0);
  parts.push({ geo: ladder, color: 0x50545a });
  const structure = staticMesh(ctx, mergeParts(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.3 }), 'waterTower');
  placeAt(structure, spot);
  group.add(structure);

  // tank with the label wrapped around it (own material)
  const tank = new THREE.CylinderGeometry(4.6, 4.6, 5.2, 24, 1, false);
  tank.translate(0, legH + 1.2 + 2.6, 0);
  const label = makeLabelTexture('SUNNY', 0xf1f1ee, 0xb23a3a);
  track(ctx, label);
  const tankMesh = staticMesh(ctx, tank, new THREE.MeshStandardMaterial({ map: label, roughness: 0.6, metalness: 0.15 }), 'waterTowerTank');
  // rotate so the text faces the track (text is centred at u = 0.5 -> -Z of the cylinder)
  placeAt(tankMesh, spot, spot.facing + Math.PI);
  group.add(tankMesh);
}

function addBarn(ctx: BuildContext, group: THREE.Group): void {
  const spot = findSpot(ctx, 0.79, -1, 10, 13);
  const w = 14;
  const d = 22;
  const wallH = 6.5;
  const parts: { geo: THREE.BufferGeometry; color: number }[] = [];
  parts.push({ geo: new THREE.BoxGeometry(w, wallH, d).translate(0, wallH / 2, 0), color: 0xb8322c });
  // gambrel roof: two pitches per side
  const roofCol = 0x4a4a52;
  const addPitch = (x0: number, y0: number, x1: number, y1: number): void => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    for (const s of [-1, 1]) {
      const slab = new THREE.BoxGeometry(len + 0.3, 0.3, d + 1.2);
      slab.rotateZ(s * ang);
      slab.translate(s * (x0 + x1) / 2, (y0 + y1) / 2, 0);
      parts.push({ geo: slab, color: roofCol });
    }
  };
  addPitch(w / 2 + 0.3, wallH - 0.2, w / 2 - 2.6, wallH + 2.8);
  addPitch(w / 2 - 2.6, wallH + 2.8, 0, wallH + 4.6);
  // gable infill
  for (const s of [-1, 1]) {
    const gable = new THREE.BoxGeometry(w - 0.4, 4.6, 0.4);
    gable.translate(0, wallH + 2.3, s * (d / 2 - 0.2));
    parts.push({ geo: gable, color: 0xb8322c });
    // big white door + trim
    parts.push({ geo: new THREE.BoxGeometry(4.6, 4.6, 0.3).translate(0, 2.3, s * (d / 2 + 0.05)), color: 0xf3efe6 });
    parts.push({ geo: new THREE.BoxGeometry(0.3, 4.6, 0.3).translate(0, 2.3, s * (d / 2 + 0.2)), color: 0xb8322c });
    parts.push({ geo: new THREE.BoxGeometry(w + 0.4, 0.35, 0.35).translate(0, wallH + 0.05, s * (d / 2)), color: 0xf3efe6 });
    parts.push({ geo: new THREE.BoxGeometry(2.4, 2.4, 0.3).translate(0, wallH + 2.4, s * (d / 2 + 0.05)), color: 0xf3efe6 });
  }
  for (const s of [-1, 1]) {
    parts.push({ geo: new THREE.BoxGeometry(0.35, wallH + 0.2, d + 0.4).translate(s * (w / 2), wallH / 2, 0), color: 0xf3efe6 });
    for (let k = -2; k <= 2; k++) {
      parts.push({ geo: new THREE.BoxGeometry(0.4, 1.6, 1.6).translate(s * (w / 2 + 0.05), 3.6, k * 4.2), color: 0x20242a });
    }
  }
  // silo
  const siloH = 17;
  const silo = new THREE.CylinderGeometry(3.2, 3.2, siloH, 16);
  silo.translate(w / 2 + 4.6, siloH / 2, -d / 2 + 4);
  parts.push({ geo: silo, color: 0xd9dbe0 });
  const dome = new THREE.SphereGeometry(3.25, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.translate(w / 2 + 4.6, siloH, -d / 2 + 4);
  parts.push({ geo: dome, color: 0x8a8f96 });
  for (let k = 1; k < 5; k++) {
    const band = new THREE.TorusGeometry(3.25, 0.09, 4, 16);
    band.rotateX(Math.PI / 2);
    band.translate(w / 2 + 4.6, (k / 5) * siloH, -d / 2 + 4);
    parts.push({ geo: band, color: 0x8a8f96 });
  }
  // weather vane
  parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, 2.2, 5).translate(0, wallH + 5.6, 0), color: 0x333333 });
  parts.push({ geo: new THREE.BoxGeometry(1.4, 0.08, 0.08).translate(0, wallH + 6.4, 0), color: 0x333333 });
  const barn = staticMesh(ctx, mergeParts(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 'barn');
  placeAt(barn, spot, spot.facing + Math.PI / 2, 0.4);
  group.add(barn);
}

// ------------------------------------------------------------------ desert: mesas + giant saguaro
function addMesas(ctx: BuildContext, group: THREE.Group): void {
  const parts: { geo: THREE.BufferGeometry; color: number | THREE.Color }[] = [];
  const strata = [0xa8583a, 0xc7754c, 0xd99a6a, 0xb86a44, 0xe0ac7c];
  const mesaAt = (spot: Spot, baseR: number, layers: { r: number; h: number }[], seed: number): void => {
    let y = spot.y - 1.5;
    layers.forEach((L, li) => {
      const g = new THREE.CylinderGeometry(L.r, L.r * 1.12, L.h, 14, 1);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      for (let v = 0; v < pos.count; v++) {
        const x = pos.getX(v);
        const z = pos.getZ(v);
        const a = Math.atan2(z, x);
        const n = 0.82 + 0.36 * fbm2(Math.cos(a) * 2 + seed + li * 3, Math.sin(a) * 2 + seed, 2);
        pos.setX(v, x * n);
        pos.setZ(v, z * n * 0.85);
      }
      g.translate(spot.x, y + L.h / 2, spot.z);
      parts.push({ geo: g, color: strata[(li + seed) % strata.length] });
      y += L.h;
    });
    // dark shadowed skirt (talus) around the base
    const skirt = new THREE.ConeGeometry(baseR * 1.35, 3.5, 14);
    skirt.translate(spot.x, spot.y + 0.2, spot.z);
    parts.push({ geo: skirt, color: 0x9a5a38 });
  };
  const s1 = findSpot(ctx, 0.155, -1, 34, 26);
  mesaAt(s1, 26, [{ r: 26, h: 9 }, { r: 22, h: 7 }, { r: 19, h: 8 }, { r: 12, h: 5 }], 1);
  const s2 = findSpot(ctx, 0.83, 1, 30, 22);
  mesaAt(s2, 22, [{ r: 22, h: 8 }, { r: 17, h: 10 }, { r: 15, h: 6 }], 3);
  const s3 = findSpot(ctx, 0.62, 1, 46, 16);
  mesaAt(s3, 16, [{ r: 16, h: 12 }, { r: 9, h: 9 }, { r: 6, h: 7 }], 5);
  const mesh = staticMesh(ctx, mergeParts(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), 'mesas');
  group.add(mesh);
}

function addGiantCactus(ctx: BuildContext, group: THREE.Group): void {
  const spot = findSpot(ctx, 0.40, -1, 8, 5);
  const green = 0x4a8a42;
  const light = 0x62a656;
  const parts: { geo: THREE.BufferGeometry; color: number }[] = [];
  const H = 15;
  const body = new THREE.CylinderGeometry(1.15, 1.45, H, 12);
  body.translate(0, H / 2, 0);
  parts.push({ geo: body, color: green });
  parts.push({ geo: new THREE.SphereGeometry(1.15, 12, 8).translate(0, H, 0), color: light });
  // ribs
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const rib = new THREE.BoxGeometry(0.28, H - 1, 0.28);
    rib.translate(Math.cos(a) * 1.28, (H - 1) / 2, Math.sin(a) * 1.28);
    rib.rotateY(-a);
    parts.push({ geo: rib, color: 0x3f7a39 });
  }
  const arm = (yaw: number, y: number, out: number, up: number): void => {
    const h = new THREE.CylinderGeometry(0.62, 0.66, out, 9);
    h.rotateZ(Math.PI / 2);
    h.translate(out / 2 + 0.8, y, 0);
    const v = new THREE.CylinderGeometry(0.6, 0.62, up, 9);
    v.translate(out + 0.8, y + up / 2 - 0.3, 0);
    const cap = new THREE.SphereGeometry(0.6, 9, 6);
    cap.translate(out + 0.8, y + up - 0.3, 0);
    const elbow = new THREE.SphereGeometry(0.64, 9, 6);
    elbow.translate(out + 0.8, y, 0);
    for (const g of [h, v, cap, elbow]) {
      g.rotateY(yaw);
      parts.push({ geo: g, color: g === cap ? light : green });
    }
  };
  arm(0.3, 6.5, 3.2, 6.0);
  arm(2.4, 8.5, 2.6, 5.0);
  arm(4.3, 5.2, 2.2, 4.2);
  // flowers on top
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    parts.push({ geo: new THREE.SphereGeometry(0.32, 6, 5).translate(Math.cos(a) * 0.7, H + 0.9, Math.sin(a) * 0.7), color: 0xfff1a8 });
  }
  const mesh = staticMesh(ctx, mergeParts(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }), 'giantCactus');
  placeAt(mesh, spot, spot.facing, 0.6);
  group.add(mesh);
}

// ------------------------------------------------------------------ snow: frozen waterfall + ice castle
function iceMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xbfe6ff,
    roughness: 0.14,
    metalness: 0.05,
    emissive: 0x0c2e48,
    emissiveIntensity: 0.55,
    transparent: true,
    opacity: 0.9,
    depthWrite: true,
  });
}

function addFrozenWaterfall(ctx: BuildContext, group: THREE.Group): void {
  // On the outside of the big downhill sweeper, before the frozen lake.
  const spot = findSpot(ctx, 0.235, -1, 20, 22);
  const W = 46;
  const H = 26;
  const rock: { geo: THREE.BufferGeometry; color: number }[] = [];
  const ice: { geo: THREE.BufferGeometry; color: number }[] = [];
  // cliff: three stacked, slightly staggered rock slabs
  for (let k = 0; k < 3; k++) {
    const slab = new THREE.BoxGeometry(W + k * 4, H / 3 + 0.6, 10 + k * 2.5);
    slab.translate(0, (k + 0.5) * (H / 3), -k * 1.2 - 4);
    rock.push({ geo: slab, color: k === 0 ? 0x4c5563 : k === 1 ? 0x5a6474 : 0x6b7686 });
  }
  // snow cap
  rock.push({ geo: new THREE.BoxGeometry(W + 9, 1.4, 16).translate(0, H + 0.6, -6.5), color: 0xf6fbff });
  // frozen cascade: tall tapered columns hanging down the front face
  const rng = ctx.rng;
  for (let k = 0; k < 14; k++) {
    const x = -W / 2 + 3 + (k / 13) * (W - 6) + (rng() - 0.5) * 1.5;
    const h = H * (0.55 + rng() * 0.45);
    const r = 1.1 + rng() * 1.3;
    const col = new THREE.CylinderGeometry(r * 0.55, r, h, 7);
    col.translate(x, H - h / 2 + 0.4, 1.4 + (rng() - 0.5) * 1.0);
    ice.push({ geo: col, color: 0xffffff });
    // icicle fringe
    const ic = new THREE.ConeGeometry(r * 0.5, 2.6 + rng() * 2, 6);
    ic.rotateX(Math.PI);
    ic.translate(x, H - h - 1.3, 1.6);
    ice.push({ geo: ic, color: 0xffffff });
  }
  // frozen pool spreading at the base
  const pool = new THREE.CylinderGeometry(W * 0.42, W * 0.5, 1.2, 18);
  pool.scale(1, 1, 0.55);
  pool.translate(0, 0.4, 6);
  ice.push({ geo: pool, color: 0xffffff });
  const rockMesh = staticMesh(ctx, mergeParts(rock), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), 'waterfallCliff');
  placeAt(rockMesh, spot, spot.facing, 1.5);
  group.add(rockMesh);
  const iceMesh = staticMesh(ctx, mergeParts(ice), iceMaterial(), 'frozenWaterfall');
  iceMesh.castShadow = false;
  placeAt(iceMesh, spot, spot.facing, 1.5);
  group.add(iceMesh);
}

function addIceCastle(ctx: BuildContext, group: THREE.Group): void {
  // Beside the long climb, on the side away from the lake.
  const spot = findSpot(ctx, 0.66, 1, 22, 20);
  const parts: { geo: THREE.BufferGeometry; color: number }[] = [];
  const wallCol = 0xd6efff;
  const roofCol = 0x3f7fc9;
  const tower = (x: number, z: number, r: number, h: number): void => {
    parts.push({ geo: new THREE.CylinderGeometry(r, r * 1.08, h, 12).translate(x, h / 2, z), color: wallCol });
    parts.push({ geo: new THREE.ConeGeometry(r * 1.25, r * 3.2, 12).translate(x, h + r * 1.6, z), color: roofCol });
    // battlement ring
    parts.push({ geo: new THREE.TorusGeometry(r * 1.05, 0.35, 5, 12).rotateX(Math.PI / 2).translate(x, h - 0.4, z), color: 0xeef8ff });
    // pennant
    parts.push({ geo: new THREE.CylinderGeometry(0.06, 0.06, 3, 4).translate(x, h + r * 3.2 + 1.2, z), color: 0x333844 });
    parts.push({ geo: new THREE.PlaneGeometry(1.8, 0.9).translate(x + 0.9, h + r * 3.2 + 2.2, z), color: 0xff4d5a });
  };
  const half = 13;
  tower(-half, -half, 3.0, 20);
  tower(half, -half, 3.0, 20);
  tower(-half, half, 3.0, 18);
  tower(half, half, 3.0, 18);
  // curtain walls
  for (const [x, z, w, d] of [
    [0, -half, half * 2, 2.2],
    [0, half, half * 2, 2.2],
    [-half, 0, 2.2, half * 2],
    [half, 0, 2.2, half * 2],
  ]) {
    parts.push({ geo: new THREE.BoxGeometry(w, 12, d).translate(x, 6, z), color: wallCol });
    // crenellations
    const alongX = w > d;
    const count = Math.floor(Math.max(w, d) / 2.4);
    for (let k = 0; k < count; k++) {
      const f = -0.5 + (k + 0.5) / count;
      const merlon = alongX ? new THREE.BoxGeometry(1.2, 1.4, d + 0.2) : new THREE.BoxGeometry(w + 0.2, 1.4, 1.2);
      merlon.translate(x + (alongX ? f * w : 0), 12.7, z + (alongX ? 0 : f * d));
      parts.push({ geo: merlon, color: 0xeef8ff });
    }
  }
  // gate
  parts.push({ geo: new THREE.BoxGeometry(6, 8, 3).translate(0, 4, half + 0.4), color: 0xb4d8f2 });
  parts.push({ geo: new THREE.BoxGeometry(3.4, 6, 0.6).translate(0, 3, half + 1.8), color: 0x1e3a55 });
  // keep
  parts.push({ geo: new THREE.BoxGeometry(12, 22, 12).translate(0, 11, 0), color: wallCol });
  parts.push({ geo: new THREE.ConeGeometry(9.2, 10, 4).rotateY(Math.PI / 4).translate(0, 27, 0), color: roofCol });
  tower(0, 0, 2.2, 32);
  const castle = staticMesh(ctx, mergeParts(parts), iceMaterial(), 'iceCastle');
  (castle.material as THREE.MeshStandardMaterial).vertexColors = true;
  (castle.material as THREE.MeshStandardMaterial).color.set(0xffffff);
  (castle.material as THREE.MeshStandardMaterial).opacity = 0.96;
  (castle.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  placeAt(castle, spot, spot.facing, 1.0);
  group.add(castle);
}

// ------------------------------------------------------------------ neon: holographic billboard + monorail
function addHoloBillboard(ctx: BuildContext, group: THREE.Group): void {
  const spot = findSpot(ctx, 0.585, 1, 16, 8);
  const W = 30;
  const H = 14;
  const base = 16;
  const parts: { geo: THREE.BufferGeometry; color: number }[] = [];
  for (const sx of [-1, 1]) {
    parts.push({ geo: new THREE.BoxGeometry(1.2, base + H, 1.2).translate(sx * (W / 2 - 1.5), (base + H) / 2, 0), color: 0x1c1c2a });
  }
  parts.push({ geo: new THREE.BoxGeometry(W + 1.6, H + 1.6, 0.9).translate(0, base + H / 2, -0.2), color: 0x121220 });
  parts.push({ geo: new THREE.BoxGeometry(W + 2.4, 0.5, 1.6).translate(0, base + H + 1.1, 0), color: 0x00e5ff });
  parts.push({ geo: new THREE.BoxGeometry(W + 2.4, 0.5, 1.6).translate(0, base - 1.1, 0), color: 0xff2fd6 });
  const frame = staticMesh(ctx, mergeParts(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.6 }), 'holoBillboardFrame');
  placeAt(frame, spot, spot.facing + Math.PI, 0.5);
  group.add(frame);

  const tex = makeBillboardTexture(2);
  track(ctx, tex);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    emissive: 0xffffff,
    emissiveMap: tex,
    emissiveIntensity: 1.4,
    roughness: 0.5,
    transparent: true,
    opacity: 0.92,
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
  screen.name = 'holoBillboardScreen';
  screen.position.set(0, base + H / 2, 0.36);
  trackMesh(ctx, screen);
  const holder = new THREE.Group();
  placeAt(holder, spot, spot.facing + Math.PI, 0.5);
  holder.add(screen);
  group.add(holder);
  // hologram flicker + slow colour cycling
  ctx.updaters.push((_dt, elapsed) => {
    const flicker = Math.sin(elapsed * 23.0) > 0.96 ? 0.5 : 1;
    mat.emissiveIntensity = (1.3 + 0.25 * Math.sin(elapsed * 1.7)) * flicker;
    mat.opacity = 0.86 + 0.08 * Math.sin(elapsed * 3.3);
  });
}

function addMonorail(ctx: BuildContext, group: THREE.Group): void {
  const { cl, field } = ctx;
  // Elevated beam running beside the long straight and around hairpin 2 (t 0.44 .. 0.86), outer side.
  const t0 = 0.44;
  const t1 = 0.86;
  const side = -1;
  const lateralExtra = 15;
  const railY = 11.5;
  const n = cl.n;
  const i0 = Math.floor(t0 * n);
  const i1 = Math.floor(t1 * n);
  const step = 4;
  const count = Math.floor((i1 - i0) / step) + 1;
  // beam cross-section: 4 corners -> box tube
  const hw = 0.9;
  const hh = 0.55;
  const verts = new Float32Array(count * 4 * 3);
  const idx: number[] = [];
  const baseY = (i: number): number => cl.py[i] + railY;
  for (let k = 0; k < count; k++) {
    const i = i0 + k * step;
    const lat = cl.whw[i] + lateralExtra;
    const x = cl.px[i] + cl.bx[i] * side * lat;
    const z = cl.pz[i] + cl.bz[i] * side * lat;
    const y = baseY(i);
    const corners = [
      [x - cl.bx[i] * hw, y + hh, z - cl.bz[i] * hw],
      [x + cl.bx[i] * hw, y + hh, z + cl.bz[i] * hw],
      [x + cl.bx[i] * hw, y - hh, z + cl.bz[i] * hw],
      [x - cl.bx[i] * hw, y - hh, z - cl.bz[i] * hw],
    ];
    for (let c = 0; c < 4; c++) {
      const o = (k * 4 + c) * 3;
      verts[o] = corners[c][0];
      verts[o + 1] = corners[c][1];
      verts[o + 2] = corners[c][2];
    }
    if (k > 0) {
      const a = (k - 1) * 4;
      const b = k * 4;
      for (let c = 0; c < 4; c++) {
        const c2 = (c + 1) % 4;
        idx.push(a + c, b + c, a + c2, a + c2, b + c, b + c2);
      }
    }
  }
  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  beamGeo.setIndex(idx);
  beamGeo.computeVertexNormals();
  beamGeo.computeBoundingSphere();
  const beam = staticMesh(ctx, beamGeo, new THREE.MeshStandardMaterial({ color: 0x2a2a3c, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }), 'monorailBeam');
  beam.receiveShadow = false;
  group.add(beam);

  // glowing guide strip on the inner face of the beam
  const glowVerts = new Float32Array(count * 2 * 3);
  const glowIdx: number[] = [];
  for (let k = 0; k < count; k++) {
    const i = i0 + k * step;
    const lat = cl.whw[i] + lateralExtra - hw - 0.02;
    const x = cl.px[i] + cl.bx[i] * side * lat;
    const z = cl.pz[i] + cl.bz[i] * side * lat;
    const y = baseY(i);
    glowVerts.set([x, y + 0.12, z, x, y - 0.12, z], k * 6);
    if (k > 0) {
      const a = (k - 1) * 2;
      glowIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(glowVerts, 3));
  glowGeo.setIndex(glowIdx);
  glowGeo.computeVertexNormals();
  glowGeo.computeBoundingSphere();
  const glow = new THREE.Mesh(glowGeo, new THREE.MeshStandardMaterial({ color: 0, emissive: 0x00e5ff, emissiveIntensity: 1.6, side: THREE.DoubleSide }));
  glow.name = 'monorailGlow';
  trackMesh(ctx, glow);
  group.add(glow);

  // pylons every ~22 m
  const pylonGeo = new THREE.BoxGeometry(1.1, 1, 1.1);
  pylonGeo.translate(0, 0.5, 0);
  const pylonMat = new THREE.MeshStandardMaterial({ color: 0x1a1a28, roughness: 0.5, metalness: 0.5 });
  const spacing = 22;
  const span = (t1 - t0) * cl.length;
  const pylonCount = Math.floor(span / spacing) + 1;
  const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, pylonCount);
  for (let k = 0; k < pylonCount; k++) {
    const i = Math.min(i1, i0 + Math.floor(((k * spacing) / cl.length) * n));
    const lat = cl.whw[i] + lateralExtra;
    const x = cl.px[i] + cl.bx[i] * side * lat;
    const z = cl.pz[i] + cl.bz[i] * side * lat;
    const groundY = field.heightAt(x, z) - 0.5;
    const h = baseY(i) - hh - groundY;
    _p.set(x, groundY, z);
    _e.set(0, headingFromDir(cl.tx[i], cl.tz[i]), 0);
    _q.setFromEuler(_e);
    _s.set(1, h, 1);
    _m.compose(_p, _q, _s);
    pylons.setMatrixAt(k, _m);
  }
  pylons.instanceMatrix.needsUpdate = true;
  pylons.castShadow = true;
  pylons.name = 'monorailPylons';
  trackMesh(ctx, pylons);
  group.add(pylons);

  // train: 3 cars, shuttles back and forth along the beam
  const carParts: { geo: THREE.BufferGeometry; color: number }[] = [];
  const carLen = 7;
  for (let c = 0; c < 3; c++) {
    const z0 = (c - 1) * (carLen + 0.6);
    const body = new THREE.BoxGeometry(2.4, 2.4, carLen);
    body.translate(0, hh + 1.5, z0);
    carParts.push({ geo: body, color: 0xe8ecf4 });
    const roof = new THREE.BoxGeometry(2.0, 0.4, carLen - 0.8);
    roof.translate(0, hh + 2.9, z0);
    carParts.push({ geo: roof, color: 0x2a2a3c });
    const skirt = new THREE.BoxGeometry(2.6, 0.5, carLen - 0.4);
    skirt.translate(0, hh + 0.25, z0);
    carParts.push({ geo: skirt, color: 0x1a1a28 });
    for (const sx of [-1, 1]) {
      const win = new THREE.BoxGeometry(0.1, 0.9, carLen - 1.4);
      win.translate(sx * 1.22, hh + 1.9, z0);
      carParts.push({ geo: win, color: 0x00e5ff });
      const stripe = new THREE.BoxGeometry(0.06, 0.25, carLen - 0.6);
      stripe.translate(sx * 1.24, hh + 0.8, z0);
      carParts.push({ geo: stripe, color: 0xff2fd6 });
    }
  }
  // nose cones
  for (const dir of [-1, 1]) {
    const nose = new THREE.ConeGeometry(1.3, 2.2, 8);
    nose.rotateX(dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    nose.translate(0, hh + 1.5, dir * (1.5 * carLen + 1.2 + 1.1));
    carParts.push({ geo: nose, color: 0xe8ecf4 });
  }
  const trainGeo = mergeParts(carParts);
  const trainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.0 });
  // make the cyan windows glow via a second material would cost a draw call; instead tint emissive by vertex colour
  trainMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n float glowMask = step(0.8, vColor.b) * step(vColor.r, 0.3);\n float magenta = step(0.8, vColor.r) * step(0.8, vColor.b) * step(vColor.g, 0.4);\n totalEmissiveRadiance += vColor.rgb * (glowMask * 1.6 + magenta * 1.4);',
    );
  };
  trainMat.customProgramCacheKey = () => 'tkr-monorail-train';
  const train = new THREE.Mesh(trainGeo, trainMat);
  train.name = 'monorailTrain';
  train.castShadow = true;
  trackMesh(ctx, train);
  group.add(train);

  const sStart = t0 * cl.length + 14;
  const sEnd = t1 * cl.length - 14;
  const speed = 16;
  const period = (sEnd - sStart) / speed;
  ctx.updaters.push((_dt, elapsed) => {
    // ping-pong with a short dwell at each end
    const cycle = (period + 3) * 2;
    let u = (elapsed % cycle) / cycle;
    let forward = true;
    if (u >= 0.5) {
      u = (u - 0.5) * 2;
      forward = false;
    } else u *= 2;
    const dwell = 3 / (period + 3);
    const k = Math.min(1, Math.max(0, (u - dwell * 0.5) / (1 - dwell)));
    const s = forward ? lerp(sStart, sEnd, k) : lerp(sEnd, sStart, k);
    const i = Math.floor((s / cl.length) * n) % n;
    const lat = cl.whw[i] + lateralExtra;
    train.position.set(cl.px[i] + cl.bx[i] * side * lat, baseY(i), cl.pz[i] + cl.bz[i] * side * lat);
    const h = headingFromDir(cl.tx[i], cl.tz[i]);
    train.rotation.y = forward ? h : h + Math.PI;
  });
}
