/**
 * Per-circuit weather: snow over the Atlas, sand streaming across Merzouga,
 * rain and lightning on the Casa Neon street course, embers climbing out of
 * Jbel Inferno.
 *
 * Each layer is one THREE.Points draw call whose particles wrap inside a box
 * anchored to the camera (see WEATHER_VERTEX), so the field is infinite and the
 * per-frame CPU cost is a handful of uniform writes. Gusts are a slow noise on
 * the wind uniform, which is why the whole field surges together the way real
 * weather does.
 *
 * Nothing in here is simulated, networked or gameplay-affecting: two clients in
 * the same online race see the same weather because they share the track seed,
 * not because anyone sends it.
 */
import * as THREE from 'three';
import type { WeatherDef, WeatherLayerDef } from '../core/types';
import { WEATHER_FRAGMENT, WEATHER_VERTEX } from './shaders';

/** Never build more than this per layer, whatever a track definition asks for. */
const MAX_PARTICLES = 6000;

interface Layer {
  def: WeatherLayerDef;
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  geometry: THREE.BufferGeometry;
  /** Gust phase, so the layers do not all surge in lockstep. */
  phase: number;
}

export class Weather {
  readonly object = new THREE.Group();

  /** Fired when lightning strikes, so Game can flash the post-process. */
  onLightning: ((color: number) => void) | null = null;

  private readonly layers: Layer[] = [];
  private readonly def: WeatherDef | null;
  private time = 0;
  private strikeTimer = 0;
  private groundY = 0;
  private heightPx = 720;
  private readonly origin = new THREE.Vector3();
  private readonly drift = new THREE.Vector3();

  /**
   * @param scale Quality multiplier on particle counts. 0 builds nothing.
   */
  constructor(def: WeatherDef | undefined, scale: number) {
    this.object.name = 'weather';
    this.object.frustumCulled = false;
    this.def = def && scale > 0 ? def : null;
    if (!this.def) return;

    for (const layerDef of this.def.layers) {
      const layer = this.buildLayer(layerDef, scale);
      if (layer) {
        this.layers.push(layer);
        this.object.add(layer.points);
      }
    }
    this.strikeTimer = this.nextStrikeDelay();
  }

  get active(): boolean {
    return this.layers.length > 0;
  }

  /** Renderer height in device pixels, so point sizes match the particle system. */
  setViewportHeight(px: number): void {
    this.heightPx = Math.max(1, px);
    for (const layer of this.layers) layer.material.uniforms.uHeightPx.value = this.heightPx;
  }

  /**
   * @param groundY Ground height under the camera. Used so snow settles on the
   *   terrain instead of falling through it.
   */
  update(dt: number, camera: THREE.Camera, groundY: number): void {
    if (this.layers.length === 0) return;
    this.time += dt;
    // Ease the ground reference: it comes from a single terrain sample, which
    // jumps when the camera crosses a ridge.
    this.groundY += (groundY - this.groundY) * Math.min(1, dt * 4);

    const cam = camera.position;
    for (const layer of this.layers) {
      const d = layer.def;
      const u = layer.material.uniforms;
      // Centre the volume on the camera, snapped so the wrap does not shimmer.
      this.origin.set(
        Math.round((cam.x - d.size.x * 0.5) * 4) / 4,
        Math.round((cam.y + d.yOffset - d.size.y * 0.5) * 4) / 4,
        Math.round((cam.z - d.size.z * 0.5) * 4) / 4,
      );
      u.uOrigin.value.copy(this.origin);

      // Gusts: two out-of-step sines make a wind that builds and dies away.
      const t = this.time + layer.phase;
      const gust = (Math.sin(t * 0.37) * 0.6 + Math.sin(t * 0.11 + 1.7) * 0.4) * d.gust;
      this.drift.set(d.wind.x + gust, -d.fall, d.wind.z + gust * 0.6);
      u.uDrift.value.copy(this.drift);
      u.uTime.value = this.time;
      u.uGroundY.value = this.groundY;
    }

    this.updateLightning(dt);
  }

  dispose(): void {
    for (const layer of this.layers) {
      layer.geometry.dispose();
      layer.material.dispose();
    }
    this.layers.length = 0;
    this.object.clear();
    this.onLightning = null;
  }

  // ---------------------------------------------------------------------------

  private buildLayer(def: WeatherLayerDef, scale: number): Layer | null {
    const count = Math.min(MAX_PARTICLES, Math.round(def.count * scale));
    if (count <= 0 || def.kind === 'none') return null;

    const seeds = new Float32Array(count * 3);
    const rands = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seeds[i * 3] = Math.random();
      seeds[i * 3 + 1] = Math.random();
      seeds[i * 3 + 2] = Math.random();
      // x is compared against uDensity, so a uniform spread thins the field evenly.
      rands[i * 4] = Math.random();
      rands[i * 4 + 1] = Math.random();
      rands[i * 4 + 2] = Math.random();
      rands[i * 4 + 3] = Math.random();
    }

    const geometry = new THREE.BufferGeometry();
    // `position` stays at the origin: the vertex shader builds the world
    // position from aSeed, but three.js still wants the attribute to exist.
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geometry.setAttribute('aRand', new THREE.BufferAttribute(rands, 4));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.ShaderMaterial({
      vertexShader: WEATHER_VERTEX,
      fragmentShader: WEATHER_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uExtent: { value: new THREE.Vector3(def.size.x, def.size.y, def.size.z) },
        uDrift: { value: new THREE.Vector3() },
        uSway: { value: def.sway },
        uSizeRange: { value: new THREE.Vector2(def.size0, def.size1) },
        uDensity: { value: 1 },
        uHeightPx: { value: this.heightPx },
        uGroundY: { value: 0 },
        uSettle: { value: def.settle ? 1 : 0 },
        uNearFade: { value: 2.5 },
        uColor: { value: new THREE.Color(def.color).convertSRGBToLinear() },
        uOpacity: { value: def.opacity },
        uStretch: { value: def.stretch },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: def.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 3;
    points.name = `weather-${def.kind}`;
    return { def, points, material, geometry, phase: Math.random() * 100 };
  }

  private nextStrikeDelay(): number {
    const mean = this.def?.lightning ?? 0;
    if (mean <= 0) return Infinity;
    // Exponential-ish spacing so strikes never fall into a rhythm.
    return mean * (0.45 + Math.random() * 1.3);
  }

  private updateLightning(dt: number): void {
    if (!Number.isFinite(this.strikeTimer)) return;
    this.strikeTimer -= dt;
    if (this.strikeTimer > 0) return;
    this.strikeTimer = this.nextStrikeDelay();
    this.onLightning?.(this.def?.lightningColor ?? 0xdfe8ff);
  }
}
