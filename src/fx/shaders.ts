/**
 * GLSL sources for the FX workstream: GPU particle shaders and the full-screen
 * composite post-process pass. Everything is procedural (no textures except the
 * runtime-generated sprite atlas).
 */

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

export const PARTICLE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uGravity;
uniform float uHeightPx;
uniform float uAspect;

attribute vec3 aVelocity;
attribute vec2 aTime;   // birth, life
attribute vec2 aSize;   // start, end (world metres)
attribute vec3 aColor0;
attribute vec3 aColor1;
attribute vec2 aAlpha;  // start, end
attribute vec2 aRot;    // rotation, angular velocity
attribute vec4 aMisc;   // gravityScale, atlasIndex, alignToVelocity, drag

varying vec4 vColor;
varying float vRot;
varying float vAtlas;

void main() {
  float age = uTime - aTime.x;
  float life = max(aTime.y, 0.0001);
  float t = age / life;
  if (age < 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec4(0.0);
    vRot = 0.0;
    vAtlas = 0.0;
    return;
  }

  float k = aMisc.w;
  // Ballistic motion with optional exponential drag: integral of v*exp(-k t).
  float tt = k > 0.001 ? (1.0 - exp(-k * age)) / k : age;
  float g = uGravity * aMisc.x;
  vec3 pos = position + aVelocity * tt;
  pos.y -= 0.5 * g * age * age;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float size = mix(aSize.x, aSize.y, t);
  float px = size * projectionMatrix[1][1] * uHeightPx * 0.5 / max(0.05, -mv.z);
  gl_PointSize = clamp(px, 0.0, 512.0);

  float fadeIn = smoothstep(0.0, 0.06, t);
  float fadeOut = 1.0 - smoothstep(0.7, 1.0, t);
  float alpha = mix(aAlpha.x, aAlpha.y, t) * fadeIn * fadeOut;
  vColor = vec4(mix(aColor0, aColor1, t), alpha);

  float rot = aRot.x + aRot.y * age;
  if (aMisc.z > 0.5) {
    // Align the sprite's x axis to the screen-space velocity direction.
    vec3 vel = aVelocity * exp(-k * age);
    vel.y -= g * age;
    vec4 c1 = projectionMatrix * (modelViewMatrix * vec4(pos + vel * 0.02, 1.0));
    vec2 d = c1.xy / c1.w - gl_Position.xy / gl_Position.w;
    d.x *= uAspect;
    if (dot(d, d) > 1e-12) rot = atan(d.y, d.x);
  }
  vRot = rot;
  vAtlas = aMisc.y;
}
`;

export const PARTICLE_FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;

varying vec4 vColor;
varying float vRot;
varying float vAtlas;

void main() {
  if (vColor.a <= 0.001) discard;
  vec2 p = gl_PointCoord - 0.5;
  p.y = -p.y;
  float c = cos(vRot);
  float s = sin(vRot);
  vec2 uv = vec2(c * p.x + s * p.y, -s * p.x + c * p.y) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  uv = clamp(uv, 0.008, 0.992);
  float col = mod(vAtlas, 4.0);
  float row = floor(vAtlas / 4.0);
  vec2 auv = vec2((col + uv.x) * 0.25, 1.0 - (row + 1.0 - uv.y) * 0.25);
  vec4 tex = texture2D(uAtlas, auv);
  float a = tex.a * vColor.a;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vColor.rgb * tex.rgb, a);
}
`;

// ---------------------------------------------------------------------------
// Composite post-process (speed lines, radial blur, chromatic aberration,
// vignette + hit tint, flash, grain). Runs on the linear HDR buffer before
// OutputPass applies tone mapping and the sRGB transfer.
// ---------------------------------------------------------------------------

export const COMPOSITE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uTime;
uniform float uSpeed;
uniform float uBoost;
uniform float uHit;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uGrain;

varying vec2 vUv;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Thin radial streaks in randomly chosen angular sectors, dashed segments
// racing outward from the centre. Returns 0..1 intensity.
float speedLines(vec2 adir, float r, float t) {
  float a = atan(adir.y, adir.x);
  const float SECTORS = 120.0;
  float sa = (a + 3.14159265) / 6.2831853 * SECTORS;
  float id = floor(sa);
  float fr = fract(sa);
  float rnd = hash11(id * 0.731 + 0.13);
  float rnd2 = hash11(id * 1.317 + 7.7);
  float w = 0.02 + 0.035 * rnd2;
  float line = 1.0 - smoothstep(0.0, w, abs(fr - 0.5));
  float speed = 2.5 + 2.5 * rnd2;
  float seg = fract(r * (2.0 + 2.0 * rnd) - t * speed + rnd * 13.0);
  float dash = smoothstep(0.3, 0.6, seg) * (1.0 - smoothstep(0.7, 1.0, seg));
  float mask = smoothstep(0.42, 0.9, r);
  float on = step(0.55, rnd);
  return line * dash * mask * on;
}

void main() {
  vec2 uv = vUv;
  vec2 dir = uv - 0.5;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 adir = vec2(dir.x * aspect, dir.y);
  float r = length(adir);
  float rn = length(dir) * 1.4142136;

  vec3 col;
  float boost = uBoost;
  // Radial blur + chromatic aberration only kick in past a moderate boost so a
  // light drift turbo doesn't smear the picture.
  float smear = smoothstep(0.25, 1.0, boost);
  if (smear > 0.003) {
    vec2 dn = dir / max(length(dir), 1e-4);
    float ca = smear * 0.0035 * rn * rn;
    float blur = smear * 0.016 * rn * rn;
    col = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      float f = (float(i) / 4.0 - 0.5) * blur;
      vec2 o = uv - dir * f;
      col.r += texture2D(tDiffuse, o - dn * ca).r;
      col.g += texture2D(tDiffuse, o).g;
      col.b += texture2D(tDiffuse, o + dn * ca).b;
    }
    col *= 0.2;
  } else {
    col = texture2D(tDiffuse, uv).rgb;
  }

  // Speed lines: none until the kart is well past cruising speed, thin and
  // low-alpha even at full boost.
  float slAmt = smoothstep(0.6, 1.0, uSpeed) * 0.08 + boost * 0.16;
  if (slAmt > 0.002) {
    float sl = speedLines(adir, r, uTime);
    col += vec3(sl * slAmt) * vec3(0.95, 0.97, 1.05);
  }

  // Light vignette: untouched inside ~55% radius, ~15% darker in the corners.
  float vig = smoothstep(1.25, 0.55, rn * (1.0 + 0.08 * uSpeed));
  col *= mix(1.0, vig, 0.22 + 0.16 * uSpeed);

  if (uHit > 0.001) {
    float pulse = 0.8 + 0.2 * sin(uTime * 28.0);
    float edge = smoothstep(0.35, 1.0, rn);
    float hitMask = clamp(uHit * pulse * (0.2 + edge) * 1.0, 0.0, 0.8);
    col = mix(col, vec3(0.55, 0.02, 0.01), hitMask);
    float lum0 = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(lum0), uHit * 0.35);
  }

  col = mix(col, uFlashColor * 1.8, clamp(uFlash, 0.0, 1.0));

  // Fine grain (uGrain is a linear-light amplitude; ~1% at rest).
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  float gr = hash21(uv * uResolution + fract(uTime * 7.31) * 100.0) - 0.5;
  col += gr * uGrain * (0.4 + 0.6 * (1.0 - clamp(lum, 0.0, 1.0)));

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;
