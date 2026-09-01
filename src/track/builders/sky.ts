import * as THREE from 'three';
import type { BuildContext } from './context';
import { trackMesh } from './context';

export const SKY_RADIUS = 1500;

const SKY_VERT = /* glsl */ `
varying vec3 vWorldDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldDir = wp.xyz - cameraPosition;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Force the dome onto the far plane so it is never clipped by the camera far distance.
  clip.z = clip.w * 0.999999;
  gl_Position = clip;
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunSize;
uniform float uSunGlow;
uniform float uNight;
varying vec3 vWorldDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

void main() {
  vec3 d = normalize(vWorldDir);
  float y = d.y;
  vec3 col;
  if (y >= 0.0) {
    float k = pow(clamp(y, 0.0, 1.0), 0.55);
    col = mix(uHorizon, uTop, k);
  } else {
    float k = pow(clamp(-y, 0.0, 1.0), 0.6);
    col = mix(uHorizon, uBottom, k);
  }
  // horizon glow band
  col += uHorizon * exp(-abs(y) * 9.0) * 0.18;

  // sun / moon disc with halo
  float sd = dot(d, uSunDir);
  float disc = smoothstep(uSunSize - 0.0012, uSunSize + 0.0004, sd);
  col += uSunColor * disc * (2.2 - uNight * 1.2);
  col += uSunColor * pow(max(sd, 0.0), 90.0) * 0.55 * uSunGlow;
  col += uSunColor * pow(max(sd, 0.0), 6.0) * 0.14 * uSunGlow;

  // procedural stars (night only)
  if (uNight > 0.5) {
    vec2 sph = vec2(atan(d.z, d.x), asin(clamp(y, -1.0, 1.0)));
    vec2 g = sph * 95.0;
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float h = hash(cell);
    float h2 = hash(cell + 17.0);
    vec2 sp = vec2(hash(cell + 3.1), hash(cell + 7.7)) * 0.7 + 0.15;
    float dist = length(f - sp);
    float star = smoothstep(0.13, 0.0, dist) * step(0.74, h) * (0.4 + 0.6 * h2);
    star *= smoothstep(0.0, 0.25, y);
    col += vec3(0.75 + 0.25 * h2, 0.82, 1.0) * star * 1.6;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Gradient sky dome with analytic sun (day) or moon + procedural stars (night). Drawn first, never fogged. */
export function buildSky(ctx: BuildContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'sky';
  const env = ctx.def.environment;
  const theme = ctx.def.theme;
  const isNight = theme === 'neon';
  const cx = ctx.field.centerX;
  const cz = ctx.field.centerZ;

  const sunDir = new THREE.Vector3(env.sunDirection.x, env.sunDirection.y, env.sunDirection.z).normalize();
  const angularRadiusDeg = isNight ? 1.7 : theme === 'desert' ? 4.2 : 2.6;

  const geo = new THREE.SphereGeometry(SKY_RADIUS, 40, 20);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(env.skyTop) },
      uHorizon: { value: new THREE.Color(env.skyHorizon) },
      uBottom: { value: new THREE.Color(env.skyBottom) },
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(env.sunColor) },
      uSunSize: { value: Math.cos(THREE.MathUtils.degToRad(angularRadiusDeg)) },
      uSunGlow: { value: isNight ? 0.5 : theme === 'desert' ? 1.6 : 1.0 },
      uNight: { value: isNight ? 1 : 0 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.position.set(cx, 0, cz);
  dome.renderOrder = -1000;
  dome.frustumCulled = false;
  dome.name = 'skyDome';
  trackMesh(ctx, dome);
  group.add(dome);
  return group;
}
