/**
 * AudioEngine - the public audio facade. Owns the AudioContext and bus graph
 * (master → compressor → destination; music / sfx / engines / ui sub-buses),
 * per-kart engine voices, the event-driven SFX bank, crowd ambience, the music
 * player and the star jingle.
 *
 * Two layers sit side by side: synthesis for the continuous sounds (engines,
 * crowd, drift) and downloaded CC0 recordings for the discrete ones (impacts,
 * pickups, UI, countdown) plus the streamed music. If a download fails the synth
 * layer covers it, so the game always has audio.
 */
import * as THREE from 'three';
import type { IAudioEngine, IKart, MusicTrack } from '../core/types';
import { events } from '../core/events';
import { clamp01 } from '../core/math';
import { KART_COUNT } from '../core/constants';
import { dbToGain, softClipCurve } from './synth';
import { EngineVoice, setListenerPose } from './engine';
import { Crowd, SfxBank } from './sfx';
import { MusicPlayer, Sequencer, buildStarJingle, warmMusic } from './music';
import { SAMPLED_EVENTS, SampleBank, SampledSfx, StreamMusic } from './samples';

const MUSIC_BUS_DB = -6;
const ENGINES_BUS_GAIN = 0.85;
const UI_BUS_GAIN = 0.5;
const STAR_DUCK_DB = -8;
const LIGHTNING_DUCK_DB = -10;
const LIGHTNING_DUCK_SECONDS = 1.0;
const STAR_AUDIBLE_DISTANCE = 25;
const RICH_VOICE_COUNT = 4;
const VOICE_TIER_INTERVAL = 0.5;
/** Engine voice slots are indexed by kart id (ids are 0..KART_COUNT-1). */
const MAX_VOICES = Math.max(KART_COUNT, 16);

interface VoiceSlot {
  voice: EngineVoice;
  lastSeen: number;
  distance: number;
}

export class AudioEngine implements IAudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private musicBus: GainNode | null = null;
  private musicDuck: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private enginesBus: GainNode | null = null;
  private enginesClip: WaveShaperNode | null = null;
  private uiBus: GainNode | null = null;

  private sfx: SfxBank | null = null;
  private samples: SampleBank | null = null;
  private sampled: SampledSfx | null = null;
  private music: MusicPlayer | null = null;
  private stream: StreamMusic | null = null;
  private circuitId = '';
  /** Which score is in charge. 'unknown' while the first stream request is in flight. */
  private musicMode: 'unknown' | 'stream' | 'synth' = 'unknown';
  private crowd: Crowd | null = null;
  private starJingle: Sequencer | null = null;

  /** Dense array indexed by kart id; null = no voice. Iterated without allocating. */
  private readonly engines: (VoiceSlot | null)[] = new Array<VoiceSlot | null>(MAX_VOICES).fill(null);
  private frame = 0;
  private voiceTierTimer = 0;

  private _ready = false;
  private _muted = false;
  private masterVolume = 1;
  private pendingTrack: MusicTrack = 'none';
  /** 1 while kart id has an active star (from events); cleared when the kart disappears or the star ends. */
  private readonly starFlags = new Uint8Array(MAX_VOICES);
  private lightningDuck = 0;
  private lastDuckDb = 0;
  private disposed = false;
  private initPromise: Promise<void> | null = null;

  private readonly unsubs: (() => void)[] = [];
  private readonly camPos = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();
  private readonly camUp = new THREE.Vector3();
  private readonly camRight = new THREE.Vector3();

  constructor() {
    const u = this.unsubs;
    u.push(events.on('kart:starStart', (e) => { if (e.kartId >= 0 && e.kartId < MAX_VOICES) this.starFlags[e.kartId] = 1; }));
    u.push(events.on('kart:starEnd', (e) => { if (e.kartId >= 0 && e.kartId < MAX_VOICES) this.starFlags[e.kartId] = 0; }));
    u.push(events.on('item:lightning', () => { this.lightningDuck = LIGHTNING_DUCK_SECONDS; }));
    u.push(events.on('race:lap', (e) => {
      if (!e.isPlayer) return;
      this.crowd?.cheerBurst(0.5);
      if (e.isFinalLap && this.music && this.music.track === 'race') this.playMusic('finalLap');
    }));
    u.push(events.on('race:start', () => this.crowd?.cheerBurst(1)));
    u.push(events.on('race:finish', (e) => { if (e.isPlayer) this.crowd?.cheerBurst(1); }));
  }

  get ready(): boolean {
    return this._ready;
  }

  get muted(): boolean {
    return this._muted;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (!this.ctx) {
      const Ctor = (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctor) {
        console.warn('[AudioEngine] Web Audio API unavailable');
        return;
      }
      try {
        const ctx = new Ctor({ latencyHint: 'interactive' });
        this.ctx = ctx;
        this.buildGraph(ctx);
      } catch (err) {
        console.warn('[AudioEngine] failed to create AudioContext', err);
        this.ctx = null;
        return;
      }
    }
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch (err) {
        console.warn('[AudioEngine] resume failed (needs a user gesture)', err);
      }
    }
    if (ctx.state === 'running' && !this._ready && !this.disposed) {
      this._ready = true;
      if (this.pendingTrack !== 'none') this.playMusic(this.pendingTrack);
    }
  }

  private buildGraph(ctx: AudioContext): void {
    // master → glue compressor → brickwall-ish limiter → destination
    const master = ctx.createGain();
    master.gain.value = this._muted ? 0 : this.masterVolume;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 20;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    master.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(ctx.destination);

    const bus = (gain: number, dest: AudioNode): GainNode => {
      const g = ctx.createGain();
      g.gain.value = gain;
      g.connect(dest);
      return g;
    };
    const musicDuck = bus(1, master);
    const musicBus = bus(dbToGain(MUSIC_BUS_DB), musicDuck);
    const sfxBus = bus(1, master);
    // Eight engine loops sum on this bus; a tanh stage keeps the sum from ever
    // hard-clipping regardless of how many karts crowd the camera.
    const enginesClip = ctx.createWaveShaper();
    enginesClip.curve = softClipCurve(1.6, 2048);
    enginesClip.oversample = 'none';
    enginesClip.connect(master);
    const enginesBus = bus(ENGINES_BUS_GAIN, enginesClip);
    const uiBus = bus(UI_BUS_GAIN, master);

    this.master = master;
    this.compressor = compressor;
    this.limiter = limiter;
    this.musicDuck = musicDuck;
    this.musicBus = musicBus;
    this.sfxBus = sfxBus;
    this.enginesBus = enginesBus;
    this.enginesClip = enginesClip;
    this.uiBus = uiBus;
    this.lastDuckDb = 0;

    warmMusic(ctx);
    // The recorded layer claims its events up front; the synth bank skips those
    // even while the files are still downloading, so nothing double-triggers
    // once they land mid-session.
    this.sfx = new SfxBank(ctx, { sfx: sfxBus, ui: uiBus }, SAMPLED_EVENTS);
    this.samples = new SampleBank(ctx, sfxBus, uiBus);
    this.sampled = new SampledSfx(this.samples, this.sfx.listener);
    this.music = new MusicPlayer(ctx, musicBus);
    this.stream = new StreamMusic(ctx, musicBus);
    this.stream.setCircuit(this.circuitId || 'menara');
    this.stream.onReady = () => {
      this.musicMode = 'stream';
      this.music?.stop();
    };
    this.stream.onFail = () => {
      if (this.musicMode === 'stream') return;
      this.musicMode = 'synth';
      if (this.pendingTrack !== 'none') this.music?.play(this.pendingTrack);
    };
    this.crowd = new Crowd(ctx, sfxBus);
    void this.samples.load();
  }

  /**
   * Suspends the AudioContext when the tab/app goes to the background and
   * resumes it when it comes back, independent of the player's own mute
   * toggle - `_muted` is untouched, so returning to the tab restores whatever
   * the player had before, muted or not. Web Audio keeps rendering in a
   * hidden tab unless something explicitly suspends it, which is what left
   * music and engine sound running after switching away.
   */
  setBackgrounded(hidden: boolean): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    if (hidden) {
      if (ctx.state === 'running') void ctx.suspend().catch(() => {});
    } else if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    for (let i = 0; i < this.engines.length; i++) {
      const slot = this.engines[i];
      if (slot) slot.voice.dispose();
      this.engines[i] = null;
    }
    this.starFlags.fill(0);
    this.music?.dispose();
    this.music = null;
    this.stream?.dispose();
    this.stream = null;
    this.sampled?.dispose();
    this.sampled = null;
    this.samples?.dispose();
    this.samples = null;
    this.starJingle?.dispose();
    this.starJingle = null;
    this.crowd?.dispose();
    this.crowd = null;
    this.sfx?.dispose();
    this.sfx = null;
    const ctx = this.ctx;
    this.ctx = null;
    this._ready = false;
    if (ctx) {
      // Let the short fade-outs finish before the context goes away.
      const close = (): void => {
        ctx.close().catch(() => undefined);
      };
      setTimeout(close, 400);
    }
    this.master = null;
    this.compressor = null;
    this.limiter = null;
    this.musicBus = null;
    this.musicDuck = null;
    this.sfxBus = null;
    this.enginesBus = null;
    this.enginesClip = null;
    this.uiBus = null;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  update(dt: number, karts: readonly IKart[], playerKartId: number, camera: THREE.Camera): void {
    const ctx = this.ctx;
    if (!this._ready || !ctx || this.disposed || !this.sfx || !this.enginesBus) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    const now = ctx.currentTime;
    this.frame++;

    // --- listener from the camera -------------------------------------------
    const e = camera.matrixWorld.elements;
    this.camPos.set(e[12], e[13], e[14]);
    this.camFwd.set(-e[8], -e[9], -e[10]).normalize();
    this.camUp.set(e[4], e[5], e[6]).normalize();
    this.camRight.crossVectors(this.camFwd, this.camUp).normalize();
    setListenerPose(
      ctx.listener,
      this.camPos.x, this.camPos.y, this.camPos.z,
      this.camFwd.x, this.camFwd.y, this.camFwd.z,
      this.camUp.x, this.camUp.y, this.camUp.z,
    );
    const L = this.sfx.listener;
    L.pos.copy(this.camPos);
    L.forward.copy(this.camFwd);
    L.up.copy(this.camUp);
    L.right.copy(this.camRight);
    this.sfx.karts = karts;
    this.sfx.playerKartId = playerKartId;
    if (this.sampled) {
      this.sampled.karts = karts;
      this.sampled.playerKartId = playerKartId;
    }

    // --- engines ---------------------------------------------------------------
    const engines = this.engines;
    let playerKart: IKart | null = null;
    for (let i = 0; i < karts.length; i++) {
      const kart = karts[i];
      const st = kart.state;
      const id = st.id;
      if (id === playerKartId) playerKart = kart;
      if (id < 0 || id >= MAX_VOICES) continue;
      const isPlayer = id === playerKartId || st.isPlayer;
      let slot = engines[id];
      if (!slot) {
        slot = {
          voice: new EngineVoice(ctx, this.enginesBus, id, st.character.weightClass, isPlayer),
          lastSeen: this.frame,
          distance: 0,
        };
        engines[id] = slot;
      }
      slot.lastSeen = this.frame;
      slot.distance = st.position.distanceTo(this.camPos);
      slot.voice.update(dt, st, kart.input.throttle, kart.topSpeed());
    }
    // Tear down voices for karts that are gone (race disposed, menu, etc.).
    for (let i = 0; i < engines.length; i++) {
      const slot = engines[i];
      if (slot && slot.lastSeen !== this.frame) {
        slot.voice.dispose();
        engines[i] = null;
      }
    }

    this.voiceTierTimer -= dt;
    if (this.voiceTierTimer <= 0) {
      this.voiceTierTimer = VOICE_TIER_INTERVAL;
      this.assignVoiceTiers();
    }

    // --- star jingle + music ducking ------------------------------------------
    let starAudible = false;
    const flags = this.starFlags;
    for (let id = 0; id < flags.length; id++) {
      if (flags[id] === 0) continue;
      const kart = findKart(karts, id);
      if (!kart || !kart.state.isInvincible) {
        flags[id] = 0;
        continue;
      }
      if (kart.state.isPlayer || id === playerKartId || kart.state.position.distanceTo(this.camPos) <= STAR_AUDIBLE_DISTANCE) {
        starAudible = true;
      }
    }
    if (starAudible && !this.starJingle && this.sfxBus) {
      const seq = new Sequencer(ctx, this.sfxBus, buildStarJingle());
      seq.start(now + 0.05, 0.15);
      this.starJingle = seq;
    } else if (!starAudible && this.starJingle) {
      this.starJingle.stop(0.35);
      this.starJingle = null;
    }

    let duckDb = 0;
    if (starAudible) duckDb = Math.min(duckDb, STAR_DUCK_DB);
    if (this.lightningDuck > 0) {
      this.lightningDuck -= dt;
      duckDb = Math.min(duckDb, LIGHTNING_DUCK_DB);
    }
    // Only touch the automation timeline when the target actually changes.
    if (duckDb !== this.lastDuckDb && this.musicDuck) {
      this.lastDuckDb = duckDb;
      this.musicDuck.gain.setTargetAtTime(dbToGain(duckDb), now, 0.12);
    }

    // --- crowd -----------------------------------------------------------------
    this.crowd?.update(dt, playerKart ? playerKart.state.trackT : null);
  }

  /** Full engine voices for the player + the nearest karts, cheap voices for the rest. */
  private assignVoiceTiers(): void {
    const engines = this.engines;
    let richLeft = RICH_VOICE_COUNT;
    for (let i = 0; i < engines.length; i++) {
      const slot = engines[i];
      if (slot && slot.voice.isPlayer) {
        slot.voice.setRich(true);
        richLeft--;
      }
    }
    // Selection by distance without allocating: repeatedly pick the nearest
    // unassigned slot, temporarily flipping its distance negative as a marker.
    let picked = 0;
    while (picked < richLeft) {
      let best: VoiceSlot | null = null;
      for (let i = 0; i < engines.length; i++) {
        const slot = engines[i];
        if (!slot || slot.voice.isPlayer || slot.distance < 0) continue;
        if (!best || slot.distance < best.distance) best = slot;
      }
      if (!best) break;
      best.voice.setRich(true);
      best.distance = -1 - best.distance;
      picked++;
    }
    for (let i = 0; i < engines.length; i++) {
      const slot = engines[i];
      if (!slot || slot.voice.isPlayer) continue;
      if (slot.distance < 0) {
        slot.distance = -1 - slot.distance;
      } else {
        slot.voice.setRich(false);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Music & mixer
  // -------------------------------------------------------------------------

  /** Chooses which downloaded score plays during a race. Call before playMusic. */
  setCircuit(trackId: string): void {
    this.circuitId = trackId;
    this.stream?.setCircuit(trackId);
  }

  playMusic(track: MusicTrack): void {
    this.pendingTrack = track;
    if (!this._ready) return;
    if (this.musicMode === 'synth' || !this.stream) {
      this.music?.play(track);
      return;
    }
    // While the mode is still 'unknown' the synth stays quiet: the deck's
    // onReady / onFail callbacks decide which score owns the session, so the two
    // never overlap during the first request.
    this.stream.play(track);
  }

  stopMusic(): void {
    this.pendingTrack = 'none';
    this.stream?.stop();
    this.music?.stop();
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp01(v);
    if (this.master && this.ctx && !this._muted) {
      this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.05);
    }
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.master && this.ctx) {
      const g = this.master.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(muted ? 0 : this.masterVolume, now + 0.12);
    }
  }
}

function findKart(karts: readonly IKart[], id: number): IKart | null {
  if (id >= 0 && id < karts.length && karts[id].state.id === id) return karts[id];
  for (let i = 0; i < karts.length; i++) if (karts[i].state.id === id) return karts[i];
  return null;
}
