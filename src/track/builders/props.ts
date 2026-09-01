import * as THREE from 'three';
import type { BuildContext } from './context';
import { headingFromDir, indexAtS, track, trackMesh } from './context';
import { mergeParts } from './decor';
import {
  makeBannerTexture,
  makeBoostBaseTexture,
  makeBoostChevronTile,
  makeBoostTrailTexture,
  makeSponsorTexture,
  makeStartBannerTexture,
} from '../textures';
import { lerp } from '../../core/math';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
const _c = new THREE.Color();

/** Length (metres) of the visible boost strip; the 'boost' surface region uses the same value. */
export const BOOST_PAD_LENGTH = 3.5;
/** Distance from the road edge (curb line) to the pad edge. */
const BOOST_PAD_INSET = 1.0;

export interface RoadFrame {
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
  rx: number;
  rz: number;
  hw: number;
  whw: number;
  heading: number;
}

/** Frame at arc-length s: position, forward (horizontal), right. */
export function frameAtS(ctx: BuildContext, s: number): RoadFrame {
  const cl = ctx.cl;
  const i = indexAtS(cl, s);
  const th = Math.hypot(cl.tx[i], cl.tz[i]) || 1;
  const fx = cl.tx[i] / th;
  const fz = cl.tz[i] / th;
  return {
    x: cl.px[i],
    y: cl.py[i],
    z: cl.pz[i],
    fx,
    fz,
    rx: cl.bx[i],
    rz: cl.bz[i],
    hw: cl.hw[i],
    whw: cl.whw[i],
    heading: headingFromDir(fx, fz),
  };
}

/** Fictional sponsors per theme (name, background, text, accent). */
function sponsorsFor(theme: string): { text: string; bg: number; fg: number; accent: number }[] {
  switch (theme) {
    case 'desert':
    case 'volcano':
      return [
        { text: 'NITRO COLA', bg: 0x8a1f1f, fg: 0xfff2d0, accent: 0xffb347 },
        { text: 'DUNE DRIFT GP', bg: 0x2b1a12, fg: 0xffd27a, accent: 0xc7502f },
        { text: 'SCORPION OIL', bg: 0x1c1c1c, fg: 0xffe27a, accent: 0xd9a15c },
      ];
    case 'snow':
      return [
        { text: 'GLACIER GRIP TYRES', bg: 0x123a66, fg: 0xffffff, accent: 0x9fd3ff },
        { text: 'FROSTBITE FALLS', bg: 0xffffff, fg: 0x1f4f8a, accent: 0x2f6fb5 },
        { text: 'POLAR PLUS ENERGY', bg: 0x0d2540, fg: 0xbfe6ff, accent: 0xffffff },
      ];
    case 'neon':
      return [
        { text: 'NEXUS NETWORKS', bg: 0x0b0418, fg: 0x00e5ff, accent: 0xff2fd6 },
        { text: 'VOLT KART BATTERIES', bg: 0x120a22, fg: 0xff2fd6, accent: 0x00e5ff },
        { text: 'HOLO-DRIVE', bg: 0x061a22, fg: 0xffe83a, accent: 0x00e5ff },
      ];
    default:
      return [
        { text: 'TURBO TYRES', bg: 0x1c1c22, fg: 0xffffff, accent: 0xd8272b },
        { text: 'KART FM 101', bg: 0x1f4fa8, fg: 0xffe14a, accent: 0xffffff },
        { text: 'NITRO COLA', bg: 0xc81e2b, fg: 0xfff2d0, accent: 0xffffff },
      ];
  }
}

// -----------------------------------------------------------------------------------------------
// Grandstands
// -----------------------------------------------------------------------------------------------

/** Stadium grandstands on both sides of the start straight, with sponsor boards, floodlights and a cheering crowd. */
export function buildGrandstands(ctx: BuildContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'grandstands';
  const theme = ctx.def.theme;
  const rng = ctx.rng;
  const length = 66;
  const tiers = 6;
  const tierDepth = 1.9;
  const tierRise = 1.05;
  const centerS = 16; // metres past the finish line
  const f = frameAtS(ctx, centerS);
  const isNight = theme === 'neon';
  const accent = new THREE.Color(isNight ? 0x2a1450 : theme === 'desert' ? 0xb8552a : theme === 'snow' ? 0x2f6fb5 : 0xc8242c);
  const concrete = new THREE.Color(isNight ? 0x1a1a26 : 0x9a9aa0);
  const seatA = new THREE.Color(isNight ? 0x24163a : theme === 'desert' ? 0xe0b070 : theme === 'snow' ? 0x3d7fc4 : 0xd83a3a);
  const seatB = new THREE.Color(isNight ? 0x1a2a44 : theme === 'desert' ? 0xc07a48 : theme === 'snow' ? 0xdfeeff : 0xf0f0f0);

  const parts: { geo: THREE.BufferGeometry; color: number | THREE.Color }[] = [];
  const crowdSlots: { lat: number; along: number; y: number }[] = [];
  const base = f.whw + 3.2;
  const topY = tierRise * tiers;
  const roofY = topY + 4.6;
  for (let side = -1; side <= 1; side += 2) {
    for (let k = 0; k < tiers; k++) {
      const lat = side * (base + tierDepth * (k + 0.5));
      const h = tierRise * (k + 1);
      const box = new THREE.BoxGeometry(tierDepth, h, length);
      box.translate(lat, h / 2, 0);
      parts.push({ geo: box, color: k % 2 === 0 ? concrete : concrete.clone().offsetHSL(0, 0, -0.06) });
      // coloured seat strip along the front edge of every tier
      const seats = new THREE.BoxGeometry(0.5, 0.12, length);
      seats.translate(side * (base + tierDepth * k + 0.3), h + 0.06, 0);
      parts.push({ geo: seats, color: k % 2 === 0 ? seatA : seatB });
      const count = Math.floor(length / 0.8);
      for (let c = 0; c < count; c++) {
        if (rng() < 0.1) continue;
        crowdSlots.push({ lat: lat + side * (rng() - 0.5) * 0.5, along: -length / 2 + 0.5 + c * 0.8 + (rng() - 0.5) * 0.3, y: h });
      }
    }
    // front wall with accent stripe + sponsor board panel face
    const wall = new THREE.BoxGeometry(0.3, 1.25, length + 0.6);
    wall.translate(side * (base - 0.15), 0.625, 0);
    parts.push({ geo: wall, color: accent });
    // back wall
    const backWall = new THREE.BoxGeometry(0.4, topY + 1.2, length + 0.6);
    backWall.translate(side * (base + tierDepth * tiers + 0.2), (topY + 1.2) / 2, 0);
    parts.push({ geo: backWall, color: concrete.clone().offsetHSL(0, 0, -0.1) });
    // roof on posts, sloping slightly toward the track
    const roof = new THREE.BoxGeometry(tierDepth * tiers + 2.5, 0.3, length + 2);
    roof.rotateZ(-side * 0.06);
    roof.translate(side * (base + (tierDepth * tiers) / 2 + 0.2), roofY, 0);
    parts.push({ geo: roof, color: accent.clone().offsetHSL(0, 0, -0.12) });
    const roofLip = new THREE.BoxGeometry(0.25, 0.9, length + 2);
    roofLip.translate(side * (base - 0.9), roofY + 0.2, 0);
    parts.push({ geo: roofLip, color: isNight ? 0x00e5ff : 0xf4f4f4 });
    for (let p = 0; p < 6; p++) {
      const post = new THREE.CylinderGeometry(0.18, 0.18, roofY + 0.6, 6);
      post.translate(side * (base + tierDepth * tiers + 0.6), (roofY + 0.6) / 2, -length / 2 + (p / 5) * length);
      parts.push({ geo: post, color: concrete.clone().offsetHSL(0, 0, -0.2) });
    }
    // floodlight masts at both ends of each stand
    for (const end of [-1, 1]) {
      const mastH = roofY + 9;
      const mast = new THREE.CylinderGeometry(0.22, 0.34, mastH, 6);
      const mx = side * (base + tierDepth * tiers + 2.2);
      const mz = end * (length / 2 + 2.5);
      mast.translate(mx, mastH / 2, mz);
      parts.push({ geo: mast, color: 0x6a6a72 });
      const head = new THREE.BoxGeometry(2.6, 1.2, 0.5);
      head.translate(mx - side * 0.6, mastH + 0.4, mz);
      parts.push({ geo: head, color: 0x2a2a30 });
    }
  }
  const geo = mergeParts(parts);
  const stands = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
  stands.castShadow = true;
  stands.receiveShadow = true;
  stands.name = 'grandstandStructure';
  trackMesh(ctx, stands);
  _e.set(0, f.heading, 0);
  stands.quaternion.setFromEuler(_e);
  stands.position.set(f.x, f.y, f.z);
  group.add(stands);

  // Floodlight lamp clusters (emissive) - one instanced mesh.
  {
    const lampGeo = new THREE.BoxGeometry(2.3, 0.7, 0.2);
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: isNight ? 2.2 : 1.1, roughness: 0.3 });
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, 4);
    let li = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (const end of [-1, 1]) {
        const mastH = roofY + 9;
        const lx = side * (base + tierDepth * tiers + 2.2) - side * 0.6;
        const lz = end * (length / 2 + 2.5);
        _p.set(f.x + f.rx * lx - f.fx * lz, f.y + mastH + 0.4, f.z + f.rz * lx - f.fz * lz);
        _e.set(0.35 * side, f.heading + (side > 0 ? Math.PI / 2 : -Math.PI / 2), 0);
        _q.setFromEuler(_e);
        _s.set(1, 1, 1);
        _m.compose(_p, _q, _s);
        lamps.setMatrixAt(li++, _m);
      }
    }
    lamps.instanceMatrix.needsUpdate = true;
    lamps.name = 'floodlights';
    trackMesh(ctx, lamps);
    group.add(lamps);
  }

  // Sponsor boards along the front wall (3 per side, fictional brands). One plane geometry, 3 materials.
  {
    const sponsors = sponsorsFor(theme);
    const boardGeo = new THREE.PlaneGeometry(14, 1.05);
    ctx.disposables.push(boardGeo);
    for (let k = 0; k < sponsors.length; k++) {
      const sp = sponsors[k];
      const tex = makeSponsorTexture(sp.text, sp.bg, sp.fg, sp.accent, isNight);
      track(ctx, tex);
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.6,
        emissive: isNight ? new THREE.Color(0xffffff) : new THREE.Color(0),
        emissiveMap: isNight ? tex : null,
        emissiveIntensity: isNight ? 0.9 : 0,
      });
      ctx.disposables.push(mat);
      for (let side = -1; side <= 1; side += 2) {
        const board = new THREE.Mesh(boardGeo, mat);
        const along = (k - 1) * 20;
        const lat = side * (base - 0.32);
        board.position.set(f.x + f.rx * lat - f.fx * along, f.y + 0.66, f.z + f.rz * lat - f.fz * along);
        // face the track (inward)
        _e.set(0, f.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 0);
        board.quaternion.setFromEuler(_e);
        board.name = 'sponsorBoard';
        group.add(board);
      }
    }
  }

  // Crowd: instanced little people with a shader bob.
  const body = new THREE.BoxGeometry(0.42, 0.8, 0.3);
  body.translate(0, 0.4, 0);
  const head = new THREE.SphereGeometry(0.16, 6, 4);
  head.translate(0, 0.95, 0);
  const crowdGeo = mergeParts([
    { geo: body, color: 0xffffff },
    { geo: head, color: 0xf1c9a5 },
  ]);
  const phases = new Float32Array(crowdSlots.length);
  for (let i = 0; i < phases.length; i++) phases[i] = rng() * Math.PI * 2;
  crowdGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  const crowdMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const timeUniform = ctx.timeUniform;
  crowdMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float aPhase;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nfloat bob = max(0.0, sin(uTime * 5.5 + aPhase)) * 0.28 * step(0.02, position.y);\ntransformed.y += bob;',
      );
  };
  crowdMat.customProgramCacheKey = () => 'tkr-crowd-bob';
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, crowdSlots.length);
  crowd.name = 'crowd';
  crowd.castShadow = false;
  const shirt = [0xff4d4d, 0x4da6ff, 0xffd84d, 0x6bff6b, 0xff9a3a, 0xffffff, 0xc86bff, 0x30d5c8];
  for (let i = 0; i < crowdSlots.length; i++) {
    const sl = crowdSlots[i];
    _p.set(f.x + f.rx * sl.lat - f.fx * sl.along, f.y + sl.y, f.z + f.rz * sl.lat - f.fz * sl.along);
    _e.set(0, f.heading + (sl.lat > 0 ? Math.PI / 2 : -Math.PI / 2) + (rng() - 0.5) * 0.5, 0);
    _q.setFromEuler(_e);
    const sc = 0.9 + rng() * 0.25;
    _s.set(sc, sc, sc);
    _m.compose(_p, _q, _s);
    crowd.setMatrixAt(i, _m);
    crowd.setColorAt(i, _c.setHex(shirt[Math.floor(rng() * shirt.length)]));
  }
  crowd.instanceMatrix.needsUpdate = true;
  if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
  trackMesh(ctx, crowd);
  group.add(crowd);
  return group;
}

// -----------------------------------------------------------------------------------------------
// Start gantry
// -----------------------------------------------------------------------------------------------

/** Start/finish gantry: twin pillars, truss crossbar, checkered START/FINISH banner, title board and start lights. */
export function buildGantry(ctx: BuildContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'gantry';
  const theme = ctx.def.theme;
  const isNight = theme === 'neon';
  const f = frameAtS(ctx, 0);
  const span = f.hw * 2 + 5.2;
  const height = 9.2;
  const metal = isNight ? 0x20202e : 0xe8e8ee;
  const parts: { geo: THREE.BufferGeometry; color: number | THREE.Color }[] = [];
  // lattice pillars (4 legs + cross braces)
  for (const sx of [-1, 1]) {
    for (const dx of [-0.42, 0.42]) {
      for (const dz of [-0.42, 0.42]) {
        const leg = new THREE.BoxGeometry(0.16, height, 0.16);
        leg.translate(sx * span / 2 + dx, height / 2, dz);
        parts.push({ geo: leg, color: metal });
      }
    }
    for (let k = 1; k < 6; k++) {
      const y = (k / 6) * height;
      const brace = new THREE.BoxGeometry(1.0, 0.1, 1.0);
      brace.translate(sx * span / 2, y, 0);
      parts.push({ geo: brace, color: metal });
    }
    const foot = new THREE.BoxGeometry(1.6, 0.4, 1.6);
    foot.translate(sx * span / 2, 0.2, 0);
    parts.push({ geo: foot, color: 0x3a3a40 });
  }
  // crossbar (banner housing) + truss chords
  const bar = new THREE.BoxGeometry(span + 1.0, 2.2, 1.1).translate(0, height - 0.9, 0);
  parts.push({ geo: bar, color: isNight ? 0x14141f : 0x2b2b30 });
  for (const dz of [-0.62, 0.62]) {
    parts.push({ geo: new THREE.BoxGeometry(span + 1.0, 0.14, 0.14).translate(0, height + 0.3, dz), color: isNight ? ctx.def.palette.curb : 0xd12b2b });
    parts.push({ geo: new THREE.BoxGeometry(span + 1.0, 0.14, 0.14).translate(0, height - 2.1, dz), color: isNight ? ctx.def.palette.roadStripe : 0xd12b2b });
  }
  const segs = Math.max(4, Math.round(span / 2.2));
  for (let k = 0; k <= segs; k++) {
    const x = -span / 2 - 0.5 + (k / segs) * (span + 1.0);
    parts.push({ geo: new THREE.BoxGeometry(0.1, 2.5, 0.1).translate(x, height - 0.9, 0.62), color: metal });
    parts.push({ geo: new THREE.BoxGeometry(0.1, 2.5, 0.1).translate(x, height - 0.9, -0.62), color: metal });
  }
  // start-light housing hanging under the bar (centre)
  const housing = new THREE.BoxGeometry(5.2, 0.9, 0.6).translate(0, height - 2.5, 0);
  parts.push({ geo: housing, color: 0x1a1a1e });
  const geo = mergeParts(parts);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.5 });
  const structure = new THREE.Mesh(geo, mat);
  structure.castShadow = true;
  structure.receiveShadow = true;
  structure.name = 'gantryStructure';
  trackMesh(ctx, structure);
  group.add(structure);

  // Checkered START/FINISH banner on both faces of the crossbar.
  const banner = makeStartBannerTexture(theme, ctx.def.palette.roadStripe);
  track(ctx, banner);
  const bannerMat = new THREE.MeshBasicMaterial({ map: banner, toneMapped: !isNight });
  const plane = new THREE.PlaneGeometry(span - 0.6, 1.9);
  const front = new THREE.Mesh(plane, bannerMat);
  front.position.set(0, height - 0.9, 0.57); // faces +Z (local) = toward approaching karts
  const back = new THREE.Mesh(plane, bannerMat);
  back.rotation.y = Math.PI;
  back.position.set(0, height - 0.9, -0.57);
  ctx.disposables.push(plane, bannerMat);
  group.add(front, back);

  // Game title board on top of the gantry (fictional broadcast-style header).
  const title = makeBannerTexture(theme, ctx.def.palette.roadStripe);
  track(ctx, title);
  const titleMat = new THREE.MeshBasicMaterial({ map: title, toneMapped: !isNight, side: THREE.DoubleSide });
  const titleGeo = new THREE.PlaneGeometry(span * 0.62, span * 0.62 * 0.25);
  const titleMesh = new THREE.Mesh(titleGeo, titleMat);
  titleMesh.position.set(0, height + 0.4 + (span * 0.62 * 0.25) / 2, 0);
  ctx.disposables.push(titleGeo, titleMat);
  group.add(titleMesh);

  // Start lights: 5 lamps under the bar (red/amber/green mix) - purely decorative, slow cycle.
  const lampGeo = new THREE.SphereGeometry(0.26, 10, 8);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.4, roughness: 0.3, vertexColors: false });
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, 5);
  for (let i = 0; i < 5; i++) {
    _p.set(-2.0 + i * 1.0, height - 2.5, 0.35);
    _e.set(0, 0, 0);
    _q.setFromEuler(_e);
    _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);
    lamps.setMatrixAt(i, _m);
    lamps.setColorAt(i, _c.setHex(i < 2 ? 0xff3b30 : i < 4 ? 0xffb020 : 0x3dff6a));
  }
  lamps.instanceMatrix.needsUpdate = true;
  if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  lamps.name = 'startLights';
  trackMesh(ctx, lamps);
  group.add(lamps);
  ctx.updaters.push((_dt, elapsed) => {
    lampMat.emissiveIntensity = 1.1 + 0.5 * (0.5 + 0.5 * Math.sin(elapsed * 2.4));
  });

  if (isNight) {
    // glowing tube along the bar
    const tube = new THREE.BoxGeometry(span + 1.2, 0.12, 0.12).translate(0, height + 0.5, 0);
    const tubeMat = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(ctx.def.palette.curb), emissiveIntensity: 2.0 });
    const tm = new THREE.Mesh(tube, tubeMat);
    trackMesh(ctx, tm);
    group.add(tm);
  } else {
    // little flags on top of the crossbar
    const flagGeo = mergeParts([
      { geo: new THREE.CylinderGeometry(0.04, 0.04, 1.2, 5).translate(0, 0.6, 0), color: 0xdddddd },
      { geo: new THREE.PlaneGeometry(0.7, 0.45).translate(0.37, 1.0, 0), color: 0xffd23a },
    ]);
    const flagMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 });
    const n = 9;
    const flags = new THREE.InstancedMesh(flagGeo, flagMat, n);
    for (let i = 0; i < n; i++) {
      _p.set(-span / 2 + (i / (n - 1)) * span, height + 0.4, 0.62);
      _e.set(0, 0, 0);
      _q.setFromEuler(_e);
      _s.set(1, 1, 1);
      _m.compose(_p, _q, _s);
      flags.setMatrixAt(i, _m);
      flags.setColorAt(i, _c.setHex(i % 2 === 0 ? 0xffffff : 0xff4040));
    }
    flags.instanceMatrix.needsUpdate = true;
    if (flags.instanceColor) flags.instanceColor.needsUpdate = true;
    trackMesh(ctx, flags);
    group.add(flags);
  }

  _e.set(0, f.heading, 0);
  group.quaternion.setFromEuler(_e);
  group.position.set(f.x, f.y, f.z);
  return group;
}

// -----------------------------------------------------------------------------------------------
// Sponsor bridges over the track
// -----------------------------------------------------------------------------------------------

/** Two sponsor bridges spanning the road further along the lap (fictional brands, CanvasTexture text). */
export function buildSponsorBridges(ctx: BuildContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'sponsorBridges';
  const theme = ctx.def.theme;
  const isNight = theme === 'neon';
  const sponsors = sponsorsFor(theme);
  const L = ctx.cl.length;
  // One just after the grandstands, one on the far side of the lap (off the void on Frostbite).
  const spots = [92, L * (ctx.def.voidRanges && ctx.def.voidRanges.length ? 0.72 : 0.55)];
  const metal = isNight ? 0x1c1c2a : 0xd8d8de;
  const parts: { geo: THREE.BufferGeometry; color: number | THREE.Color }[] = [];
  const bannerGeo = new THREE.PlaneGeometry(1, 1);
  ctx.disposables.push(bannerGeo);
  spots.forEach((s, k) => {
    const f = frameAtS(ctx, s);
    const span = f.whw * 2 + 3.0;
    const h = 7.4;
    const local: { geo: THREE.BufferGeometry; color: number | THREE.Color }[] = [];
    for (const sx of [-1, 1]) {
      local.push({ geo: new THREE.BoxGeometry(0.55, h, 0.55).translate(sx * span / 2, h / 2, 0), color: metal });
      local.push({ geo: new THREE.BoxGeometry(1.4, 0.35, 1.4).translate(sx * span / 2, 0.17, 0), color: 0x3a3a40 });
    }
    local.push({ geo: new THREE.BoxGeometry(span + 0.55, 0.35, 0.9).translate(0, h - 0.17, 0), color: metal });
    local.push({ geo: new THREE.BoxGeometry(span + 0.55, 0.35, 0.9).translate(0, h - 2.35, 0), color: metal });
    for (let i = 0; i <= 8; i++) {
      const x = -span / 2 + (i / 8) * span;
      local.push({ geo: new THREE.BoxGeometry(0.1, 2.0, 0.1).translate(x, h - 1.26, 0.35), color: metal });
      local.push({ geo: new THREE.BoxGeometry(0.1, 2.0, 0.1).translate(x, h - 1.26, -0.35), color: metal });
    }
    // transform this bridge into world space
    _e.set(0, f.heading, 0);
    _q.setFromEuler(_e);
    _p.set(f.x, f.y, f.z);
    _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);
    for (const part of local) {
      part.geo.applyMatrix4(_m);
      parts.push(part);
    }
    // banner planes (both faces)
    const sp = sponsors[(k + 1) % sponsors.length];
    const tex = makeSponsorTexture(sp.text, sp.bg, sp.fg, sp.accent, isNight);
    track(ctx, tex);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.6,
      emissive: isNight ? new THREE.Color(0xffffff) : new THREE.Color(0),
      emissiveMap: isNight ? tex : null,
      emissiveIntensity: isNight ? 1.0 : 0,
    });
    ctx.disposables.push(mat);
    for (const face of [1, -1]) {
      const b = new THREE.Mesh(bannerGeo, mat);
      b.scale.set(span - 1.2, 1.8, 1);
      b.position.set(0, h - 1.26, face * 0.42);
      if (face < 0) b.rotation.y = Math.PI;
      const holder = new THREE.Group();
      holder.quaternion.copy(_q);
      holder.position.copy(_p);
      holder.add(b);
      b.name = 'sponsorBridgeBanner';
      group.add(holder);
    }
  });
  const geo = mergeParts(parts);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'sponsorBridgeStructure';
  trackMesh(ctx, mesh);
  group.add(mesh);
  return group;
}

// -----------------------------------------------------------------------------------------------
// Boost pads
// -----------------------------------------------------------------------------------------------

export interface BoostPadInfo {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  halfWidth: number;
}

/** Append a road-following ribbon (subdivided along s) to the given buffers. */
function pushRibbon(
  ctx: BuildContext,
  verts: number[],
  uvs: number[],
  idx: number[],
  norms: number[],
  s0: number,
  s1: number,
  halfWidthAt: (f: RoadFrame) => number,
  lift: number,
  vRepeat: number,
  segments: number,
): void {
  const base = verts.length / 3;
  for (let k = 0; k <= segments; k++) {
    const f = frameAtS(ctx, lerp(s0, s1, k / segments));
    const w = halfWidthAt(f);
    verts.push(f.x - f.rx * w, f.y + lift, f.z - f.rz * w, f.x + f.rx * w, f.y + lift, f.z + f.rz * w);
    const v = (k / segments) * vRepeat;
    uvs.push(0, v, 1, v);
    norms.push(0, 1, 0, 0, 1, 0);
  }
  for (let k = 0; k < segments; k++) {
    const a = base + k * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

function ribbonGeometry(verts: number[], uvs: number[], idx: number[], norms: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Mario Kart style boost pads: a dark rounded strip (BOOST_PAD_LENGTH long, inside the road edge
 * lines) carrying three scrolling orange-to-yellow chevrons, plus a faint orange trail on the road
 * ahead of each pad. Three merged meshes for all pads.
 */
export function buildBoostPads(ctx: BuildContext, pads: BoostPadInfo[]): THREE.Group | null {
  const { cl, def } = ctx;
  if (def.boostPads.length === 0) return null;
  const group = new THREE.Group();
  group.name = 'boostPads';
  const halfLen = BOOST_PAD_LENGTH / 2;
  const chevronInset = 0.28;
  const chevronCount = 3;
  const trailLen = 7.0;

  const bV: number[] = [];
  const bU: number[] = [];
  const bI: number[] = [];
  const bN: number[] = [];
  const cV: number[] = [];
  const cU: number[] = [];
  const cI: number[] = [];
  const cN: number[] = [];
  const tV: number[] = [];
  const tU: number[] = [];
  const tI: number[] = [];
  const tN: number[] = [];

  for (const t of def.boostPads) {
    const s = t * cl.length;
    const fc = frameAtS(ctx, s);
    const w = Math.max(3, fc.hw - BOOST_PAD_INSET);
    pushRibbon(ctx, bV, bU, bI, bN, s - halfLen, s + halfLen, () => w, 0.03, 1, 4);
    pushRibbon(ctx, cV, cU, cI, cN, s - halfLen + chevronInset, s + halfLen - chevronInset, () => w - chevronInset, 0.045, chevronCount, 4);
    pushRibbon(ctx, tV, tU, tI, tN, s + halfLen, s + halfLen + trailLen, () => w * 0.9, 0.02, 1, 6);
    pads.push({
      position: new THREE.Vector3(fc.x, fc.y, fc.z),
      forward: new THREE.Vector3(fc.fx, 0, fc.fz).normalize(),
      halfWidth: w,
    });
  }

  // base strip
  const baseTex = makeBoostBaseTexture();
  track(ctx, baseTex);
  const baseMat = new THREE.MeshStandardMaterial({
    map: baseTex,
    transparent: true,
    roughness: 0.55,
    metalness: 0.1,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const baseMesh = new THREE.Mesh(ribbonGeometry(bV, bU, bI, bN), baseMat);
  baseMesh.name = 'boostPadBase';
  baseMesh.receiveShadow = true;
  baseMesh.renderOrder = 2;
  trackMesh(ctx, baseMesh);
  group.add(baseMesh);

  // trail on the road ahead of the pad
  const trailTex = makeBoostTrailTexture();
  track(ctx, trailTex);
  const trailMat = new THREE.MeshBasicMaterial({
    map: trailTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const trailMesh = new THREE.Mesh(ribbonGeometry(tV, tU, tI, tN), trailMat);
  trailMesh.name = 'boostPadTrail';
  trailMesh.renderOrder = 1;
  trackMesh(ctx, trailMesh);
  group.add(trailMesh);

  // scrolling chevrons
  const chevTex = makeBoostChevronTile();
  track(ctx, chevTex);
  const chevMat = new THREE.MeshStandardMaterial({
    map: chevTex,
    transparent: true,
    depthWrite: false,
    emissive: 0xffffff,
    emissiveMap: chevTex,
    emissiveIntensity: 1.2,
    roughness: 0.4,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const chevMesh = new THREE.Mesh(ribbonGeometry(cV, cU, cI, cN), chevMat);
  chevMesh.name = 'boostPadChevrons';
  chevMesh.renderOrder = 3;
  trackMesh(ctx, chevMesh);
  group.add(chevMesh);

  ctx.updaters.push((dt, elapsed) => {
    // chevrons travel forward at ~2 chevrons per second
    chevTex.offset.y -= dt * 2.0;
    if (chevTex.offset.y < -1000) chevTex.offset.y += 1000;
    chevMat.emissiveIntensity = 1.2 + Math.sin(elapsed * 5) * 0.12;
  });
  return group;
}

/** Item box positions: ITEM_BOX_ROW_SIZE boxes across 80% of the road width, ~1 m above the road. */
export function computeItemBoxPositions(ctx: BuildContext, rowSize: number): THREE.Vector3[] {
  const { cl, def } = ctx;
  const out: THREE.Vector3[] = [];
  for (const t of def.itemBoxRows) {
    const f = frameAtS(ctx, t * cl.length);
    const span = f.hw * 0.8;
    for (let k = 0; k < rowSize; k++) {
      const lat = rowSize === 1 ? 0 : lerp(-span, span, k / (rowSize - 1));
      out.push(new THREE.Vector3(f.x + f.rx * lat, f.y + 1.0, f.z + f.rz * lat));
    }
  }
  return out;
}
