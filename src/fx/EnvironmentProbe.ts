/**
 * A cheap image-based lighting probe built from the circuit's own sky colours.
 *
 * The karts are clearcoated physical materials, which without an environment
 * map have nothing to reflect and read as flat plastic. Rather than pay for a
 * cube-camera render, this paints a small equirectangular gradient - sky, sun,
 * horizon haze and ground bounce, straight out of EnvironmentDef - and hands it
 * to PMREMGenerator. Bodywork picks up the sky above and the ground below, so a
 * kart on the snow circuit looks cold and one in the dunes looks warm, for the
 * cost of one 256x128 canvas at race build time.
 */
import * as THREE from 'three';
import type { EnvironmentDef } from '../core/types';

function hex(color: number): string {
  return '#' + ((color >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * @param size Probe cube face size. 0 returns null (the low quality tier).
 * @returns The PMREM texture to assign to `scene.environment`, or null.
 */
export function buildEnvironmentProbe(
  renderer: THREE.WebGLRenderer,
  env: EnvironmentDef,
  size: number,
): THREE.Texture | null {
  if (size <= 0) return null;

  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Vertical band: zenith -> horizon -> ground, matching the sky dome shader.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, hex(env.skyTop));
  grad.addColorStop(0.44, hex(env.skyHorizon));
  grad.addColorStop(0.52, hex(env.fogColor));
  grad.addColorStop(1, hex(env.ambientGround));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Sun blob, placed from the light direction so highlights track the shadows.
  const dir = new THREE.Vector3(env.sunDirection.x, env.sunDirection.y, env.sunDirection.z);
  if (dir.lengthSq() < 1e-6) dir.set(0.4, 0.8, 0.3);
  dir.normalize();
  const u = (Math.atan2(dir.z, dir.x) / (Math.PI * 2) + 0.5) * w;
  const v = (0.5 - Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) / Math.PI) * h;
  const glow = ctx.createRadialGradient(u, v, 0, u, v, w * 0.22);
  glow.addColorStop(0, hex(env.sunColor));
  glow.addColorStop(0.25, hex(env.sunColor));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = Math.min(1, 0.35 + env.sunIntensity * 0.25);
  ctx.globalCompositeOperation = 'lighter';
  ctx.beginPath();
  ctx.arc(u, v, w * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  const source = new THREE.CanvasTexture(canvas);
  source.mapping = THREE.EquirectangularReflectionMapping;
  source.colorSpace = THREE.SRGBColorSpace;

  let pmrem: THREE.PMREMGenerator | null = null;
  try {
    pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    return pmrem.fromEquirectangular(source).texture;
  } catch (err) {
    console.warn('[fx] environment probe failed; karts will light without reflections', err);
    return null;
  } finally {
    source.dispose();
    pmrem?.dispose();
  }
}
