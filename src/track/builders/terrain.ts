import * as THREE from 'three';
import type { TrackTheme } from '../../core/types';
import type { BuildContext } from './context';
import { color, track, trackMesh } from './context';
import { makeGroundTexture } from '../textures';
import { TERRAIN_EXTENT, VOID_BASIN_DEPTH } from '../TerrainField';
import { fbm2, smoothstep, clamp01, lerp } from '../../core/math';

const TERRAIN_SEGMENTS = 240;

/**
 * Per-theme terrain ramp. `low`/`high` blend by elevation, `rock` is painted onto
 * slopes, and `deep` fills whatever sits well below the road: frozen lake on the
 * snow circuit, glowing lava on the volcano.
 */
const TERRAIN_COLORS: Record<TrackTheme, { rock: number; high: number; low: number; deep: number }> = {
  grassland: { rock: 0x6b5a3e, high: 0x9ab85a, low: 0x3f7a2a, deep: 0x1d3a5a },
  desert: { rock: 0x8a4f2a, high: 0xe8b877, low: 0xb9823f, deep: 0x1d3a5a },
  beach: { rock: 0xa8895f, high: 0xf2ddb0, low: 0xd8bd85, deep: 0x11618f },
  snow: { rock: 0x6f7b8a, high: 0xffffff, low: 0xd6e6f5, deep: 0x0a3049 },
  volcano: { rock: 0x2f2429, high: 0x6b4636, low: 0x2b1e1a, deep: 0xd8340a },
  neon: { rock: 0x15131d, high: 0x1a1826, low: 0x0a0912, deep: 0x1d3a5a },
};

/** Distant hill ring colours: `peak` above the snow/ash line, `mid` below it. */
const MOUNTAIN_COLORS: Record<TrackTheme, { peak: number; mid: number }> = {
  grassland: { peak: 0x5b7d9c, mid: 0x4f7a58 },
  desert: { peak: 0xb06a3f, mid: 0xd08b58 },
  beach: { peak: 0x8fb6c9, mid: 0xbfa176 },
  snow: { peak: 0xffffff, mid: 0x9fb8d2 },
  volcano: { peak: 0x1c1216, mid: 0x4a2a22 },
  neon: { peak: 0x1c1230, mid: 0x0e0818 },
};

/** Large displaced ground plane with theme vertex colours. */
export function buildTerrain(ctx: BuildContext): THREE.Mesh {
  const { def, field } = ctx;
  const theme = def.theme;
  const geo = new THREE.PlaneGeometry(TERRAIN_EXTENT, TERRAIN_EXTENT, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;

  const ground = color(def.palette.ground);
  const c = new THREE.Color();
  const tmp = new THREE.Color();
  const ramp = TERRAIN_COLORS[theme] ?? TERRAIN_COLORS.grassland;
  const rock = color(ramp.rock);
  const high = color(ramp.high);
  const low = color(ramp.low);
  const water = color(ramp.deep);
  const roadBand = theme === 'neon' ? color(0x1c1a28) : theme === 'snow' ? color(0xf2f7fc) : color(def.palette.offroad);

  const roadYMin = ctx.cl.minY;
  // Displace first, then derive slope from the recomputed normals (cheaper than extra height taps).
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i) + field.centerX;
    const z = pos.getZ(i) + field.centerZ;
    const h = field.heightAt(x, z);
    pos.setXYZ(i, x, h, z);
    uv.setXY(i, x / 6, z / 6);
  }
  geo.computeVertexNormals();
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = pos.getY(i);
    const slope = clamp01((1 - nrm.getY(i)) * 2.2);
    const n = fbm2(x * 0.015 + 3.3, z * 0.015 + 8.8, 3);
    field.sampleField(x, z);
    const nearRoad = 1 - smoothstep(ctx.cl.maxWallHalfWidth + 2, ctx.cl.maxWallHalfWidth + 18, field.fDist);

    // height-based blend relative to the road elevation band
    const rel = clamp01((h - roadYMin + 6) / 40);
    c.copy(low).lerp(high, rel);
    c.lerp(ground, 0.35);
    tmp.copy(c).offsetHSL(0, 0, (n - 0.5) * 0.12);
    c.copy(tmp);
    c.lerp(rock, slope * (theme === 'desert' ? 0.7 : 0.85));
    c.lerp(roadBand, nearRoad * 0.55);
    if (theme === 'snow' || theme === 'volcano' || theme === 'beach') {
      // Anything well below the road is the basin floor: frozen lake, lava, or sea.
      const depthBelowRoad = roadYMin - h;
      const wet = smoothstep(VOID_BASIN_DEPTH * 0.4, VOID_BASIN_DEPTH * 0.75, depthBelowRoad);
      c.lerp(water, wet);
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();

  const tex = makeGroundTexture(theme, 0xffffff);
  track(ctx, tex);
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: tex,
    roughness: 1,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  trackMesh(ctx, mesh);
  return mesh;
}

/** Low-poly ring of distant hills / mountains (or a skyline for the neon city). */
export function buildMountains(ctx: BuildContext): THREE.Mesh {
  const { def, field } = ctx;
  const theme = def.theme;
  const rings = [
    { radius: 560, hMin: 30, hMax: 95, seg: 96, tint: 0.55 },
    { radius: 700, hMin: 60, hMax: 170, seg: 80, tint: 1 },
  ];
  const verts: number[] = [];
  const cols: number[] = [];
  const idx: number[] = [];
  const base = color(def.environment.fogColor);
  const hills = MOUNTAIN_COLORS[theme] ?? MOUNTAIN_COLORS.grassland;
  const peak = color(hills.peak);
  const mid = color(hills.mid);
  const c = new THREE.Color();
  let vbase = 0;
  for (const ring of rings) {
    const seg = ring.seg;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const nz = fbm2(Math.cos(a) * 3 + ring.radius * 0.01, Math.sin(a) * 3, 3);
      let h = lerp(ring.hMin, ring.hMax, nz);
      if (theme === 'neon') {
        // skyline: flat-topped blocks
        h = Math.round(h / 12) * 12 + (i % 2 === 0 ? 10 : 0);
      } else {
        h *= 0.8 + 0.4 * fbm2(a * 6.3, ring.radius, 2);
      }
      const r = ring.radius * (0.96 + 0.08 * fbm2(a * 2, 5, 2));
      const x = field.centerX + Math.cos(a) * r;
      const z = field.centerZ + Math.sin(a) * r;
      // bottom
      verts.push(x, -40, z);
      c.copy(base).lerp(mid, 0.3 * ring.tint);
      cols.push(c.r, c.g, c.b);
      // top
      verts.push(x, h, z);
      const snowLine = theme === 'snow' ? 0.35 : theme === 'grassland' ? 0.8 : theme === 'volcano' ? 0.6 : 1.1;
      const k = clamp01(h / ring.hMax);
      c.copy(mid).lerp(peak, smoothstep(snowLine - 0.3, snowLine + 0.2, k));
      c.lerp(base, 0.25 * (1.2 - ring.tint));
      cols.push(c.r, c.g, c.b);
    }
    for (let i = 0; i < seg; i++) {
      const a = vbase + i * 2;
      const b = a + 1;
      const d = a + 2;
      const e = a + 3;
      // inward facing (camera is inside the ring)
      idx.push(a, d, b, b, d, e);
    }
    vbase += (seg + 1) * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'mountains';
  trackMesh(ctx, mesh);
  return mesh;
}
