import * as THREE from 'three';
import type { BuildContext } from './context';
import { color, track, trackMesh } from './context';
import { makeGroundTexture } from '../textures';
import { TERRAIN_EXTENT, VOID_BASIN_DEPTH } from '../TerrainField';
import { fbm2, smoothstep, clamp01, lerp } from '../../core/math';

const TERRAIN_SEGMENTS = 240;

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
  const rock = theme === 'snow' ? color(0x6f7b8a) : theme === 'desert' ? color(0x8a4f2a) : theme === 'neon' ? color(0x15131d) : color(0x6b5a3e);
  const high = theme === 'snow' ? color(0xffffff) : theme === 'desert' ? color(0xe8b877) : theme === 'neon' ? color(0x1a1826) : color(0x9ab85a);
  const low = theme === 'snow' ? color(0xd6e6f5) : theme === 'desert' ? color(0xb9823f) : theme === 'neon' ? color(0x0a0912) : color(0x3f7a2a);
  const water = theme === 'snow' ? color(0x0a3049) : color(0x1d3a5a);
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
    if (theme === 'snow') {
      // deep basin = frozen water; snow stays bright on the flats
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
  const peak =
    theme === 'snow'
      ? color(0xffffff)
      : theme === 'desert'
        ? color(0xb06a3f)
        : theme === 'neon'
          ? color(0x1c1230)
          : color(0x5b7d9c);
  const mid = theme === 'snow' ? color(0x9fb8d2) : theme === 'desert' ? color(0xd08b58) : theme === 'neon' ? color(0x0e0818) : color(0x4f7a58);
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
      const snowLine = theme === 'snow' ? 0.35 : theme === 'grassland' ? 0.8 : 1.1;
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
