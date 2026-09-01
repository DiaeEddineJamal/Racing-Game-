import * as THREE from 'three';
import type { BuildContext } from './context';
import { trackMesh } from './context';
import { mergeParts, scatter } from './decor';
import { lerp } from '../../core/math';

/** Per-theme animated set pieces: windmill, hot-air balloons, aurora, searchlights. */
export function buildAnimatedProps(ctx: BuildContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'animated';
  const theme = ctx.def.theme;
  switch (theme) {
    case 'grassland':
    case 'beach':
      addWindmill(ctx, group, 0xf3f0e6, 0x8b5a2b);
      addBalloons(ctx, group, 2, [0xff4d4d, 0xffd84d, 0x4da6ff]);
      break;
    case 'desert':
    case 'volcano':
      addWindmill(ctx, group, 0xb9b9c4, 0x5a5a66);
      addBalloons(ctx, group, 2, [0xff8a3a, 0xffe27a, 0xc84a2a]);
      break;
    case 'snow':
      addAurora(ctx, group);
      addBalloons(ctx, group, 1, [0x4da6ff, 0xffffff, 0xff4d4d]);
      break;
    case 'neon':
      addSearchlights(ctx, group);
      break;
  }
  return group;
}

/** Pick a spot near (but off) the track, roughly at track parameter t. */
function spotNear(ctx: BuildContext, t: number, lateralDist: number, side: number): THREE.Vector3 {
  const cl = ctx.cl;
  const i = Math.floor(((t % 1) + 1) % 1 * cl.n) % cl.n;
  const lat = side * (cl.whw[i] + lateralDist);
  const x = cl.px[i] + cl.bx[i] * lat;
  const z = cl.pz[i] + cl.bz[i] * lat;
  return new THREE.Vector3(x, ctx.field.heightAt(x, z), z);
}

function addWindmill(ctx: BuildContext, group: THREE.Group, bodyColor: number, roofColor: number): void {
  const pos = spotNear(ctx, 0.5, 14, ctx.rng() < 0.5 ? -1 : 1);
  const tower = new THREE.CylinderGeometry(1.6, 2.4, 9, 10);
  tower.translate(0, 4.5, 0);
  const roof = new THREE.ConeGeometry(2.0, 1.8, 10);
  roof.translate(0, 9.9, 0);
  const door = new THREE.BoxGeometry(0.9, 1.6, 0.3);
  door.translate(0, 0.8, 2.3);
  const axle = new THREE.CylinderGeometry(0.25, 0.25, 1.6, 8);
  axle.rotateX(Math.PI / 2);
  axle.translate(0, 8.4, 2.4);
  const bodyGeo = mergeParts([
    { geo: tower, color: bodyColor },
    { geo: roof, color: roofColor },
    { geo: door, color: 0x5a3a20 },
    { geo: axle, color: 0x333333 },
  ]);
  const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
  body.castShadow = true;
  body.receiveShadow = true;
  body.position.copy(pos);
  trackMesh(ctx, body);
  group.add(body);

  // blades
  const bladeParts: { geo: THREE.BufferGeometry; color: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.BoxGeometry(0.18, 4.6, 0.12);
    arm.translate(0, 2.3, 0);
    const sail = new THREE.PlaneGeometry(1.1, 3.6);
    sail.translate(0.62, 2.7, 0.08);
    arm.rotateZ((i / 4) * Math.PI * 2);
    sail.rotateZ((i / 4) * Math.PI * 2);
    bladeParts.push({ geo: arm, color: 0x5a3a20 }, { geo: sail, color: 0xfff4e0 });
  }
  const hub = new THREE.SphereGeometry(0.45, 8, 6);
  bladeParts.push({ geo: hub, color: 0x333333 });
  const bladeGeo = mergeParts(bladeParts);
  const blades = new THREE.Mesh(bladeGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
  blades.castShadow = true;
  blades.position.set(pos.x, pos.y + 8.4, pos.z + 3.25);
  trackMesh(ctx, blades);
  group.add(blades);
  ctx.updaters.push((dt) => {
    blades.rotation.z -= dt * 0.9;
  });
}

function addBalloons(ctx: BuildContext, group: THREE.Group, count: number, colors: number[]): void {
  const rng = ctx.rng;
  for (let b = 0; b < count; b++) {
    const env = new THREE.SphereGeometry(4.2, 18, 12);
    env.scale(1, 1.15, 1);
    // stripe the envelope by longitude via vertex colours
    const pos = env.getAttribute('position') as THREE.BufferAttribute;
    const cols = new Float32Array(pos.count * 3);
    const cA = new THREE.Color(colors[b % colors.length]);
    const cB = new THREE.Color(colors[(b + 1) % colors.length]);
    const cC = new THREE.Color(colors[(b + 2) % colors.length]);
    for (let i = 0; i < pos.count; i++) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      const k = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12) % 3;
      const c = k === 0 ? cA : k === 1 ? cB : cC;
      cols[i * 3] = c.r;
      cols[i * 3 + 1] = c.g;
      cols[i * 3 + 2] = c.b;
    }
    env.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    env.translate(0, 6.5, 0);
    const skirt = new THREE.ConeGeometry(2.2, 2.6, 12, 1, true);
    skirt.rotateX(Math.PI);
    skirt.translate(0, 1.6, 0);
    const basket = new THREE.BoxGeometry(1.6, 1.2, 1.6);
    basket.translate(0, -0.6, 0);
    const ropes: { geo: THREE.BufferGeometry; color: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const rope = new THREE.CylinderGeometry(0.03, 0.03, 2.6, 4);
      rope.translate(i < 2 ? -0.7 : 0.7, 1.1, i % 2 === 0 ? -0.7 : 0.7);
      ropes.push({ geo: rope, color: 0x3a2a1a });
    }
    const geo = mergeParts([
      { geo: env, color: 0xffffff, keepColor: true },
      { geo: skirt, color: 0x333333 },
      { geo: basket, color: 0x8a5a2b },
      ...ropes,
    ]);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }));
    mesh.castShadow = true;
    trackMesh(ctx, mesh);
    group.add(mesh);
    const center = new THREE.Vector3(ctx.field.centerX + (rng() - 0.5) * 200, 0, ctx.field.centerZ + (rng() - 0.5) * 200);
    const radius = lerp(50, 110, rng());
    const height = lerp(38, 60, rng());
    const speed = lerp(0.03, 0.05, rng()) * (rng() < 0.5 ? 1 : -1);
    const phase = rng() * Math.PI * 2;
    ctx.updaters.push((_dt, elapsed) => {
      const a = phase + elapsed * speed;
      mesh.position.set(center.x + Math.cos(a) * radius, height + Math.sin(elapsed * 0.4 + phase) * 2.5, center.z + Math.sin(a) * radius);
      mesh.rotation.y = elapsed * 0.05 + phase;
    });
  }
}

const AURORA_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const AURORA_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec2 vUv;
float hash(float n) { return fract(sin(n) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash(i.x + i.y * 57.0), b = hash(i.x + 1.0 + i.y * 57.0), c = hash(i.x + (i.y + 1.0) * 57.0), d = hash(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  float x = vUv.x * 6.0;
  float t = uTime * 0.12;
  float curtain = noise(vec2(x * 1.5 + t, t * 0.6)) * 0.6 + noise(vec2(x * 4.0 - t * 1.3, 2.0 + t)) * 0.4;
  float band = smoothstep(0.25, 0.75, curtain);
  float v = vUv.y;
  float vertical = smoothstep(0.0, 0.25, v) * (1.0 - smoothstep(0.55, 1.0, v));
  float rays = 0.6 + 0.4 * noise(vec2(x * 12.0 + t * 3.0, v * 3.0));
  float alpha = band * vertical * rays * 0.75;
  vec3 col = mix(uColorA, uColorB, smoothstep(0.1, 0.8, v + 0.2 * noise(vec2(x, t))));
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

function addAurora(ctx: BuildContext, group: THREE.Group): void {
  const cx = ctx.field.centerX;
  const cz = ctx.field.centerZ;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: ctx.timeUniform,
      uColorA: { value: new THREE.Color(0x27f0a0) },
      uColorB: { value: new THREE.Color(0x7a4dff) },
    },
    vertexShader: AURORA_VERT,
    fragmentShader: AURORA_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  ctx.disposables.push(mat);
  const geo = new THREE.PlaneGeometry(520, 110, 1, 1);
  ctx.disposables.push(geo);
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i - 1) * 0.9 + 0.3;
    const r = 520 + i * 60;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx + Math.cos(a) * r, 150 + i * 25, cz + Math.sin(a) * r);
    mesh.lookAt(cx, 120, cz);
    mesh.frustumCulled = false;
    mesh.renderOrder = -500;
    mesh.name = 'aurora';
    group.add(mesh);
  }
}

function addSearchlights(ctx: BuildContext, group: THREE.Group): void {
  const pts = scatter(ctx, 4, 20, 140);
  const geo = new THREE.CylinderGeometry(9, 0.6, 160, 12, 1, true);
  geo.translate(0, 80, 0);
  ctx.disposables.push(geo);
  const cols = [0x64f0ff, 0xff5ee6, 0xffffff, 0xa06bff];
  pts.forEach((p, i) => {
    const mat = new THREE.MeshBasicMaterial({
      color: cols[i % cols.length],
      transparent: true,
      opacity: 0.09,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    ctx.disposables.push(mat);
    const pivot = new THREE.Group();
    pivot.position.set(p.x, p.y, p.z);
    const beam = new THREE.Mesh(geo, mat);
    beam.rotation.x = 0.55;
    beam.frustumCulled = false;
    pivot.add(beam);
    group.add(pivot);
    const speed = (0.25 + ctx.rng() * 0.2) * (i % 2 === 0 ? 1 : -1);
    ctx.updaters.push((_dt, elapsed) => {
      pivot.rotation.y = elapsed * speed + i;
      beam.rotation.x = 0.45 + Math.sin(elapsed * 0.7 + i) * 0.2;
    });
  });
}
