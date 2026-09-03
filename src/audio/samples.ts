/**
 * Recorded audio layer.
 *
 * The synthesised bank in sfx.ts still covers everything; this module plays real
 * recordings on top of the same events for the sounds where a sample simply
 * reads better than an oscillator (impacts, item pickups, UI clicks, the
 * countdown), and tells the synth bank which events to leave alone.
 *
 * Sound effects: Kenney (kenney.nl), CC0 1.0.
 * Music: the FreePD archive (archive.org/details/freepd), CC0 1.0.
 *
 * Every file is optional. If a fetch or decode fails the sample is simply
 * absent, the event stays with the synth bank, and the game sounds the same as
 * it did before - nothing here can break audio.
 */
import * as THREE from 'three';
import type { IKart, MusicTrack } from '../core/types';
import { events } from '../core/events';
import { clamp01 } from '../core/math';
import type { ListenerFrame } from './sfx';

export const AUDIO_CREDITS = [
  'Sound effects - Kenney (kenney.nl), CC0 1.0 Public Domain',
  'Music - the FreePD archive (archive.org/details/freepd), CC0 1.0 Public Domain',
];

const BASE = import.meta.env.BASE_URL ?? '/';
const sfxUrl = (name: string): string => `${BASE}audio/sfx/${name}.ogg`;
const musicUrl = (name: string): string => `${BASE}audio/music/${name}.mp3`;

/** Sample files pulled in at boot. Names match the files under public/audio/sfx. */
const SFX_FILES = [
  'boost', 'bounce', 'countdown_go', 'countdown_tick', 'explode', 'explode_low',
  'final_lap', 'hit', 'hit_metal', 'hop', 'item_get', 'land', 'lap', 'lose',
  'miniturbo', 'mt_charge1', 'mt_charge2', 'mt_charge3', 'race_start', 'respawn',
  'rocket', 'shockwave', 'star', 'throw', 'ui_back', 'ui_click', 'ui_confirm',
  'ui_error', 'ui_hover', 'ui_open', 'wall', 'warning', 'win',
] as const;

export type SfxName = (typeof SFX_FILES)[number];

/**
 * Event names the recorded layer takes over. SfxBank skips exactly these, so a
 * sound is never played twice; anything not listed here stays synthesised.
 */
export const SAMPLED_EVENTS: readonly string[] = [
  'kart:hop',
  'kart:land',
  'kart:boost',
  'kart:driftStage',
  'item:pickup',
  'item:rouletteEnd',
  'item:use',
  'item:hit',
  'item:explosion',
  'race:countdown',
  'race:start',
  'race:lap',
  'race:finish',
  'ui:move',
  'ui:select',
  'ui:back',
  'ui:error',
];

/** Distance at which a positional sample is inaudible. */
const MAX_DISTANCE = 90;

export class SampleBank {
  private readonly buffers = new Map<string, AudioBuffer>();
  private loaded = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly dest: AudioNode,
    private readonly uiDest: AudioNode,
  ) {}

  /** Fetches and decodes every sample. Failures are logged once and ignored. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const missing: string[] = [];
    await Promise.all(
      SFX_FILES.map(async (name) => {
        try {
          const res = await fetch(sfxUrl(name));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = await res.arrayBuffer();
          this.buffers.set(name, await this.ctx.decodeAudioData(bytes));
        } catch {
          missing.push(name);
        }
      }),
    );
    if (missing.length) console.warn(`[audio] ${missing.length} sample(s) unavailable, using synthesis:`, missing.join(', '));
  }

  has(name: SfxName): boolean {
    return this.buffers.has(name);
  }

  /** Centred, full-volume playback (player and UI sounds). */
  play(name: SfxName, gain = 1, rate = 1, ui = false): void {
    const buf = this.buffers.get(name);
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(ui ? this.uiDest : this.dest);
    src.start();
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
  }

  /** Attenuated and panned from the listener frame. */
  playAt(name: SfxName, pos: THREE.Vector3, listener: ListenerFrame, gain = 1, rate = 1): void {
    const buf = this.buffers.get(name);
    if (!buf) return;
    const dx = pos.x - listener.pos.x;
    const dy = pos.y - listener.pos.y;
    const dz = pos.z - listener.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > MAX_DISTANCE) return;
    const atten = clamp01(1 - dist / MAX_DISTANCE);
    const level = gain * atten * atten;
    if (level < 0.01) return;
    const side = dist > 0.001 ? (dx * listener.right.x + dy * listener.right.y + dz * listener.right.z) / dist : 0;

    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, side));
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(panner);
    panner.connect(g);
    g.connect(this.dest);
    src.start();
    src.onended = () => {
      src.disconnect();
      panner.disconnect();
      g.disconnect();
    };
  }

  dispose(): void {
    this.buffers.clear();
  }
}

/** Subscribes to the game events that the recorded layer owns. */
export class SampledSfx {
  private readonly unsubs: (() => void)[] = [];
  /** Set by AudioEngine each frame so positional sounds can be placed. */
  karts: readonly IKart[] = [];
  playerKartId = 0;

  constructor(
    private readonly bank: SampleBank,
    private readonly listener: ListenerFrame,
  ) {
    const u = this.unsubs;
    const at = (kartId: number): THREE.Vector3 | null => {
      for (let i = 0; i < this.karts.length; i++) {
        if (this.karts[i].state.id === kartId) return this.karts[i].state.position;
      }
      return null;
    };
    const isPlayer = (kartId: number): boolean => kartId === this.playerKartId;
    /** Plays centred for the player, positional for anyone else. */
    const emit = (name: SfxName, kartId: number, gain = 1, rate = 1): void => {
      if (isPlayer(kartId)) {
        this.bank.play(name, gain, rate);
        return;
      }
      const p = at(kartId);
      if (p) this.bank.playAt(name, p, this.listener, gain * 0.8, rate);
    };

    u.push(events.on('kart:hop', (e) => emit('hop', e.kartId, 0.5)));
    u.push(events.on('kart:land', (e) => emit('land', e.kartId, 0.3 + clamp01(e.impact) * 0.6)));
    u.push(events.on('kart:driftStage', (e) => {
      const name: SfxName = e.stage >= 3 ? 'mt_charge3' : e.stage === 2 ? 'mt_charge2' : 'mt_charge1';
      emit(name, e.kartId, 0.55);
    }));
    u.push(events.on('kart:boost', (e) => {
      const name: SfxName = e.source === 'drift' ? 'miniturbo' : e.source === 'star' ? 'star' : 'boost';
      emit(name, e.kartId, 0.7);
    }));
    u.push(events.on('item:pickup', (e) => {
      if (e.isPlayer) this.bank.play('item_get', 0.8);
      else this.bank.playAt('item_get', e.position, this.listener, 0.45);
    }));
    u.push(events.on('item:rouletteEnd', (e) => {
      if (e.isPlayer) this.bank.play('ui_confirm', 0.7, 1.2, true);
    }));
    u.push(events.on('item:use', (e) => {
      const name: SfxName = e.item === 'mushroom' || e.item === 'triple_mushroom' || e.item === 'golden_mushroom'
        ? 'boost'
        : e.item === 'star'
          ? 'star'
          : e.item === 'lightning'
            ? 'shockwave'
            : e.item === 'blue_shell'
              ? 'rocket'
              : 'throw';
      if (e.isPlayer) this.bank.play(name, 0.75);
      else this.bank.playAt(name, e.position, this.listener, 0.5);
    }));
    u.push(events.on('item:hit', (e) => {
      const name: SfxName = e.item === 'banana' || e.item === 'triple_banana' ? 'bounce' : 'hit';
      if (e.isPlayer) this.bank.play(name, 0.9);
      else this.bank.playAt(name, e.position, this.listener, 0.6);
    }));
    u.push(events.on('item:explosion', (e) => {
      const name: SfxName = e.radius > 6 ? 'explode_low' : 'explode';
      this.bank.playAt(name, e.position, this.listener, 0.9);
    }));
    u.push(events.on('race:countdown', (e) => {
      this.bank.play(e.count > 0 ? 'countdown_tick' : 'countdown_go', 0.85, 1, true);
    }));
    u.push(events.on('race:start', () => this.bank.play('race_start', 0.8, 1, true)));
    u.push(events.on('race:lap', (e) => {
      if (!e.isPlayer) return;
      this.bank.play(e.isFinalLap ? 'final_lap' : 'lap', 0.8, 1, true);
    }));
    u.push(events.on('race:finish', (e) => {
      if (!e.isPlayer) return;
      this.bank.play(e.place <= 3 ? 'win' : 'lose', 0.85, 1, true);
    }));
    u.push(events.on('ui:move', () => this.bank.play('ui_hover', 0.6, 1, true)));
    u.push(events.on('ui:select', () => this.bank.play('ui_confirm', 0.7, 1, true)));
    u.push(events.on('ui:back', () => this.bank.play('ui_back', 0.6, 1, true)));
    u.push(events.on('ui:error', () => this.bank.play('ui_error', 0.7, 1, true)));
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Streamed music
// ---------------------------------------------------------------------------

/** Circuit id -> music file. Unknown circuits fall back to the first entry. */
const CIRCUIT_MUSIC: Record<string, string> = {
  menara: 'marrakech',
  merzouga: 'souk',
  agadir: 'coast',
  atlas: 'atlas',
  jbel: 'volcano',
  casa_neon: 'skyspiral',
};

const CROSSFADE = 1.2;

interface Deck {
  el: HTMLAudioElement;
  gain: GainNode;
  src: MediaElementAudioSourceNode;
  file: string;
}

/**
 * Two-deck crossfading player for the downloaded music. `ok` reports whether a
 * file actually started; AudioEngine falls back to the procedural sequencer when
 * it does not, so the game is never silent.
 */
export class StreamMusic {
  private decks: (Deck | null)[] = [null, null];
  private active = 0;
  private circuit = 'menara';
  private current: MusicTrack = 'none';
  private disposed = false;
  /** False until a deck has actually produced audio. */
  ok = false;
  /** Fired once, the first time a file starts playing. */
  onReady: (() => void) | null = null;
  /** Fired when a file fails to start and there is no streamed music to be had. */
  onFail: (() => void) | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly dest: AudioNode,
  ) {}

  setCircuit(trackId: string): void {
    this.circuit = trackId;
  }

  get track(): MusicTrack {
    return this.current;
  }

  play(track: MusicTrack): void {
    if (this.disposed || track === this.current) return;
    if (track === 'none') {
      this.stop();
      return;
    }
    const file =
      track === 'menu'
        ? 'menu'
        : track === 'results'
          ? 'results'
          : (CIRCUIT_MUSIC[this.circuit] ?? 'marrakech');
    // The final lap is the same circuit track played hot, the way arcade racers do it.
    const rate = track === 'finalLap' ? 1.14 : 1;
    this.current = track;

    const currentDeck = this.decks[this.active];
    if (currentDeck && currentDeck.file === file) {
      currentDeck.el.playbackRate = rate;
      return;
    }
    this.crossfadeTo(file, rate);
  }

  stop(): void {
    this.current = 'none';
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.decks.length; i++) {
      const d = this.decks[i];
      if (!d) continue;
      d.gain.gain.cancelScheduledValues(now);
      d.gain.gain.setValueAtTime(d.gain.gain.value, now);
      d.gain.gain.linearRampToValueAtTime(0, now + 0.4);
      const el = d.el;
      window.setTimeout(() => el.pause(), 500);
    }
  }

  private crossfadeTo(file: string, rate: number): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const old = this.decks[this.active];
    if (old) {
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now + CROSSFADE);
      const el = old.el;
      window.setTimeout(() => el.pause(), (CROSSFADE + 0.2) * 1000);
    }
    this.active = 1 - this.active;
    const slot = this.active;
    const prev = this.decks[slot];
    if (prev) {
      prev.el.pause();
      prev.src.disconnect();
      prev.gain.disconnect();
    }

    const el = new Audio(musicUrl(file));
    el.loop = true;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.playbackRate = rate;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    let src: MediaElementAudioSourceNode;
    try {
      src = ctx.createMediaElementSource(el);
    } catch (err) {
      console.warn('[audio] could not route music through the mixer', err);
      return;
    }
    src.connect(gain);
    gain.connect(this.dest);
    this.decks[slot] = { el, gain, src, file };

    el.play().then(
      () => {
        if (this.disposed || this.decks[slot]?.el !== el) return;
        const first = !this.ok;
        this.ok = true;
        const t = ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(1, t + CROSSFADE);
        if (first) this.onReady?.();
      },
      (err: unknown) => {
        console.warn(`[audio] music "${file}" could not play; using the synthesised score`, err);
        if (!this.ok) this.onFail?.();
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    for (let i = 0; i < this.decks.length; i++) {
      const d = this.decks[i];
      if (!d) continue;
      d.el.pause();
      d.el.src = '';
      d.src.disconnect();
      d.gain.disconnect();
      this.decks[i] = null;
    }
  }
}
