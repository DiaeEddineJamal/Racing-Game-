/**
 * Post-processing pipeline: RenderPass → UnrealBloomPass → composite ShaderPass
 * (speed lines, radial blur, chromatic aberration, vignette, hit tint, flash,
 * grain) → OutputPass (tone mapping + sRGB once). Falls back to a plain
 * renderer.render() when disabled or if construction failed.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { IPostFX } from '../core/types';
import { events } from '../core/events';
import { clamp01, damp } from '../core/math';
import { COMPOSITE_FRAGMENT, COMPOSITE_VERTEX } from './shaders';

// Bloom is a highlight on the brightest things in frame (headlights, boost
// flames, neon), not a haze over the whole picture: a high threshold keeps
// ordinary lit surfaces out of it.
const BLOOM_STRENGTH = 0.18;
const BLOOM_RADIUS = 0.3;
const BLOOM_THRESHOLD = 1.05;
const HIT_EVENT_DECAY = 0.6;
/** Linear-light grain amplitude at rest / added at full boost (~1% / +0.8%). */
const GRAIN_REST = 0.012;
const GRAIN_BOOST = 0.008;

export class PostFX implements IPostFX {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;

  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private compositePass: ShaderPass | null = null;
  private outputPass: OutputPass | null = null;

  private enabled = true;
  private failed = false;

  private speedTarget = 0;
  private boostTarget = 0;
  private hitTarget = 0;
  private speed = 0;
  private boost = 0;
  private hit = 0;
  private hitPulse = 0;
  private flashLevel = 0;
  private flashDuration = 0;
  private flashPeak = 0;
  private time = 0;

  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  private readonly flashColor = new THREE.Color(1, 1, 1);
  private readonly unsubs: (() => void)[] = [];

  constructor() {
    this.unsubs.push(events.on('item:lightning', () => this.flash(0xcfe6ff, 0.5)));
    this.unsubs.push(events.on('item:hit', (e) => {
      if (e.isPlayer) this.hitPulse = 1;
    }));
    this.unsubs.push(events.on('kart:spin', (e) => {
      if (e.kartId === 0) this.hitPulse = Math.max(this.hitPulse, 0.8);
    }));
  }

  init(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    this.disposePipeline();
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.failed = false;

    const size = renderer.getSize(new THREE.Vector2());
    this.width = Math.max(1, size.x);
    this.height = Math.max(1, size.y);
    this.pixelRatio = renderer.getPixelRatio();

    try {
      const bufW = Math.max(1, Math.floor(this.width * this.pixelRatio));
      const bufH = Math.max(1, Math.floor(this.height * this.pixelRatio));
      // Explicit HDR target with no MSAA (samples: 0) and no stencil: bloom and
      // the composite pass read it as a texture, so multisampling would only
      // cost a resolve per frame.
      const target = new THREE.WebGLRenderTarget(bufW, bufH, {
        type: THREE.HalfFloatType,
        samples: 0,
        depthBuffer: true,
        stencilBuffer: false,
      });
      const composer = new EffectComposer(renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(this.width, this.height);

      const renderPass = new RenderPass(scene, camera);
      // UnrealBloomPass halves the resolution it is given internally, so passing
      // the full drawing-buffer size yields a half-res bright/blur chain (and
      // matches what composer.setSize() propagates on resize).
      const bloom = new UnrealBloomPass(new THREE.Vector2(bufW, bufH), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
      const composite = new ShaderPass({
        uniforms: {
          tDiffuse: { value: null },
          uResolution: { value: new THREE.Vector2(bufW, bufH) },
          uTime: { value: 0 },
          uSpeed: { value: 0 },
          uBoost: { value: 0 },
          uHit: { value: 0 },
          uFlash: { value: 0 },
          uFlashColor: { value: new THREE.Color(1, 1, 1) },
          uGrain: { value: GRAIN_REST },
        },
        vertexShader: COMPOSITE_VERTEX,
        fragmentShader: COMPOSITE_FRAGMENT,
      });
      const output = new OutputPass();

      composer.addPass(renderPass);
      composer.addPass(bloom);
      composer.addPass(composite);
      composer.addPass(output);

      this.composer = composer;
      this.renderPass = renderPass;
      this.bloomPass = bloom;
      this.compositePass = composite;
      this.outputPass = output;
    } catch (err) {
      console.warn('[PostFX] failed to build pipeline, falling back to plain rendering', err);
      this.failed = true;
      this.disposePipeline();
    }
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    if (this.renderPass) this.renderPass.camera = camera;
  }

  render(dt: number): void {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera) return;

    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;

    // Smooth targets; hit combines the API target with the event pulse.
    this.speed = damp(this.speed, this.speedTarget, 6, dt);
    this.boost = damp(this.boost, this.boostTarget, this.boostTarget > this.boost ? 10 : 4, dt);
    if (this.hitPulse > 0) this.hitPulse = Math.max(0, this.hitPulse - dt / HIT_EVENT_DECAY);
    this.hit = damp(this.hit, Math.max(this.hitTarget, this.hitPulse), 12, dt);

    if (this.flashLevel > 0 && this.flashDuration > 0) {
      this.flashLevel = Math.max(0, this.flashLevel - dt / this.flashDuration);
    } else {
      this.flashLevel = 0;
    }

    if (!this.enabled || this.failed || !this.composer || !this.compositePass) {
      renderer.render(scene, camera);
      return;
    }

    const u = this.compositePass.uniforms;
    u.uTime.value = this.time;
    u.uSpeed.value = this.speed;
    u.uBoost.value = this.boost;
    u.uHit.value = this.hit;
    u.uGrain.value = GRAIN_REST + GRAIN_BOOST * this.boost;
    // ease-out curve so the flash pops then lingers briefly
    const f = this.flashLevel;
    u.uFlash.value = this.flashPeak * f * f;
    (u.uFlashColor.value as THREE.Color).copy(this.flashColor);

    try {
      this.composer.render(dt);
    } catch (err) {
      console.warn('[PostFX] composer render failed, disabling post-processing', err);
      this.failed = true;
      renderer.render(scene, camera);
    }
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = Math.max(0.5, pixelRatio);
    if (this.composer) {
      // Propagates to every pass (bloom keeps its half-res chain).
      this.composer.setPixelRatio(this.pixelRatio);
      this.composer.setSize(this.width, this.height);
    }
    if (this.compositePass) {
      (this.compositePass.uniforms.uResolution.value as THREE.Vector2).set(
        Math.max(1, Math.floor(this.width * this.pixelRatio)),
        Math.max(1, Math.floor(this.height * this.pixelRatio)),
      );
    }
  }

  setSpeedEffect(intensity: number): void {
    this.speedTarget = clamp01(intensity);
  }

  setBoostEffect(intensity: number): void {
    this.boostTarget = clamp01(intensity);
  }

  setHitEffect(intensity: number): void {
    this.hitTarget = clamp01(intensity);
  }

  flash(color: number, duration: number): void {
    this.flashColor.setHex(color);
    this.flashDuration = Math.max(0.05, duration);
    this.flashLevel = 1;
    this.flashPeak = 0.9;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private disposePipeline(): void {
    this.bloomPass?.dispose();
    this.compositePass?.dispose();
    this.outputPass?.dispose();
    this.renderPass?.dispose();
    this.composer?.dispose();
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.compositePass = null;
    this.outputPass = null;
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.disposePipeline();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }
}
