/**
 * Per-kart engine voices. Sawtooth + detuned square + sub sine → lowpass whose
 * cutoff tracks rpm → tanh soft-clip → gain, with optional turbo whistle and a
 * filtered-noise skid loop. Non-player voices are positioned with a PannerNode.
 */
import type { KartState, WeightClass } from '../core/types';
import { clamp, clamp01, damp } from '../core/math';
import { glide, noiseBuffer, softClipCurve } from './synth';

const BASE_FREQ: Record<WeightClass, number> = { light: 96, medium: 78, heavy: 62 };
const IDLE_RPM = 0.15;

let sharedClipCurve: Float32Array<ArrayBuffer> | null = null;

export class EngineVoice {
  readonly kartId: number;
  readonly isPlayer: boolean;
  private readonly ctx: AudioContext;
  private readonly baseFreq: number;

  private readonly out: GainNode;
  private readonly panner: PannerNode | null;
  private readonly filter: BiquadFilterNode;
  private readonly shaper: WaveShaperNode;
  private readonly engineGain: GainNode;
  private readonly saw: OscillatorNode;
  private readonly sawGain: GainNode;
  private square: OscillatorNode | null = null;
  private squareGain: GainNode | null = null;
  private sub: OscillatorNode | null = null;
  private subGain: GainNode | null = null;

  private readonly turboOsc: OscillatorNode;
  private readonly turboNoise: AudioBufferSourceNode;
  private readonly turboFilter: BiquadFilterNode;
  private readonly turboGain: GainNode;

  private readonly skidSrc: AudioBufferSourceNode;
  private readonly skidFilter: BiquadFilterNode;
  private readonly skidGain: GainNode;

  private rpm = IDLE_RPM;
  private rich = false;
  private disposed = false;
  // Last scheduled targets for the optional layers, so silent layers don't
  // push a new automation event every frame.
  private turboLevel = -1;
  private skidLevel = -1;

  constructor(ctx: AudioContext, dest: AudioNode, kartId: number, weightClass: WeightClass, isPlayer: boolean) {
    this.ctx = ctx;
    this.kartId = kartId;
    this.isPlayer = isPlayer;
    this.baseFreq = BASE_FREQ[weightClass] ?? BASE_FREQ.medium;

    this.out = ctx.createGain();
    this.out.gain.value = isPlayer ? 1 : 0.85;

    if (!isPlayer) {
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 6;
      panner.maxDistance = 90;
      panner.rolloffFactor = 1;
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      this.out.connect(panner);
      panner.connect(dest);
      this.panner = panner;
    } else {
      this.panner = null;
      this.out.connect(dest);
    }

    // --- core engine ------------------------------------------------------
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 1.1;
    this.filter.frequency.value = 400;

    this.shaper = ctx.createWaveShaper();
    if (!sharedClipCurve) sharedClipCurve = softClipCurve(2.2);
    this.shaper.curve = sharedClipCurve;
    this.shaper.oversample = 'none';

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.filter.connect(this.shaper);
    this.shaper.connect(this.engineGain);
    this.engineGain.connect(this.out);

    this.saw = ctx.createOscillator();
    this.saw.type = 'sawtooth';
    this.saw.frequency.value = this.baseFreq;
    this.sawGain = ctx.createGain();
    this.sawGain.gain.value = 0.5;
    this.saw.connect(this.sawGain);
    this.sawGain.connect(this.filter);
    this.saw.start();

    // --- turbo whistle layer ------------------------------------------------
    this.turboFilter = ctx.createBiquadFilter();
    this.turboFilter.type = 'bandpass';
    this.turboFilter.Q.value = 2.5;
    this.turboFilter.frequency.value = 1400;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboFilter.connect(this.turboGain);
    this.turboGain.connect(this.out);

    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'triangle';
    this.turboOsc.frequency.value = 1200;
    const turboOscGain = ctx.createGain();
    turboOscGain.gain.value = 0.5;
    this.turboOsc.connect(turboOscGain);
    turboOscGain.connect(this.turboFilter);
    this.turboOsc.start();

    this.turboNoise = ctx.createBufferSource();
    this.turboNoise.buffer = noiseBuffer(ctx, 'white');
    this.turboNoise.loop = true;
    const turboNoiseGain = ctx.createGain();
    turboNoiseGain.gain.value = 0.35;
    this.turboNoise.connect(turboNoiseGain);
    turboNoiseGain.connect(this.turboFilter);
    this.turboNoise.start(0, Math.random());

    // --- skid loop ------------------------------------------------------------
    this.skidSrc = ctx.createBufferSource();
    this.skidSrc.buffer = noiseBuffer(ctx, 'pink');
    this.skidSrc.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 1900;
    this.skidFilter.Q.value = 1.4;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidSrc.connect(this.skidFilter);
    this.skidFilter.connect(this.skidGain);
    this.skidGain.connect(this.out);
    this.skidSrc.start(0, Math.random());

    this.setRich(isPlayer);
  }

  /** Full (saw + square + sub) vs cheap (saw only) voice. */
  setRich(rich: boolean): void {
    if (this.disposed || rich === this.rich) return;
    this.rich = rich;
    const ctx = this.ctx;
    if (rich) {
      const now = ctx.currentTime;
      this.square = ctx.createOscillator();
      this.square.type = 'square';
      this.square.detune.value = 9;
      this.square.frequency.value = this.saw.frequency.value;
      this.squareGain = ctx.createGain();
      this.squareGain.gain.setValueAtTime(0, now);
      this.squareGain.gain.linearRampToValueAtTime(0.22, now + 0.2);
      this.square.connect(this.squareGain);
      this.squareGain.connect(this.filter);
      this.square.start();

      this.sub = ctx.createOscillator();
      this.sub.type = 'sine';
      this.sub.frequency.value = this.saw.frequency.value * 0.5;
      this.subGain = ctx.createGain();
      this.subGain.gain.setValueAtTime(0, now);
      this.subGain.gain.linearRampToValueAtTime(0.45, now + 0.2);
      this.sub.connect(this.subGain);
      this.subGain.connect(this.filter);
      this.sub.start();
    } else {
      this.stopExtras();
    }
  }

  private stopExtras(): void {
    const now = this.ctx.currentTime;
    const square = this.square;
    const squareGain = this.squareGain;
    const sub = this.sub;
    const subGain = this.subGain;
    if (square && squareGain) {
      squareGain.gain.setTargetAtTime(0, now, 0.05);
      square.stop(now + 0.3);
      square.onended = () => {
        square.disconnect();
        squareGain.disconnect();
      };
    }
    if (sub && subGain) {
      subGain.gain.setTargetAtTime(0, now, 0.05);
      sub.stop(now + 0.3);
      sub.onended = () => {
        sub.disconnect();
        subGain.disconnect();
      };
    }
    this.square = null;
    this.squareGain = null;
    this.sub = null;
    this.subGain = null;
  }

  update(dt: number, state: KartState, throttle: number, topSpeed: number): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const speed = Math.abs(state.speed);
    const ratio = clamp(speed / Math.max(1, topSpeed), 0, 1.4);

    let target = IDLE_RPM + 0.85 * ratio;
    target += 0.2 * clamp01(throttle) * (1 - clamp01(ratio));
    if (state.isFrozen) target = IDLE_RPM + 0.45 * clamp01(throttle);
    if (state.isAirborne) target = Math.max(target, Math.min(1.35, target + state.airTime * 0.7));
    if (state.isSpinning || state.isSquished) target *= 0.7;
    if (state.isBoosting) target = Math.max(target, 1.05);

    const lambda = target > this.rpm ? 3.2 : 5;
    this.rpm = damp(this.rpm, target, lambda, dt);
    const rpm = this.rpm;

    const pitchMul = state.isShrunk ? 1.5 : 1;
    const freq = this.baseFreq * (0.55 + 1.9 * rpm) * pitchMul;
    glide(this.saw.frequency, freq, now, 0.03);
    if (this.square) glide(this.square.frequency, freq, now, 0.03);
    if (this.sub) glide(this.sub.frequency, freq * 0.5, now, 0.03);
    glide(this.filter.frequency, 240 + rpm * 1900, now, 0.05);

    const load = 0.55 + 0.45 * clamp01(throttle);
    const base = this.isPlayer ? 0.3 : 0.27;
    const vol = base * load * (0.7 + 0.3 * Math.min(1, rpm));
    glide(this.engineGain.gain, vol, now, 0.06);

    // Turbo whistle while boosting.
    const turbo = state.isBoosting ? 0.11 : 0;
    glide(this.turboGain.gain, turbo, now, 0.08);
    if (state.isBoosting) {
      const tf = 900 + rpm * 700 + clamp01(state.boostTimer) * 400;
      glide(this.turboOsc.frequency, tf, now, 0.06);
      glide(this.turboFilter.frequency, tf * 1.1, now, 0.06);
    }

    // Skid loop while drifting on the ground.
    const skid = state.isDrifting && !state.isAirborne ? 0.14 * clamp01(speed / 14) * (0.6 + 0.4 * Math.abs(state.steerVisual)) : 0;
    glide(this.skidGain.gain, skid, now, 0.06);
    if (skid > 0) {
      glide(this.skidSrc.playbackRate, 0.75 + 0.5 * clamp01(ratio), now, 0.08);
      glide(this.skidFilter.frequency, 1500 + ratio * 900, now, 0.08);
    }

    if (this.panner) {
      const p = state.position;
      setPannerPosition(this.panner, p.x, p.y, p.z);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const now = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, now, 0.03);
    this.stopExtras();
    const stopAt = now + 0.15;
    try {
      this.saw.stop(stopAt);
      this.turboOsc.stop(stopAt);
      this.turboNoise.stop(stopAt);
      this.skidSrc.stop(stopAt);
    } catch {
      // already stopped
    }
    const out = this.out;
    const panner = this.panner;
    this.saw.onended = () => {
      out.disconnect();
      panner?.disconnect();
    };
  }
}

export function setPannerPosition(panner: PannerNode, x: number, y: number, z: number): void {
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    panner.setPosition(x, y, z);
  }
}

export function setListenerPose(
  listener: AudioListener,
  px: number, py: number, pz: number,
  fx: number, fy: number, fz: number,
  ux: number, uy: number, uz: number,
): void {
  if (listener.positionX) {
    listener.positionX.value = px;
    listener.positionY.value = py;
    listener.positionZ.value = pz;
    listener.forwardX.value = fx;
    listener.forwardY.value = fy;
    listener.forwardZ.value = fz;
    listener.upX.value = ux;
    listener.upY.value = uy;
    listener.upZ.value = uz;
  } else {
    listener.setPosition(px, py, pz);
    listener.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}
