/**
 * Device profiling and adaptive resolution.
 *
 * Everything that scales with the machine it runs on is decided here once, at
 * boot: pixel ratio, shadow budget, whether post-processing is worth it, how
 * thick the weather may fall. A phone gets a game that runs; a desktop gets one
 * that looks its best. `?quality=low|medium|high` overrides the guess.
 *
 * AdaptiveResolution then trims the render scale at runtime when frames start
 * costing too much, which is the cheapest frame time you can buy back.
 */

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityProfile {
  tier: QualityTier;
  /** The primary pointer is a finger: show touch controls, grow tap targets. */
  touch: boolean;
  /** Touch device with a small screen. Phones get the most aggressive cuts. */
  phone: boolean;
  /** MSAA. Cannot be changed after the WebGL context exists, so it is read once. */
  antialias: boolean;
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  postFX: boolean;
  /** Multiplier on weather particle counts (0 disables weather entirely). */
  weatherScale: number;
  anisotropy: number;
  /** Reflection probe resolution for kart bodywork; 0 skips the probe. */
  envMapSize: number;
  /** Lowest render scale AdaptiveResolution may fall to. */
  minRenderScale: number;
}

const HIGH: QualityProfile = {
  tier: 'high',
  touch: false,
  phone: false,
  antialias: true,
  maxPixelRatio: 2,
  shadows: true,
  shadowMapSize: 2048,
  postFX: true,
  weatherScale: 1,
  anisotropy: 16,
  envMapSize: 256,
  minRenderScale: 0.75,
};

const MEDIUM: QualityProfile = {
  ...HIGH,
  tier: 'medium',
  antialias: true,
  maxPixelRatio: 1.75,
  shadowMapSize: 1024,
  weatherScale: 0.7,
  anisotropy: 8,
  envMapSize: 128,
  minRenderScale: 0.65,
};

const LOW: QualityProfile = {
  ...HIGH,
  tier: 'low',
  antialias: false,
  maxPixelRatio: 1.5,
  shadows: true,
  shadowMapSize: 1024,
  postFX: false,
  weatherScale: 0.45,
  anisotropy: 4,
  envMapSize: 64,
  minRenderScale: 0.55,
};

const TIERS: Record<QualityTier, QualityProfile> = { low: LOW, medium: MEDIUM, high: HIGH };

let cached: QualityProfile | null = null;

/** True when the primary pointer is a finger (phones, tablets, touch laptops in tablet mode). */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(pointer: coarse)').matches) return true;
    // Device-mode emulators and phones without a mouse report no hover.
    if (window.matchMedia?.('(hover: none)').matches) return true;
  } catch {
    /* matchMedia can throw in odd embedders */
  }
  const points = navigator.maxTouchPoints ?? 0;
  // Phones expose several contact points. A precision touchpad can report 1.
  if (points > 1) return true;
  return points > 0 && !window.matchMedia?.('(pointer: fine)').matches;
}

/** Shortest screen edge in CSS pixels - the honest "how big is this thing" signal. */
function shortestEdge(): number {
  const w = window.screen?.width || window.innerWidth || 1920;
  const h = window.screen?.height || window.innerHeight || 1080;
  return Math.min(w, h);
}

export function detectQuality(): QualityProfile {
  if (cached) return cached;

  const touch = isTouchDevice();
  const phone = touch && shortestEdge() < 820;
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;

  let tier: QualityTier;
  if (phone || cores <= 4 || memory <= 3) tier = 'low';
  else if (touch || cores <= 6 || memory <= 6) tier = 'medium';
  else tier = 'high';

  const override = new URLSearchParams(location.search).get('quality');
  if (override === 'low' || override === 'medium' || override === 'high') tier = override;

  cached = { ...TIERS[tier], tier, touch, phone };
  return cached;
}

/**
 * Trims the render scale when frames run long and gives it back when they do
 * not. Deliberately slow to react in both directions: resolution that visibly
 * pumps up and down is worse than a slightly soft image.
 */
export class AdaptiveResolution {
  private scale = 1;
  /** Rolling average frame time in seconds. */
  private avg = 1 / 60;
  private cooldown = 1.5;
  /** Seconds spent at the resolution floor while still missing the budget. */
  private floorTime = 0;

  constructor(
    private readonly min: number,
    /** Frame time we start shedding pixels at (seconds). */
    private readonly budget = 1 / 50,
    /** Frame time below which we can afford to give pixels back. */
    private readonly comfort = 1 / 75,
  ) {}

  get value(): number {
    return this.scale;
  }

  /**
   * True when the smallest render scale still is not enough. There is nothing
   * left to take from resolution, so the caller should drop something bigger -
   * post-processing is the usual candidate.
   */
  get overloaded(): boolean {
    return this.floorTime > 3;
  }

  reset(): void {
    this.scale = 1;
    this.avg = 1 / 60;
    this.cooldown = 1.5;
    this.floorTime = 0;
  }

  /** Returns true when the scale changed and the renderer needs resizing. */
  update(dt: number): boolean {
    // Ignore hitches (tab switches, GC pauses): they are not a resolution problem.
    if (dt > 0.25) return false;
    this.avg += (dt - this.avg) * 0.06;
    if (this.scale <= this.min && this.avg > this.budget) this.floorTime += dt;
    else this.floorTime = 0;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return false;
    }
    const before = this.scale;
    if (this.avg > this.budget && this.scale > this.min) {
      this.scale = Math.max(this.min, this.scale - 0.1);
      this.cooldown = 1.2;
    } else if (this.avg < this.comfort && this.scale < 1) {
      this.scale = Math.min(1, this.scale + 0.05);
      this.cooldown = 2.5;
    }
    return this.scale !== before;
  }
}
