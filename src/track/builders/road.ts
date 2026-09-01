import * as THREE from 'three';
import type { BuildContext } from './context';
import { track, trackMesh } from './context';
import { makeRoadTextures, makeGroundTexture, makeCheckerTexture, ROAD_TILE_LENGTH } from '../textures';

/** Height of the curb top above the road surface. */
const CURB_HEIGHT = 0.1;
/** Width of the striped curb strip. */
export const CURB_WIDTH = 1.0;

/**
 * Road ribbon + curbs + off-road shoulder + painted start/finish line.
 * All built from the centerline LUT; the road is flat across its width.
 */
export function buildRoad(ctx: BuildContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'road';
  const { cl, def } = ctx;
  const n = cl.n;
  const theme = def.theme;

  // ---------------------------------------------------------------- road ribbon
  const tiles = Math.max(1, Math.round(cl.length / ROAD_TILE_LENGTH));
  const vScale = tiles / cl.length;
  {
    const verts = new Float32Array((n + 1) * 2 * 3);
    const norms = new Float32Array((n + 1) * 2 * 3);
    const uvs = new Float32Array((n + 1) * 2 * 2);
    const idx = new Uint32Array(n * 6);
    for (let k = 0; k <= n; k++) {
      const i = k % n;
      const s = (k / n) * cl.length;
      const hw = cl.hw[i];
      const px = cl.px[i];
      const py = cl.py[i];
      const pz = cl.pz[i];
      const bx = cl.bx[i];
      const bz = cl.bz[i];
      // normal = binormal x tangent
      const tx = cl.tx[i];
      const ty = cl.ty[i];
      const tz = cl.tz[i];
      let nx = -bz * ty;
      let ny = bz * tx - bx * tz;
      let nz = bx * ty;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const o = k * 6;
      verts[o] = px - bx * hw;
      verts[o + 1] = py;
      verts[o + 2] = pz - bz * hw;
      verts[o + 3] = px + bx * hw;
      verts[o + 4] = py;
      verts[o + 5] = pz + bz * hw;
      norms[o] = nx;
      norms[o + 1] = ny;
      norms[o + 2] = nz;
      norms[o + 3] = nx;
      norms[o + 4] = ny;
      norms[o + 5] = nz;
      const v = s * vScale;
      uvs[k * 4] = 0;
      uvs[k * 4 + 1] = v;
      uvs[k * 4 + 2] = 1;
      uvs[k * 4 + 3] = v;
    }
    for (let k = 0; k < n; k++) {
      const a = k * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      const o = k * 6;
      idx[o] = a;
      idx[o + 1] = b;
      idx[o + 2] = c;
      idx[o + 3] = b;
      idx[o + 4] = d;
      idx[o + 5] = c;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();

    const tex = makeRoadTextures(def);
    track(ctx, tex.map);
    if (tex.emissiveMap) track(ctx, tex.emissiveMap);
    const mat = new THREE.MeshStandardMaterial({
      map: tex.map,
      roughness: theme === 'snow' ? 0.35 : theme === 'neon' ? 0.55 : 0.92,
      metalness: theme === 'snow' ? 0.1 : 0.0,
      emissive: tex.emissiveMap ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
      emissiveMap: tex.emissiveMap ?? null,
      emissiveIntensity: tex.emissiveMap ? 1.6 : 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'roadSurface';
    mesh.receiveShadow = true;
    trackMesh(ctx, mesh);
    group.add(mesh);
  }

  // ---------------------------------------------------------------- curbs (both edges)
  {
    // 3 verts per side per sample: inner (road level), outer top, outer bottom.
    const perSide = (n + 1) * 3;
    const verts = new Float32Array(perSide * 2 * 3);
    const uvs = new Float32Array(perSide * 2 * 2);
    const idx = new Uint32Array(n * 2 * 12);
    let ii = 0;
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? -1 : 1;
      const base = side * perSide;
      for (let k = 0; k <= n; k++) {
        const i = k % n;
        const s = (k / n) * cl.length;
        const hw = cl.hw[i];
        const px = cl.px[i];
        const py = cl.py[i];
        const pz = cl.pz[i];
        const bx = cl.bx[i] * sgn;
        const bz = cl.bz[i] * sgn;
        const vi = base + k * 3;
        // inner
        verts[vi * 3] = px + bx * hw;
        verts[vi * 3 + 1] = py + 0.03;
        verts[vi * 3 + 2] = pz + bz * hw;
        // outer top
        verts[(vi + 1) * 3] = px + bx * (hw + CURB_WIDTH);
        verts[(vi + 1) * 3 + 1] = py + CURB_HEIGHT;
        verts[(vi + 1) * 3 + 2] = pz + bz * (hw + CURB_WIDTH);
        // outer bottom
        verts[(vi + 2) * 3] = px + bx * (hw + CURB_WIDTH + 0.05);
        verts[(vi + 2) * 3 + 1] = py - 0.02;
        verts[(vi + 2) * 3 + 2] = pz + bz * (hw + CURB_WIDTH + 0.05);
        const v = s / 5; // one stripe pair per 5 m
        uvs[vi * 2] = 0;
        uvs[vi * 2 + 1] = v;
        uvs[(vi + 1) * 2] = 0.5;
        uvs[(vi + 1) * 2 + 1] = v;
        uvs[(vi + 2) * 2] = 0.5;
        uvs[(vi + 2) * 2 + 1] = v;
      }
      for (let k = 0; k < n; k++) {
        const a = base + k * 3;
        const b = a + 3;
        // quad inner->outerTop, then outerTop->outerBottom (winding keeps normals up/outward)
        if (sgn > 0) {
          idx[ii++] = a;
          idx[ii++] = a + 1;
          idx[ii++] = b;
          idx[ii++] = a + 1;
          idx[ii++] = b + 1;
          idx[ii++] = b;
          idx[ii++] = a + 1;
          idx[ii++] = a + 2;
          idx[ii++] = b + 1;
          idx[ii++] = a + 2;
          idx[ii++] = b + 2;
          idx[ii++] = b + 1;
        } else {
          idx[ii++] = a;
          idx[ii++] = b;
          idx[ii++] = a + 1;
          idx[ii++] = a + 1;
          idx[ii++] = b;
          idx[ii++] = b + 1;
          idx[ii++] = a + 1;
          idx[ii++] = b + 1;
          idx[ii++] = a + 2;
          idx[ii++] = a + 2;
          idx[ii++] = b + 1;
          idx[ii++] = b + 2;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const stripes = makeStripeTexture(def.palette.curb, def.palette.curbAlt);
    track(ctx, stripes);
    const mat = new THREE.MeshStandardMaterial({
      map: stripes,
      roughness: 0.7,
      metalness: 0,
      emissive: theme === 'neon' ? new THREE.Color(0xffffff) : new THREE.Color(0),
      emissiveMap: theme === 'neon' ? stripes : null,
      emissiveIntensity: theme === 'neon' ? 0.9 : 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'curbs';
    mesh.receiveShadow = true;
    trackMesh(ctx, mesh);
    group.add(mesh);
  }

  // ---------------------------------------------------------------- shoulder (curb -> wall line)
  {
    const perSide = (n + 1) * 2;
    const verts = new Float32Array(perSide * 2 * 3);
    const uvs = new Float32Array(perSide * 2 * 2);
    const idx = new Uint32Array(n * 2 * 6);
    let ii = 0;
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? -1 : 1;
      const base = side * perSide;
      for (let k = 0; k <= n; k++) {
        const i = k % n;
        const s = (k / n) * cl.length;
        const hw = cl.hw[i] + CURB_WIDTH;
        const whw = cl.whw[i] + 0.9;
        const px = cl.px[i];
        const py = cl.py[i];
        const pz = cl.pz[i];
        const bx = cl.bx[i] * sgn;
        const bz = cl.bz[i] * sgn;
        const vi = base + k * 2;
        verts[vi * 3] = px + bx * hw;
        verts[vi * 3 + 1] = py - 0.02;
        verts[vi * 3 + 2] = pz + bz * hw;
        verts[(vi + 1) * 3] = px + bx * whw;
        verts[(vi + 1) * 3 + 1] = py - 0.02;
        verts[(vi + 1) * 3 + 2] = pz + bz * whw;
        uvs[vi * 2] = (hw * sgn) / 4;
        uvs[vi * 2 + 1] = s / 4;
        uvs[(vi + 1) * 2] = (whw * sgn) / 4;
        uvs[(vi + 1) * 2 + 1] = s / 4;
      }
      for (let k = 0; k < n; k++) {
        const a = base + k * 2;
        const b = a + 2;
        if (sgn > 0) {
          idx[ii++] = a;
          idx[ii++] = a + 1;
          idx[ii++] = b;
          idx[ii++] = a + 1;
          idx[ii++] = b + 1;
          idx[ii++] = b;
        } else {
          idx[ii++] = a;
          idx[ii++] = b;
          idx[ii++] = a + 1;
          idx[ii++] = a + 1;
          idx[ii++] = b;
          idx[ii++] = b + 1;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const tex = makeGroundTexture(theme, def.palette.offroad);
    track(ctx, tex);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 1,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'shoulder';
    mesh.receiveShadow = true;
    trackMesh(ctx, mesh);
    group.add(mesh);
  }

  // ---------------------------------------------------------------- start / finish line
  {
    const halfLen = 1.6;
    const i0 = 0;
    const hw = cl.hw[i0];
    const px = cl.px[i0];
    const py = cl.py[i0];
    const pz = cl.pz[i0];
    const bx = cl.bx[i0];
    const bz = cl.bz[i0];
    const tx = cl.tx[i0];
    const tz = cl.tz[i0];
    const th = Math.hypot(tx, tz) || 1;
    const fx = tx / th;
    const fz = tz / th;
    const geo = new THREE.BufferGeometry();
    const verts = new Float32Array([
      px - bx * hw - fx * halfLen, py + 0.035, pz - bz * hw - fz * halfLen,
      px + bx * hw - fx * halfLen, py + 0.035, pz + bz * hw - fz * halfLen,
      px - bx * hw + fx * halfLen, py + 0.035, pz - bz * hw + fz * halfLen,
      px + bx * hw + fx * halfLen, py + 0.035, pz + bz * hw + fz * halfLen,
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
    geo.setIndex([0, 1, 2, 1, 3, 2]);
    geo.computeVertexNormals();
    const tex = makeCheckerTexture(12, 2);
    track(ctx, tex);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.8,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'startLine';
    mesh.receiveShadow = true;
    trackMesh(ctx, mesh);
    group.add(mesh);
  }

  return group;
}

/** Two-colour stripe texture: v in [0,0.5) colour A, [0.5,1) colour B. Crisp (nearest filtering). */
function makeStripeTexture(a: number, b: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#' + a.toString(16).padStart(6, '0');
    ctx.fillRect(0, 0, 8, 32);
    ctx.fillStyle = '#' + b.toString(16).padStart(6, '0');
    ctx.fillRect(0, 32, 8, 32);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
