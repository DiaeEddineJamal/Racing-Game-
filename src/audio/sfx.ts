/**
 * Event-driven sound effects. Every sound is synthesised on demand from the
 * primitives in synth.ts. Non-player sounds are attenuated and panned from the
 * listener frame; player sounds are always audible and centred.
 */
import * as THREE from 'three';
import type { BoostSource, IKart, ItemType } from '../core/types';
import { events } from '../core/events';
import type { GameEvents } from '../core/events';
import { clamp01, smoothstep } from '../core/math';
import { midiToFreq, noiseBuffer, playChord, playNoiseBurst, playSequence, playTone } from './synth';

export interface SfxBuses {
  sfx: GainNode;
  ui: GainNode;
}

export class ListenerFrame {
  readonly pos = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly up = new THREE.Vector3(0, 1, 0);
}

/** Approximate track length used to turn track-t distances into metres. */
const TRACK_LENGTH_GUESS = 1100;

// ---------------------------------------------------------------------------
// Crowd ambience
// ---------------------------------------------------------------------------

export class Crowd {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly murmur: AudioBufferSourceNode;
  private readonly hiss: AudioBufferSourceNode;
  private readonly lfo: OscillatorNode;
  private cheer = 0;
  private disposed = false;

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(dest);

    // Low murmur: pink noise through a lowpass, gently modulated.
    this.murmur = ctx.createBufferSource();
    this.murmur.buffer = noiseBuffer(ctx, 'pink');
    this.murmur.loop = true;
    const murmurFilter = ctx.createBiquadFilter();
    murmurFilter.type = 'lowpass';
    murmurFilter.frequency.value = 520;
    murmurFilter.Q.value = 0.6;
    const murmurGain = ctx.createGain();
    murmurGain.gain.value = 0.8;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.31;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.25;
    this.lfo.connect(lfoGain);
    lfoGain.connect(murmurGain.gain);
    this.murmur.connect(murmurFilter);
    murmurFilter.connect(murmurGain);
    murmurGain.connect(this.gain);

    // Airy "sss" of a distant crowd: bandpassed white noise.
    this.hiss = ctx.createBufferSource();
    this.hiss.buffer = noiseBuffer(ctx, 'white');
    this.hiss.loop = true;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 1100;
    hissFilter.Q.value = 0.5;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.28;
    this.hiss.connect(hissFilter);
    hissFilter.connect(hissGain);
    hissGain.connect(this.gain);

    this.murmur.start(0, Math.random());
    this.hiss.start(0, Math.random() * 1.5);
    this.lfo.start();
  }

  /** Swell the crowd for a moment (race start, laps, finish). */
  cheerBurst(strength: number): void {
    this.cheer = Math.max(this.cheer, clamp01(strength));
  }

  update(dt: number, playerTrackT: number | null): void {
    if (this.disposed) return;
    let proximity = 0;
    if (playerTrackT !== null && isFinite(playerTrackT)) {
      const t = playerTrackT - Math.floor(playerTrackT);
      const metres = Math.min(t, 1 - t) * TRACK_LENGTH_GUESS;
      proximity = 1 - smoothstep(12, 40, metres);
    }
    this.cheer = Math.max(0, this.cheer - dt / 2.5);
    const target = proximity * 0.16 + this.cheer * 0.22;
    this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.25);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const now = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(0, now, 0.05);
    try {
      this.murmur.stop(now + 0.3);
      this.hiss.stop(now + 0.3);
      this.lfo.stop(now + 0.3);
    } catch {
      // already stopped
    }
    const g = this.gain;
    this.murmur.onended = () => g.disconnect();
  }
}

// ---------------------------------------------------------------------------
// SFX bank
// ---------------------------------------------------------------------------

export class SfxBank {
  readonly listener = new ListenerFrame();
  karts: readonly IKart[] = [];
  playerKartId = 0;

  private readonly ctx: AudioContext;
  private readonly buses: SfxBuses;
  private readonly unsubs: (() => void)[] = [];
  private readonly skip: Set<string>;
  private rouletteCount = 0;
  private lastWrongWay = -10;
  private disposed = false;

  /**
   * `skip` lists event names handled by the recorded sample layer. Those events
   * are ignored here so a sound is never played twice.
   */
  constructor(ctx: AudioContext, buses: SfxBuses, skip: readonly string[] = []) {
    this.ctx = ctx;
    this.buses = buses;
    this.skip = new Set(skip);
    this.subscribe();
  }

  private subscribe(): void {
    const u = this.unsubs;
    const skip = this.skip;
    const on = <K extends keyof GameEvents>(name: K, fn: (e: GameEvents[K]) => void): void => {
      if (skip.has(name)) return;
      u.push(events.on(name, fn));
    };
    on('kart:hop', (e) => this.hop(e.kartId));
    on('kart:land', (e) => this.land(e.kartId, e.impact));
    on('kart:driftStart', (e) => this.driftStart(e.kartId));
    on('kart:driftStage', (e) => this.driftStage(e.kartId, e.stage));
    on('kart:driftEnd', (e) => this.driftEnd(e.kartId, e.boostStage));
    on('kart:boost', (e) => this.boost(e.kartId, e.source, e.strength));
    on('kart:collision', (e) => this.collision(e.kartId, e.otherId, e.impulse, e.position));
    on('kart:spin', (e) => this.spin(e.kartId, e.cause));
    on('kart:squish', (e) => this.squish(e.kartId));
    on('kart:shrink', (e) => this.shrink(e.kartId, true));
    on('kart:unshrink', (e) => this.shrink(e.kartId, false));
    on('item:pickup', (e) => this.itemPickup(e.position, e.isPlayer));
    on('item:rouletteTick', (e) => this.rouletteTick(e.isPlayer));
    on('item:rouletteEnd', (e) => this.rouletteEnd(e.isPlayer));
    on('item:use', (e) => this.itemUse(e.item, e.position, e.isPlayer));
    on('item:hit', (e) => this.itemHit(e.item, e.position, e.isPlayer));
    on('item:destroyed', (e) => this.itemDestroyed(e.item, e.position));
    on('item:shellBounce', (e) => this.shellBounce(e.position));
    on('item:explosion', (e) => this.explosion(e.position, e.radius));
    on('item:lightning', () => this.lightning());
    on('item:boxRespawn', (e) => this.boxRespawn(e.position));
    on('item:blueShellLaunch', () => this.blueShellLaunch());
    on('race:countdown', (e) => this.countdown(e.count));
    on('race:start', () => this.raceStart());
    on('race:lap', (e) => this.lap(e.kartId, e.isPlayer, e.isFinalLap));
    on('race:finish', (e) => this.finish(e.kartId, e.place, e.isPlayer));
    on('race:positionChange', (e) => { if (e.isPlayer) this.positionChange(e.from, e.to); });
    on('race:wrongWay', (e) => this.wrongWay(e.kartId, e.wrongWay));
    on('ui:move', () => this.uiMove());
    on('ui:select', () => this.uiSelect());
    on('ui:back', () => this.uiBack());
    on('ui:error', () => this.uiError());
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.karts = [];
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private kartPosition(kartId: number): THREE.Vector3 | null {
    const karts = this.karts;
    if (kartId >= 0 && kartId < karts.length && karts[kartId].state.id === kartId) return karts[kartId].state.position;
    for (let i = 0; i < karts.length; i++) if (karts[i].state.id === kartId) return karts[i].state.position;
    return null;
  }

  private isPlayer(kartId: number): boolean {
    return kartId === this.playerKartId;
  }

  /**
   * Destination for a world position: attenuated (inverse distance) and panned.
   * `null` position → centred on the SFX bus. Returns null when inaudible.
   */
  private spatial(pos: THREE.Vector3 | null, ref: number, max: number, gain: number): AudioNode | null {
    if (this.disposed) return null;
    const ctx = this.ctx;
    const bus = this.buses.sfx;
    if (!pos) {
      if (gain === 1) return bus;
      const g = ctx.createGain();
      g.gain.value = gain;
      g.connect(bus);
      return g;
    }
    const L = this.listener;
    const dx = pos.x - L.pos.x;
    const dy = pos.y - L.pos.y;
    const dz = pos.z - L.pos.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > max) return null;
    const att = d <= ref ? 1 : ref / (ref + (d - ref));
    const pan = d > 0.01 ? ((dx * L.right.x + dy * L.right.y + dz * L.right.z) / d) * 0.75 : 0;
    const g = ctx.createGain();
    g.gain.value = gain * att;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      p.connect(bus);
    } else {
      g.connect(bus);
    }
    return g;
  }

  /** Destination for a kart-owned sound: player centred, others spatialised. */
  private kartDest(kartId: number, ref: number, max: number, playerGain: number, otherGain: number): AudioNode | null {
    if (this.isPlayer(kartId)) return this.spatial(null, ref, max, playerGain);
    return this.spatial(this.kartPosition(kartId), ref, max, otherGain);
  }

  private get now(): number {
    return this.ctx.currentTime;
  }

  // -------------------------------------------------------------------------
  // Kart
  // -------------------------------------------------------------------------

  hop(kartId: number): void {
    const dest = this.kartDest(kartId, 8, 40, 1, 0.6);
    if (!dest) return;
    playTone(this.ctx, dest, {
      freq: 520, endFreq: 780, type: 'sine', duration: 0.06, gain: 0.22,
      env: { attack: 0.005, decay: 0.03, sustain: 0.5, release: 0.05 },
    });
  }

  land(kartId: number, impact: number): void {
    const dest = this.kartDest(kartId, 8, 45, 1, 0.6);
    if (!dest) return;
    const i = clamp01(impact);
    const ctx = this.ctx;
    playNoiseBurst(ctx, dest, {
      duration: 0.1, gain: 0.1 + 0.25 * i, color: 'pink',
      filter: { type: 'lowpass', freq: 520 },
      env: { attack: 0.002, decay: 0.08, sustain: 0.2, release: 0.05 },
    });
    playTone(ctx, dest, {
      freq: 110, endFreq: 55, type: 'sine', duration: 0.12, gain: 0.15 + 0.22 * i,
      env: { attack: 0.002, decay: 0.1, sustain: 0.2, release: 0.05 },
    });
  }

  driftStart(kartId: number): void {
    const dest = this.kartDest(kartId, 8, 40, 1, 0.5);
    if (!dest) return;
    playNoiseBurst(this.ctx, dest, {
      duration: 0.12, gain: 0.16, rate: 0.9,
      filter: { type: 'bandpass', freq: 1600, q: 1.2 },
      env: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 0.08 },
    });
  }

  driftStage(kartId: number, stage: 1 | 2 | 3): void {
    const dest = this.kartDest(kartId, 8, 35, 1, 0.45);
    if (!dest) return;
    const ctx = this.ctx;
    const freqs = [0, 880, 1175, 1568];
    const f = freqs[stage];
    const now = this.now;
    playTone(ctx, dest, {
      freq: f, type: 'triangle', duration: 0.07, gain: 0.18, when: now,
      env: { attack: 0.003, decay: 0.05, sustain: 0.4, release: 0.06 },
    });
    for (let k = 0; k <= stage; k++) {
      playTone(ctx, dest, {
        freq: f * (2 + k * 0.5), type: 'sine', duration: 0.04, gain: 0.06, when: now + 0.03 + k * 0.03,
        env: { attack: 0.002, decay: 0.03, sustain: 0.2, release: 0.04 },
      });
    }
  }

  driftEnd(kartId: number, boostStage: 0 | 1 | 2 | 3): void {
    if (boostStage === 0) return;
    const dest = this.kartDest(kartId, 8, 45, 1, 0.55);
    if (!dest) return;
    const ctx = this.ctx;
    playNoiseBurst(ctx, dest, {
      duration: 0.3 + 0.08 * boostStage, gain: 0.22 + 0.04 * boostStage,
      filter: { type: 'bandpass', freq: 400, endFreq: 3000, q: 1 },
      env: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.15 },
    });
    playTone(ctx, dest, {
      freq: 200, endFreq: 500 + 150 * boostStage, type: 'sawtooth', duration: 0.25, gain: 0.1,
      filter: { type: 'lowpass', freq: 1500 },
      env: { attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.1 },
    });
  }

  boost(kartId: number, source: BoostSource, strength: number): void {
    const dest = this.kartDest(kartId, 10, 50, 1, 0.6);
    if (!dest) return;
    const ctx = this.ctx;
    const now = this.now;
    const s = 0.7 + clamp01(strength) * 0.6;
    if (source === 'mushroom' || source === 'golden') {
      // Cartoon "doing" boing.
      playTone(ctx, dest, {
        freq: 180, endFreq: 720, sweepTime: 0.09, type: 'sine', duration: 0.1, gain: 0.22 * s, when: now,
        env: { attack: 0.005, decay: 0.05, sustain: 0.8, release: 0.03 },
      });
      playTone(ctx, dest, {
        freq: 720, endFreq: 430, type: 'sine', duration: 0.28, gain: 0.2 * s, when: now + 0.1,
        vibrato: { rate: 18, depth: 60 },
        env: { attack: 0.005, decay: 0.15, sustain: 0.4, release: 0.12 },
      });
      playNoiseBurst(ctx, dest, {
        duration: 0.35, gain: 0.16 * s, when: now + 0.05,
        filter: { type: 'bandpass', freq: 700, endFreq: 2600, q: 1 },
        env: { attack: 0.02, decay: 0.2, sustain: 0.4, release: 0.15 },
      });
      return;
    }
    playNoiseBurst(ctx, dest, {
      duration: 0.4, gain: 0.24 * s, when: now,
      filter: { type: 'bandpass', freq: 500, endFreq: 2500, q: 1 },
      env: { attack: 0.02, decay: 0.25, sustain: 0.4, release: 0.15 },
    });
    playTone(ctx, dest, {
      freq: 300, endFreq: 900, type: 'triangle', duration: 0.35, gain: 0.1 * s, when: now,
      filter: { type: 'lowpass', freq: 2000 },
      env: { attack: 0.02, decay: 0.15, sustain: 0.5, release: 0.1 },
    });
    if (source === 'pad' || source === 'start') {
      playTone(ctx, dest, {
        freq: 1320, endFreq: 1760, type: 'sine', duration: 0.12, gain: 0.08 * s, when: now + 0.03,
        env: { attack: 0.003, decay: 0.08, sustain: 0.2, release: 0.1 },
      });
    }
  }

  collision(kartId: number, otherId: number | null, impulse: number, position: THREE.Vector3): void {
    const i = clamp01(impulse / 10);
    const involvesPlayer = this.isPlayer(kartId) || (otherId !== null && this.isPlayer(otherId));
    const dest = involvesPlayer ? this.spatial(null, 8, 50, 1) : this.spatial(position, 8, 50, 0.6);
    if (!dest) return;
    const ctx = this.ctx;
    if (otherId === null) {
      playNoiseBurst(ctx, dest, {
        duration: 0.12, gain: 0.15 + 0.25 * i, color: 'pink',
        filter: { type: 'lowpass', freq: 700 },
        env: { attack: 0.002, decay: 0.1, sustain: 0.2, release: 0.06 },
      });
      playTone(ctx, dest, {
        freq: 140, endFreq: 60, type: 'sine', duration: 0.14, gain: 0.2 + 0.2 * i,
        env: { attack: 0.002, decay: 0.1, sustain: 0.3, release: 0.06 },
      });
    } else {
      playTone(ctx, dest, {
        freq: 300, endFreq: 180, type: 'triangle', duration: 0.1, gain: 0.12 + 0.15 * i,
        env: { attack: 0.002, decay: 0.08, sustain: 0.3, release: 0.05 },
      });
      playNoiseBurst(ctx, dest, {
        duration: 0.05, gain: 0.08 + 0.06 * i,
        filter: { type: 'bandpass', freq: 1200, q: 1 },
        env: { attack: 0.001, decay: 0.04, sustain: 0.2, release: 0.03 },
      });
    }
  }

  spin(kartId: number, cause: ItemType | 'collision' | 'explosion'): void {
    const dest = this.kartDest(kartId, 10, 55, 1, 0.65);
    if (!dest) return;
    const ctx = this.ctx;
    const now = this.now;
    // Tumbling wobble.
    playTone(ctx, dest, {
      freq: 420, endFreq: 200, type: 'triangle', duration: 0.55, gain: 0.14, when: now,
      vibrato: { rate: 7, depth: 80 },
      env: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.15 },
    });
    if (cause.includes('shell')) {
      playNoiseBurst(ctx, dest, {
        duration: 0.35, gain: 0.28, when: now,
        filter: { type: 'bandpass', freq: 2400, q: 0.6 },
        env: { attack: 0.001, decay: 0.25, sustain: 0.15, release: 0.12 },
      });
      for (let k = 0; k < 3; k++) {
        playTone(ctx, dest, {
          freq: [1800, 2400, 3100][k], type: 'sine', duration: 0.15, gain: 0.06, when: now + k * 0.015,
          env: { attack: 0.001, decay: 0.12, sustain: 0.05, release: 0.08 },
        });
      }
    } else if (cause === 'banana' || cause === 'triple_banana') {
      playTone(ctx, dest, {
        freq: 900, endFreq: 1500, sweepTime: 0.12, type: 'sine', duration: 0.28, gain: 0.12, when: now,
        vibrato: { rate: 22, depth: 50 },
        env: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.1 },
      });
    } else if (cause === 'explosion' || cause === 'bob_omb') {
      playTone(ctx, dest, {
        freq: 90, endFreq: 40, type: 'sine', duration: 0.3, gain: 0.2, when: now,
        env: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 0.1 },
      });
    } else if (cause === 'lightning') {
      playNoiseBurst(ctx, dest, {
        duration: 0.12, gain: 0.2, when: now,
        filter: { type: 'highpass', freq: 2500 },
        env: { attack: 0.001, decay: 0.1, sustain: 0.1, release: 0.05 },
      });
      playTone(ctx, dest, {
        freq: 220, endFreq: 60, type: 'square', duration: 0.1, gain: 0.1, when: now,
        filter: { type: 'lowpass', freq: 1800 },
        env: { attack: 0.001, decay: 0.08, sustain: 0.2, release: 0.04 },
      });
    } else {
      // star / collision bonk
      playTone(ctx, dest, {
        freq: 350, endFreq: 200, type: 'triangle', duration: 0.12, gain: 0.18, when: now,
        env: { attack: 0.002, decay: 0.1, sustain: 0.3, release: 0.06 },
      });
      playNoiseBurst(ctx, dest, {
        duration: 0.06, gain: 0.1, when: now,
        filter: { type: 'bandpass', freq: 900, q: 1 },
        env: { attack: 0.001, decay: 0.05, sustain: 0.2, release: 0.03 },
      });
    }
  }

  squish(kartId: number): void {
    const dest = this.kartDest(kartId, 10, 50, 1, 0.6);
    if (!dest) return;
    const ctx = this.ctx;
    playNoiseBurst(ctx, dest, {
      duration: 0.22, gain: 0.25, color: 'pink',
      filter: { type: 'lowpass', freq: 900, endFreq: 200 },
      env: { attack: 0.002, decay: 0.18, sustain: 0.15, release: 0.06 },
    });
    playTone(ctx, dest, {
      freq: 420, endFreq: 70, type: 'sine', duration: 0.22, gain: 0.25,
      env: { attack: 0.002, decay: 0.15, sustain: 0.3, release: 0.06 },
    });
  }

  shrink(kartId: number, down: boolean): void {
    const dest = this.kartDest(kartId, 10, 50, 1, 0.55);
    if (!dest) return;
    playTone(this.ctx, dest, {
      freq: down ? 800 : 150, endFreq: down ? 150 : 800, type: 'square', duration: 0.4, gain: 0.14,
      filter: { type: 'lowpass', freq: 2500 },
      env: { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.08 },
    });
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  itemPickup(position: THREE.Vector3, isPlayer: boolean): void {
    const dest = isPlayer ? this.spatial(null, 8, 40, 1) : this.spatial(position, 8, 40, 0.45);
    if (!dest) return;
    const ctx = this.ctx;
    const now = this.now;
    playTone(ctx, dest, {
      freq: 1320, type: 'sine', duration: 0.25, gain: 0.22, when: now,
      env: { attack: 0.003, decay: 0.2, sustain: 0.15, release: 0.15 },
    });
    playTone(ctx, dest, {
      freq: 1980, type: 'sine', duration: 0.2, gain: 0.09, when: now,
      env: { attack: 0.003, decay: 0.15, sustain: 0.1, release: 0.12 },
    });
    playTone(ctx, dest, { freq: 2637, type: 'sine', duration: 0.08, gain: 0.06, when: now + 0.04, env: { attack: 0.002, decay: 0.06, sustain: 0.1, release: 0.06 } });
    playTone(ctx, dest, { freq: 3136, type: 'sine', duration: 0.08, gain: 0.05, when: now + 0.08, env: { attack: 0.002, decay: 0.06, sustain: 0.1, release: 0.06 } });
  }

  rouletteTick(isPlayer: boolean): void {
    if (!isPlayer || this.disposed) return;
    this.rouletteCount++;
    const dest = this.buses.sfx;
    const f = 900 * (1 + 0.035 * this.rouletteCount);
    playNoiseBurst(this.ctx, dest, {
      duration: 0.015, gain: 0.1,
      filter: { type: 'highpass', freq: 3000 },
      env: { attack: 0.001, decay: 0.012, sustain: 0.1, release: 0.01 },
    });
    playTone(this.ctx, dest, {
      freq: f, type: 'sine', duration: 0.03, gain: 0.08,
      env: { attack: 0.002, decay: 0.02, sustain: 0.3, release: 0.02 },
    });
  }

  rouletteEnd(isPlayer: boolean): void {
    this.rouletteCount = 0;
    if (!isPlayer || this.disposed) return;
    const dest = this.buses.sfx;
    const now = this.now;
    playTone(this.ctx, dest, {
      freq: 1568, type: 'sine', duration: 0.25, gain: 0.18, when: now,
      env: { attack: 0.003, decay: 0.2, sustain: 0.2, release: 0.15 },
    });
    playTone(this.ctx, dest, {
      freq: 2093, type: 'sine', duration: 0.3, gain: 0.16, when: now + 0.06,
      env: { attack: 0.003, decay: 0.25, sustain: 0.2, release: 0.2 },
    });
  }

  itemUse(item: ItemType, position: THREE.Vector3, isPlayer: boolean): void {
    const dest = isPlayer ? this.spatial(null, 8, 45, 1) : this.spatial(position, 8, 45, 0.5);
    if (!dest) return;
    const ctx = this.ctx;
    const now = this.now;
    switch (item) {
      case 'mushroom':
      case 'triple_mushroom':
      case 'golden_mushroom':
        playTone(ctx, dest, {
          freq: 320, endFreq: 160, sweepTime: 0.08, type: 'sine', duration: 0.12, gain: 0.18, when: now,
          env: { attack: 0.005, decay: 0.06, sustain: 0.5, release: 0.04 },
        });
        playTone(ctx, dest, {
          freq: 180, endFreq: 420, type: 'sine', duration: 0.12, gain: 0.14, when: now + 0.1,
          env: { attack: 0.005, decay: 0.06, sustain: 0.5, release: 0.05 },
        });
        break;
      case 'star':
        playChord(ctx, dest, [84, 88, 91, 96], { type: 'sine', gain: 0.07, duration: 0.2, when: now, env: { attack: 0.005, decay: 0.15, sustain: 0.3, release: 0.15 } });
        break;
      case 'lightning':
        playTone(ctx, dest, {
          freq: 120, endFreq: 2200, type: 'square', duration: 0.5, gain: 0.1, when: now,
          filter: { type: 'lowpass', freq: 3000 },
          env: { attack: 0.02, decay: 0.1, sustain: 0.8, release: 0.05 },
        });
        playNoiseBurst(ctx, dest, {
          duration: 0.5, gain: 0.08, rate: 1.5, when: now,
          filter: { type: 'highpass', freq: 2000 },
          env: { attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.05 },
        });
        break;
      case 'none':
        break;
      default:
        // shells, bananas, bob-omb: throw swish
        playNoiseBurst(ctx, dest, {
          duration: 0.22, gain: 0.2, when: now,
          filter: { type: 'bandpass', freq: 900, endFreq: 2600, q: 1 },
          env: { attack: 0.01, decay: 0.15, sustain: 0.3, release: 0.08 },
        });
        break;
    }
  }

  itemHit(item: ItemType, position: THREE.Vector3, isPlayer: boolean): void {
    const dest = isPlayer ? this.spatial(null, 8, 50, 1) : this.spatial(position, 8, 50, 0.7);
    if (!dest) return;
    const ctx = this.ctx;
    playNoiseBurst(ctx, dest, {
      duration: 0.18, gain: isPlayer ? 0.3 : 0.22,
      filter: { type: 'bandpass', freq: item === 'banana' || item === 'triple_banana' ? 700 : 1400, q: 0.8 },
      env: { attack: 0.001, decay: 0.14, sustain: 0.15, release: 0.08 },
    });
    playTone(ctx, dest, {
      freq: 160, endFreq: 70, type: 'sine', duration: 0.15, gain: 0.2,
      env: { attack: 0.002, decay: 0.12, sustain: 0.2, release: 0.05 },
    });
  }

  itemDestroyed(item: ItemType, position: THREE.Vector3): void {
    const dest = this.spatial(position, 8, 45, 0.7);
    if (!dest) return;
    const ctx = this.ctx;
    const now = this.now;
    if (item === 'banana' || item === 'triple_banana') {
      playNoiseBurst(ctx, dest, {
        duration: 0.12, gain: 0.14, color: 'pink',
        filter: { type: 'lowpass', freq: 800 },
        env: { attack: 0.002, decay: 0.1, sustain: 0.2, release: 0.05 },
      });
      return;
    }
    if (item === 'bob_omb') return; // explosion covers it
    for (let k = 0; k < 3; k++) {
      playTone(ctx, dest, {
        freq: 2200 + Math.random() * 1200, type: 'sine', duration: 0.12, gain: 0.07, when: now + k * 0.02,
        env: { attack: 0.001, decay: 0.1, sustain: 0.05, release: 0.08 },
      });
    }
    playNoiseBurst(ctx, dest, {
      duration: 0.08, gain: 0.1, when: now,
      filter: { type: 'highpass', freq: 3000 },
      env: { attack: 0.001, decay: 0.06, sustain: 0.1, release: 0.04 },
    });
  }

  shellBounce(position: THREE.Vector3): void {
    const dest = this.spatial(position, 8, 45, 0.7);
    if (!dest) return;
    playTone(this.ctx, dest, {
      freq: 1900, endFreq: 1300, type: 'sine', duration: 0.07, gain: 0.14,
      env: { attack: 0.001, decay: 0.05, sustain: 0.2, release: 0.04 },
    });
    playNoiseBurst(this.ctx, dest, {
      duration: 0.03, gain: 0.08,
      filter: { type: 'highpass', freq: 4000 },
      env: { attack: 0.001, decay: 0.025, sustain: 0.1, release: 0.02 },
    });
  }

  explosion(position: THREE.Vector3, radius: number): void {
    const dest = this.spatial(position, 14, 140, 1);
    if (!dest) return;
    const ctx = this.ctx;
    const now = this.now;
    const s = 0.8 + clamp01(radius / 6) * 0.4;
    playNoiseBurst(ctx, dest, {
      duration: 0.02, gain: 0.3 * s, when: now,
      filter: { type: 'highpass', freq: 3000 },
      env: { attack: 0.001, decay: 0.015, sustain: 0.1, release: 0.01 },
    });
    playTone(ctx, dest, {
      freq: 85, endFreq: 28, type: 'sine', duration: 0.6, gain: 0.6 * s, when: now,
      env: { attack: 0.005, decay: 0.4, sustain: 0.3, release: 0.3 },
    });
    playNoiseBurst(ctx, dest, {
      duration: 0.55, gain: 0.5 * s, when: now,
      filter: { type: 'lowpass', freq: 1400, endFreq: 180 },
      env: { attack: 0.003, decay: 0.4, sustain: 0.25, release: 0.3 },
    });
    playNoiseBurst(ctx, dest, {
      duration: 1.0, gain: 0.2 * s, color: 'brown', when: now + 0.1,
      filter: { type: 'lowpass', freq: 400 },
      env: { attack: 0.05, decay: 0.6, sustain: 0.4, release: 0.5 },
    });
  }

  lightning(): void {
    if (this.disposed) return;
    const dest = this.buses.sfx;
    const ctx = this.ctx;
    const now = this.now;
    playNoiseBurst(ctx, dest, {
      duration: 0.35, gain: 0.55, when: now,
      filter: { type: 'highpass', freq: 1200, endFreq: 250 },
      env: { attack: 0.001, decay: 0.25, sustain: 0.2, release: 0.15 },
    });
    playTone(ctx, dest, {
      freq: 3000, endFreq: 200, type: 'square', duration: 0.15, gain: 0.12, when: now,
      filter: { type: 'lowpass', freq: 4000 },
      env: { attack: 0.001, decay: 0.12, sustain: 0.1, release: 0.05 },
    });
    playNoiseBurst(ctx, dest, {
      duration: 1.4, gain: 0.4, color: 'brown', when: now + 0.05,
      filter: { type: 'lowpass', freq: 160 },
      env: { attack: 0.02, decay: 0.9, sustain: 0.4, release: 0.5 },
    });
  }

  boxRespawn(position: THREE.Vector3): void {
    const dest = this.spatial(position, 8, 35, 0.5);
    if (!dest) return;
    playTone(this.ctx, dest, {
      freq: 880, endFreq: 1320, type: 'sine', duration: 0.1, gain: 0.08,
      env: { attack: 0.005, decay: 0.08, sustain: 0.3, release: 0.08 },
    });
  }

  blueShellLaunch(): void {
    if (this.disposed) return;
    const dest = this.buses.sfx;
    const ctx = this.ctx;
    const now = this.now;
    for (let k = 0; k < 3; k++) {
      const t = now + k * 0.26;
      playTone(ctx, dest, {
        freq: 600, endFreq: 900, type: 'square', duration: 0.12, gain: 0.09, when: t,
        filter: { type: 'lowpass', freq: 2500 },
        env: { attack: 0.005, decay: 0.05, sustain: 0.7, release: 0.03 },
      });
      playTone(ctx, dest, {
        freq: 900, endFreq: 600, type: 'square', duration: 0.12, gain: 0.09, when: t + 0.13,
        filter: { type: 'lowpass', freq: 2500 },
        env: { attack: 0.005, decay: 0.05, sustain: 0.7, release: 0.03 },
      });
    }
    playNoiseBurst(ctx, dest, {
      duration: 0.6, gain: 0.15, when: now,
      filter: { type: 'bandpass', freq: 600, endFreq: 2000, q: 1 },
      env: { attack: 0.05, decay: 0.3, sustain: 0.4, release: 0.2 },
    });
  }

  // -------------------------------------------------------------------------
  // Race flow
  // -------------------------------------------------------------------------

  countdown(count: number): void {
    if (this.disposed) return;
    const dest = this.buses.sfx;
    const f = count <= 1 ? 880 : 740;
    playTone(this.ctx, dest, {
      freq: f, type: 'square', duration: 0.16, gain: 0.11,
      filter: { type: 'lowpass', freq: 3000 },
      env: { attack: 0.003, decay: 0.05, sustain: 0.7, release: 0.06 },
    });
    playTone(this.ctx, dest, {
      freq: f, type: 'sine', duration: 0.16, gain: 0.14,
      env: { attack: 0.003, decay: 0.05, sustain: 0.7, release: 0.06 },
    });
  }

  raceStart(): void {
    if (this.disposed) return;
    const dest = this.buses.sfx;
    const ctx = this.ctx;
    const now = this.now;
    playChord(ctx, dest, [72, 76, 79, 84], {
      type: 'square', gain: 0.08, duration: 0.55, when: now,
      filter: { type: 'lowpass', freq: 3500 },
      env: { attack: 0.005, decay: 0.15, sustain: 0.6, release: 0.3 },
    });
    playChord(ctx, dest, [60, 67], {
      type: 'sawtooth', gain: 0.07, duration: 0.55, when: now,
      filter: { type: 'lowpass', freq: 1800 },
      env: { attack: 0.005, decay: 0.15, sustain: 0.6, release: 0.3 },
    });
    playTone(ctx, dest, {
      freq: 150, endFreq: 50, type: 'sine', duration: 0.2, gain: 0.3, when: now,
      env: { attack: 0.002, decay: 0.15, sustain: 0.2, release: 0.08 },
    });
  }

  lap(kartId: number, isPlayer: boolean, isFinalLap: boolean): void {
    if (!isPlayer) return;
    if (this.disposed) return;
    const dest = this.buses.sfx;
    const ctx = this.ctx;
    const now = this.now;
    const bell = (f: number, gain: number, when: number): void => {
      playTone(ctx, dest, { freq: f, type: 'sine', duration: 0.01, gain, when, env: { attack: 0.002, decay: 0.6, sustain: 0.001, release: 0.2 } });
      playTone(ctx, dest, { freq: f * 2.0, type: 'sine', duration: 0.01, gain: gain * 0.3, when, env: { attack: 0.002, decay: 0.4, sustain: 0.001, release: 0.15 } });
      playTone(ctx, dest, { freq: f * 2.76, type: 'sine', duration: 0.01, gain: gain * 0.22, when, env: { attack: 0.002, decay: 0.3, sustain: 0.001, release: 0.1 } });
    };
    bell(1568, 0.2, now);
    if (isFinalLap) {
      bell(2093, 0.16, now + 0.18);
      playSequence(ctx, dest, [[72, 0.12], [76, 0.12], [79, 0.12], [84, 0.45]], {
        type: 'square', gain: 0.1, when: now + 0.3,
        filter: { type: 'lowpass', freq: 3000 },
        env: { attack: 0.005, decay: 0.05, sustain: 0.7, release: 0.08 },
      });
      playSequence(ctx, dest, [[67, 0.12], [72, 0.12], [76, 0.12], [79, 0.45]], {
        type: 'sawtooth', gain: 0.06, when: now + 0.3,
        filter: { type: 'lowpass', freq: 2200 },
        env: { attack: 0.005, decay: 0.05, sustain: 0.7, release: 0.08 },
      });
    }
  }

  finish(kartId: number, place: number, isPlayer: boolean): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    const now = this.now;
    if (!isPlayer) {
      const dest = this.spatial(this.kartPosition(kartId), 10, 60, 0.4);
      if (!dest) return;
      playTone(ctx, dest, { freq: 1046, endFreq: 1568, type: 'sine', duration: 0.2, gain: 0.1, when: now, env: { attack: 0.005, decay: 0.15, sustain: 0.3, release: 0.1 } });
      return;
    }
    const dest = this.buses.sfx;
    const brass = { type: 'square' as OscillatorType, gain: 0.11, filter: { type: 'lowpass' as BiquadFilterType, freq: 2800 }, env: { attack: 0.01, decay: 0.08, sustain: 0.75, release: 0.1 } };
    if (place === 1) {
      playSequence(ctx, dest, [[67, 0.14], [67, 0.14], [67, 0.14], [72, 0.5], [76, 0.2], [79, 0.7]], { ...brass, when: now });
      playSequence(ctx, dest, [[60, 0.14], [60, 0.14], [60, 0.14], [64, 0.5], [67, 0.2], [72, 0.7]], { ...brass, gain: 0.07, type: 'sawtooth', when: now });
      playChord(ctx, dest, [72, 76, 79, 84], { type: 'sawtooth', gain: 0.06, duration: 1.3, when: now + 1.85, detune: 8, filter: { type: 'lowpass', freq: 2400 }, env: { attack: 0.02, decay: 0.3, sustain: 0.7, release: 0.6 } });
      playTone(ctx, dest, { freq: 1568, type: 'sine', duration: 0.01, gain: 0.15, when: now + 1.85, env: { attack: 0.002, decay: 0.8, sustain: 0.001, release: 0.3 } });
    } else if (place <= 3) {
      playSequence(ctx, dest, [[72, 0.15], [76, 0.15], [79, 0.15], [84, 0.55]], { ...brass, when: now });
      playChord(ctx, dest, [72, 76, 79], { type: 'sawtooth', gain: 0.06, duration: 0.9, when: now + 0.5, detune: 8, filter: { type: 'lowpass', freq: 2400 }, env: { attack: 0.02, decay: 0.3, sustain: 0.7, release: 0.5 } });
    } else {
      playSequence(ctx, dest, [[67, 0.32], [65, 0.32], [63, 0.32], [60, 0.95]], {
        type: 'sawtooth', gain: 0.11, when: now,
        vibrato: { rate: 6, depth: 45 },
        filter: { type: 'lowpass', freq: 1200, endFreq: 500 },
        env: { attack: 0.03, decay: 0.1, sustain: 0.8, release: 0.15 },
      });
      playSequence(ctx, dest, [[55, 0.32], [53, 0.32], [51, 0.32], [48, 0.95]], {
        type: 'square', gain: 0.05, when: now,
        filter: { type: 'lowpass', freq: 900 },
        env: { attack: 0.03, decay: 0.1, sustain: 0.8, release: 0.15 },
      });
    }
  }

  positionChange(from: number, to: number): void {
    if (this.disposed) return;
    const gained = to < from;
    playTone(this.ctx, this.buses.sfx, {
      freq: gained ? 600 : 1200, endFreq: gained ? 1200 : 600, type: 'sine', duration: 0.12, gain: 0.11,
      env: { attack: 0.005, decay: 0.08, sustain: 0.4, release: 0.08 },
    });
    playNoiseBurst(this.ctx, this.buses.sfx, {
      duration: 0.12, gain: 0.06,
      filter: { type: 'bandpass', freq: gained ? 1200 : 2400, endFreq: gained ? 2400 : 1200, q: 1.5 },
      env: { attack: 0.01, decay: 0.08, sustain: 0.3, release: 0.06 },
    });
  }

  wrongWay(kartId: number, wrongWay: boolean): void {
    if (!wrongWay || !this.isPlayer(kartId) || this.disposed) return;
    const now = this.now;
    if (now - this.lastWrongWay < 1.0) return;
    this.lastWrongWay = now;
    playTone(this.ctx, this.buses.sfx, {
      freq: 110, type: 'square', duration: 0.25, gain: 0.11,
      filter: { type: 'lowpass', freq: 700 },
      env: { attack: 0.005, decay: 0.05, sustain: 0.8, release: 0.05 },
    });
  }

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  uiMove(): void {
    if (this.disposed) return;
    playTone(this.ctx, this.buses.ui, {
      freq: 1200, type: 'sine', duration: 0.035, gain: 0.12,
      env: { attack: 0.002, decay: 0.02, sustain: 0.3, release: 0.03 },
    });
  }

  uiSelect(): void {
    if (this.disposed) return;
    const now = this.now;
    playTone(this.ctx, this.buses.ui, { freq: 880, type: 'sine', duration: 0.06, gain: 0.13, when: now, env: { attack: 0.002, decay: 0.04, sustain: 0.5, release: 0.04 } });
    playTone(this.ctx, this.buses.ui, { freq: 1320, type: 'sine', duration: 0.12, gain: 0.14, when: now + 0.06, env: { attack: 0.002, decay: 0.08, sustain: 0.4, release: 0.08 } });
  }

  uiBack(): void {
    if (this.disposed) return;
    playTone(this.ctx, this.buses.ui, {
      freq: 660, endFreq: 440, type: 'sine', duration: 0.12, gain: 0.1,
      env: { attack: 0.003, decay: 0.08, sustain: 0.4, release: 0.06 },
    });
  }

  uiError(): void {
    if (this.disposed) return;
    const now = this.now;
    for (let k = 0; k < 2; k++) {
      playTone(this.ctx, this.buses.ui, {
        freq: 220, type: 'square', duration: 0.08, gain: 0.08, when: now + k * 0.12,
        filter: { type: 'lowpass', freq: 1200 },
        env: { attack: 0.003, decay: 0.03, sustain: 0.8, release: 0.03 },
      });
    }
  }
}

export { midiToFreq };
