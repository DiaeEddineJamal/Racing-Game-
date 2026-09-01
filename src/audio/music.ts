/**
 * Procedural music: a lookahead step sequencer with synthesised instruments and
 * four compositions (menu / race / finalLap / results) plus the star jingle.
 */
import type { MusicTrack } from '../core/types';
import { adsr, midiToFreq, noiseBuffer, playNoiseBurst, sweep } from './synth';

export type Instrument = 'kick' | 'snare' | 'hatC' | 'hatO' | 'crash' | 'bass' | 'lead' | 'chord' | 'pad' | 'arp' | 'bell';

export interface NoteEvent {
  step: number;
  inst: Instrument;
  /** MIDI note (ignored by drums). */
  note: number;
  /** Duration in 16th steps. */
  dur: number;
  /** 0..1 velocity. */
  vel: number;
}

export interface Bar {
  notes: NoteEvent[];
}

export interface Song {
  bpm: number;
  /** Semitones added to every pitched note. */
  transpose: number;
  bars: Bar[];
  /** Bar index to jump back to after the last bar. */
  loopStart: number;
  /** Lead delay wet amount 0..1. */
  leadDelay: number;
  /** Overall song gain. */
  gain: number;
}

const STEPS_PER_BAR = 16;
const LOOKAHEAD_SECONDS = 0.1;
const TICK_MS = 25;

// ---------------------------------------------------------------------------
// Bar builder
// ---------------------------------------------------------------------------

class BarBuilder {
  readonly notes: NoteEvent[] = [];

  add(inst: Instrument, step: number, note: number, dur: number, vel: number): this {
    this.notes.push({ inst, step, note, dur, vel });
    return this;
  }

  kick(step: number, vel = 1): this { return this.add('kick', step, 0, 1, vel); }
  snare(step: number, vel = 1): this { return this.add('snare', step, 0, 1, vel); }
  hatC(step: number, vel = 1): this { return this.add('hatC', step, 0, 1, vel); }
  hatO(step: number, vel = 1): this { return this.add('hatO', step, 0, 1, vel); }
  crash(step: number, vel = 1): this { return this.add('crash', step, 0, 1, vel); }
  bass(step: number, note: number, dur: number, vel = 1): this { return this.add('bass', step, note, dur, vel); }
  lead(step: number, note: number, dur: number, vel = 1): this { return this.add('lead', step, note, dur, vel); }
  arp(step: number, note: number, dur: number, vel = 1): this { return this.add('arp', step, note, dur, vel); }
  bell(step: number, note: number, dur: number, vel = 1): this { return this.add('bell', step, note, dur, vel); }
  chord(step: number, notes: readonly number[], dur: number, vel = 1): this {
    for (const n of notes) this.add('chord', step, n, dur, vel);
    return this;
  }
  pad(step: number, notes: readonly number[], dur: number, vel = 1): this {
    for (const n of notes) this.add('pad', step, n, dur, vel);
    return this;
  }
  /** Melody as [step, midi, dur] tuples. */
  melody(inst: Instrument, notes: readonly (readonly [number, number, number])[], vel = 1): this {
    for (const [s, n, d] of notes) this.add(inst, s, n, d, vel);
    return this;
  }
  build(): Bar {
    return { notes: this.notes };
  }
}

// ---------------------------------------------------------------------------
// Sequencer
// ---------------------------------------------------------------------------

export class Sequencer {
  readonly output: GainNode;
  private readonly ctx: AudioContext;
  private readonly song: Song;
  private readonly stepDur: number;

  private readonly drumBus: GainNode;
  private readonly bassBus: GainNode;
  private readonly leadBus: GainNode;
  private readonly leadDelay: DelayNode;
  private readonly leadFeedback: GainNode;
  private readonly leadWet: GainNode;
  private readonly chordBus: GainNode;
  private readonly chordFilter: BiquadFilterNode;
  private readonly chordLfo: OscillatorNode;
  private readonly arpBus: GainNode;

  private timer: ReturnType<typeof setInterval> | null = null;
  private bar = 0;
  private step = 0;
  private nextTime = 0;
  private stopped = false;

  constructor(ctx: AudioContext, dest: AudioNode, song: Song) {
    this.ctx = ctx;
    this.song = song;
    this.stepDur = 60 / song.bpm / 4;

    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.output.connect(dest);

    const bus = (gain: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = gain;
      g.connect(this.output);
      return g;
    };
    this.drumBus = bus(0.9 * song.gain);
    this.bassBus = bus(0.8 * song.gain);
    this.arpBus = bus(0.7 * song.gain);

    // Lead with a dotted-eighth feedback delay for width.
    this.leadBus = bus(0.85 * song.gain);
    this.leadDelay = ctx.createDelay(1.5);
    this.leadDelay.delayTime.value = Math.min(1.4, this.stepDur * 3);
    this.leadFeedback = ctx.createGain();
    this.leadFeedback.gain.value = 0.32;
    this.leadWet = ctx.createGain();
    this.leadWet.gain.value = 0.3 * song.leadDelay * song.gain;
    const delayTone = ctx.createBiquadFilter();
    delayTone.type = 'lowpass';
    delayTone.frequency.value = 2600;
    this.leadBus.connect(this.leadDelay);
    this.leadDelay.connect(delayTone);
    delayTone.connect(this.leadFeedback);
    this.leadFeedback.connect(this.leadDelay);
    delayTone.connect(this.leadWet);
    this.leadWet.connect(this.output);

    // Chords through a slowly breathing lowpass.
    this.chordBus = ctx.createGain();
    this.chordBus.gain.value = 0.9 * song.gain;
    this.chordFilter = ctx.createBiquadFilter();
    this.chordFilter.type = 'lowpass';
    this.chordFilter.frequency.value = 1500;
    this.chordFilter.Q.value = 0.9;
    this.chordLfo = ctx.createOscillator();
    this.chordLfo.type = 'sine';
    this.chordLfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 750;
    this.chordLfo.connect(lfoGain);
    lfoGain.connect(this.chordFilter.frequency);
    this.chordBus.connect(this.chordFilter);
    this.chordFilter.connect(this.output);
    this.chordLfo.start();
  }

  start(at: number, fadeIn: number): void {
    if (this.timer || this.stopped) return;
    const now = this.ctx.currentTime;
    const t0 = Math.max(now + 0.02, at);
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(0.0001, now);
    this.output.gain.exponentialRampToValueAtTime(1, t0 + Math.max(0.02, fadeIn));
    this.nextTime = t0;
    this.bar = 0;
    this.step = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  /** Fade out over `fadeOut` seconds and tear down. */
  stop(fadeOut: number): void {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.ctx.currentTime;
    const g = this.output.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.exponentialRampToValueAtTime(0.0001, now + Math.max(0.02, fadeOut));
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const teardown = (): void => {
      try {
        this.chordLfo.stop();
      } catch {
        // already stopped
      }
      this.output.disconnect();
      this.leadFeedback.disconnect();
      this.leadDelay.disconnect();
    };
    setTimeout(teardown, fadeOut * 1000 + 1200);
  }

  dispose(): void {
    if (!this.stopped) this.stop(0.02);
  }

  private tick(): void {
    if (this.stopped) return;
    const ctx = this.ctx;
    const horizon = ctx.currentTime + LOOKAHEAD_SECONDS;
    const bars = this.song.bars;
    if (bars.length === 0) return;
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 64) {
      const bar = bars[this.bar];
      const t = this.nextTime;
      for (const n of bar.notes) {
        if (n.step === this.step) this.play(n, t);
      }
      this.step++;
      this.nextTime += this.stepDur;
      if (this.step >= STEPS_PER_BAR) {
        this.step = 0;
        this.bar++;
        if (this.bar >= bars.length) this.bar = Math.min(this.song.loopStart, bars.length - 1);
      }
    }
  }

  private play(n: NoteEvent, t: number): void {
    const dur = n.dur * this.stepDur;
    const midi = n.note + this.song.transpose;
    switch (n.inst) {
      case 'kick': this.kick(t, n.vel); break;
      case 'snare': this.snare(t, n.vel); break;
      case 'hatC': this.hat(t, n.vel, false); break;
      case 'hatO': this.hat(t, n.vel, true); break;
      case 'crash': this.crash(t, n.vel); break;
      case 'bass': this.bass(t, midi, dur, n.vel); break;
      case 'lead': this.lead(t, midi, dur, n.vel); break;
      case 'chord': this.chord(t, midi, dur, n.vel, false); break;
      case 'pad': this.chord(t, midi, dur, n.vel, true); break;
      case 'arp': this.arp(t, midi, dur, n.vel); break;
      case 'bell': this.bell(t, midi, dur, n.vel); break;
      default: break;
    }
  }

  // --- instruments ---------------------------------------------------------

  private kick(t: number, vel: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(170, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g);
    g.connect(this.drumBus);
    osc.start(t);
    osc.stop(t + 0.32);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
    playNoiseBurst(ctx, this.drumBus, {
      duration: 0.012, gain: 0.22 * vel, when: t,
      filter: { type: 'highpass', freq: 2500 },
      env: { attack: 0.001, decay: 0.01, sustain: 0.1, release: 0.01 },
    });
  }

  private snare(t: number, vel: number): void {
    const ctx = this.ctx;
    playNoiseBurst(ctx, this.drumBus, {
      duration: 0.14, gain: 0.5 * vel, when: t,
      filter: { type: 'bandpass', freq: 1700, q: 0.8 },
      env: { attack: 0.001, decay: 0.12, sustain: 0.05, release: 0.04 },
    });
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(195, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    osc.connect(g);
    g.connect(this.drumBus);
    osc.start(t);
    osc.stop(t + 0.12);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  private hat(t: number, vel: number, open: boolean): void {
    playNoiseBurst(this.ctx, this.drumBus, {
      duration: open ? 0.14 : 0.03, gain: (open ? 0.16 : 0.2) * vel, when: t,
      filter: { type: 'highpass', freq: 8000, q: 0.7 },
      env: open
        ? { attack: 0.001, decay: 0.12, sustain: 0.15, release: 0.05 }
        : { attack: 0.001, decay: 0.03, sustain: 0.05, release: 0.01 },
    });
  }

  private crash(t: number, vel: number): void {
    playNoiseBurst(this.ctx, this.drumBus, {
      duration: 0.7, gain: 0.28 * vel, when: t,
      filter: { type: 'highpass', freq: 4500, q: 0.6 },
      env: { attack: 0.002, decay: 0.55, sustain: 0.12, release: 0.4 },
    });
    playNoiseBurst(this.ctx, this.drumBus, {
      duration: 0.5, gain: 0.14 * vel, when: t, color: 'pink',
      filter: { type: 'bandpass', freq: 3200, q: 1.2 },
      env: { attack: 0.002, decay: 0.4, sustain: 0.1, release: 0.3 },
    });
  }

  private bass(t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = freq;
    const sq = ctx.createOscillator();
    sq.type = 'square';
    sq.frequency.value = freq * 0.5;
    const sqGain = ctx.createGain();
    sqGain.gain.value = 0.45;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2.2;
    sweep(filter.frequency, 300 + freq * 7, 120 + freq * 2.5, t, Math.min(0.18, Math.max(0.05, dur)));
    const g = ctx.createGain();
    const end = adsr(g.gain, t, 0.3 * vel, dur * 0.9, { attack: 0.004, decay: 0.08, sustain: 0.75, release: 0.05 });
    saw.connect(filter);
    sq.connect(sqGain);
    sqGain.connect(filter);
    filter.connect(g);
    g.connect(this.bassBus);
    saw.start(t); sq.start(t);
    saw.stop(end + 0.02); sq.stop(end + 0.02);
    saw.onended = () => { saw.disconnect(); sq.disconnect(); filter.disconnect(); g.disconnect(); };
  }

  private lead(t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const sq = ctx.createOscillator();
    sq.type = 'square';
    sq.frequency.value = freq;
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = freq;
    saw.detune.value = -6;
    const sawGain = ctx.createGain();
    sawGain.gain.value = 0.45;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0, t);
    lfoGain.gain.linearRampToValueAtTime(9, t + 0.15);
    lfo.connect(lfoGain);
    lfoGain.connect(sq.detune);
    lfoGain.connect(saw.detune);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 3200;
    filter.Q.value = 0.8;
    const g = ctx.createGain();
    const end = adsr(g.gain, t, 0.2 * vel, dur * 0.92, { attack: 0.008, decay: 0.06, sustain: 0.75, release: 0.07 });
    sq.connect(filter);
    saw.connect(sawGain);
    sawGain.connect(filter);
    filter.connect(g);
    g.connect(this.leadBus);
    sq.start(t); saw.start(t); lfo.start(t);
    sq.stop(end + 0.02); saw.stop(end + 0.02); lfo.stop(end + 0.02);
    sq.onended = () => { sq.disconnect(); saw.disconnect(); lfo.disconnect(); filter.disconnect(); g.disconnect(); };
  }

  private chord(t: number, midi: number, dur: number, vel: number, pad: boolean): void {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const g = ctx.createGain();
    const env = pad
      ? { attack: 0.25, decay: 0.3, sustain: 0.85, release: 0.5 }
      : { attack: 0.02, decay: 0.1, sustain: 0.8, release: 0.15 };
    const end = adsr(g.gain, t, (pad ? 0.04 : 0.05) * vel, dur * 0.95, env);
    const a = ctx.createOscillator();
    a.type = pad ? 'triangle' : 'sawtooth';
    a.frequency.value = freq;
    a.detune.value = 7;
    const b = ctx.createOscillator();
    b.type = 'sawtooth';
    b.frequency.value = freq;
    b.detune.value = -7;
    const bGain = ctx.createGain();
    bGain.gain.value = pad ? 0.5 : 1;
    a.connect(g);
    b.connect(bGain);
    bGain.connect(g);
    g.connect(this.chordBus);
    a.start(t); b.start(t);
    a.stop(end + 0.02); b.stop(end + 0.02);
    a.onended = () => { a.disconnect(); b.disconnect(); g.disconnect(); };
  }

  private arp(t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.value = freq;
    const sin = ctx.createOscillator();
    sin.type = 'sine';
    sin.frequency.value = freq * 2;
    const sinGain = ctx.createGain();
    sinGain.gain.value = 0.3;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 4500;
    const g = ctx.createGain();
    const end = adsr(g.gain, t, 0.18 * vel, dur * 0.8, { attack: 0.003, decay: 0.1, sustain: 0.25, release: 0.05 });
    tri.connect(filter);
    sin.connect(sinGain);
    sinGain.connect(filter);
    filter.connect(g);
    g.connect(this.arpBus);
    tri.start(t); sin.start(t);
    tri.stop(end + 0.02); sin.stop(end + 0.02);
    tri.onended = () => { tri.disconnect(); sin.disconnect(); filter.disconnect(); g.disconnect(); };
  }

  private bell(t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const g = ctx.createGain();
    const end = adsr(g.gain, t, 0.2 * vel, 0.01, { attack: 0.002, decay: Math.max(0.2, dur), sustain: 0.001, release: 0.1 });
    const a = ctx.createOscillator();
    a.type = 'sine';
    a.frequency.value = freq;
    const b = ctx.createOscillator();
    b.type = 'sine';
    b.frequency.value = freq * 2.76;
    const bGain = ctx.createGain();
    bGain.gain.value = 0.3;
    a.connect(g);
    b.connect(bGain);
    bGain.connect(g);
    g.connect(this.arpBus);
    a.start(t); b.start(t);
    a.stop(end + 0.02); b.stop(end + 0.02);
    a.onended = () => { a.disconnect(); b.disconnect(); g.disconnect(); };
  }
}

// ---------------------------------------------------------------------------
// Compositions
// ---------------------------------------------------------------------------

/** Walking bass in 8ths: root, 5th, octave, 5th, root, 5th, 6th, chromatic approach. */
function walkingBass(b: BarBuilder, root: number, nextRoot: number, vel = 1): void {
  const approach = nextRoot === root ? root + 7 : nextRoot > root ? nextRoot - 1 : nextRoot + 1;
  const seq = [root, root + 7, root + 12, root + 7, root, root + 7, root + 9, approach];
  for (let i = 0; i < 8; i++) {
    const accent = i % 2 === 0 ? 1 : 0.8;
    b.bass(i * 2, seq[i], 2, vel * accent);
  }
}

function fourOnFloor(b: BarBuilder, dense: boolean, fill: boolean): void {
  b.kick(0, 1).kick(4, 0.9).kick(8, 1).kick(12, 0.9);
  b.snare(4, 0.9).snare(12, 0.95);
  if (dense) {
    for (let s = 0; s < 16; s++) b.hatC(s, s % 4 === 2 ? 0.8 : s % 2 === 0 ? 0.45 : 0.3);
    b.hatO(6, 0.5).hatO(14, 0.5);
  } else {
    for (let s = 0; s < 16; s += 2) b.hatC(s, s % 4 === 2 ? 0.8 : 0.45);
  }
  if (fill) {
    b.snare(12, 0.5).snare(13, 0.6).snare(14, 0.75).snare(15, 0.9);
  }
}

const RACE_LEAD_A: readonly (readonly [number, number, number])[][] = [
  [[0, 79, 2], [2, 83, 2], [4, 86, 3], [8, 83, 2], [10, 81, 2], [12, 79, 4]],
  [[0, 78, 3], [4, 81, 2], [6, 86, 2], [8, 81, 4], [12, 78, 2], [14, 76, 2]],
  [[0, 76, 2], [2, 79, 2], [4, 83, 4], [8, 79, 2], [10, 81, 2], [12, 83, 4]],
  [[0, 84, 3], [4, 83, 2], [6, 81, 2], [8, 79, 4], [12, 81, 2], [14, 83, 2]],
  [[0, 79, 2], [2, 83, 2], [4, 86, 3], [8, 88, 2], [10, 86, 2], [12, 83, 4]],
  [[0, 81, 3], [4, 78, 2], [6, 81, 2], [8, 86, 4], [12, 85, 2], [14, 86, 2]],
  [[0, 88, 2], [2, 86, 2], [4, 84, 4], [8, 83, 2], [10, 84, 2], [12, 86, 4]],
  [[0, 86, 4], [4, 81, 2], [6, 83, 2], [8, 81, 2], [10, 78, 2], [12, 74, 4]],
];

const RACE_LEAD_B: readonly (readonly [number, number, number])[][] = [
  [[0, 83, 1], [1, 83, 1], [2, 88, 2], [4, 86, 2], [6, 83, 2], [8, 79, 4], [12, 81, 2], [14, 83, 2]],
  [[0, 84, 1], [1, 84, 1], [2, 88, 2], [4, 86, 2], [6, 84, 2], [8, 81, 4], [12, 79, 2], [14, 81, 2]],
  [[0, 83, 2], [2, 86, 2], [4, 91, 4], [8, 86, 2], [10, 83, 2], [12, 79, 4]],
  [[0, 81, 2], [2, 85, 2], [4, 86, 4], [8, 88, 2], [10, 86, 2], [12, 81, 4]],
  [[0, 83, 1], [1, 83, 1], [2, 88, 2], [4, 86, 2], [6, 83, 2], [8, 79, 4], [12, 81, 2], [14, 83, 2]],
  [[0, 84, 1], [1, 84, 1], [2, 88, 2], [4, 86, 2], [6, 84, 2], [8, 81, 4], [12, 84, 2], [14, 86, 2]],
  [[0, 88, 2], [2, 90, 2], [4, 91, 4], [8, 90, 2], [10, 88, 2], [12, 86, 4]],
  [[0, 85, 2], [2, 86, 2], [4, 88, 2], [6, 90, 2], [8, 91, 4], [12, 90, 2], [14, 88, 2]],
];

/**
 * Race theme in G major, 152 bpm. Section A (I–V–vi–IV | I–V–IV–V) with a
 * call-and-response lead, section B (vi–IV–I–V | vi–IV–V–V) with 16th arps.
 */
export function buildRaceSong(finalLap: boolean): Song {
  const G = { root: 43, chord: [67, 71, 74] };
  const D = { root: 38, chord: [66, 69, 74] };
  const Em = { root: 40, chord: [64, 67, 71] };
  const C = { root: 36, chord: [64, 67, 72] };
  const sectionA = [G, D, Em, C, G, D, C, D];
  const sectionB = [Em, C, G, D, Em, C, D, D];
  const dense = finalLap;
  const bars: Bar[] = [];

  for (let i = 0; i < 8; i++) {
    const ch = sectionA[i];
    const next = sectionA[(i + 1) % 8];
    const b = new BarBuilder();
    fourOnFloor(b, dense, i === 7);
    if (i === 0) b.crash(0, 0.8);
    walkingBass(b, ch.root, next.root, 0.95);
    b.chord(0, ch.chord, 3, 0.9).chord(6, ch.chord, 2, 0.6).chord(8, ch.chord, 3, 0.85);
    for (let s = 2; s < 16; s += 4) b.arp(s, ch.chord[Math.floor(s / 4) % 3] + 12, 1, 0.45);
    b.melody('lead', RACE_LEAD_A[i], 0.95);
    bars.push(b.build());
  }
  for (let i = 0; i < 8; i++) {
    const ch = sectionB[i];
    const next = i === 7 ? sectionA[0] : sectionB[i + 1];
    const b = new BarBuilder();
    fourOnFloor(b, true, i === 7);
    if (i === 0) b.crash(0, 0.7);
    walkingBass(b, ch.root, next.root, 1);
    b.chord(0, ch.chord, 16, 0.75);
    const tones = [ch.chord[0] + 12, ch.chord[1] + 12, ch.chord[2] + 12, ch.chord[0] + 24];
    const pattern = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 3];
    for (let s = 0; s < 16; s++) b.arp(s, tones[pattern[s]], 1, s % 4 === 0 ? 0.6 : 0.4);
    b.melody('lead', RACE_LEAD_B[i], 1);
    bars.push(b.build());
  }

  return {
    bpm: finalLap ? 152 * 1.1 : 152,
    transpose: finalLap ? 1 : 0,
    bars,
    loopStart: 0,
    leadDelay: 1,
    gain: 1,
  };
}

const MENU_LEAD: readonly (readonly [number, number, number])[][] = [
  [[0, 81, 6], [8, 78, 4], [12, 76, 4]],
  [[0, 74, 8], [8, 78, 4], [12, 76, 2], [14, 74, 2]],
  [[0, 71, 6], [8, 74, 4], [12, 76, 4]],
  [[0, 73, 8], [8, 76, 4], [12, 69, 4]],
];

/** Menu theme: D major, 100 bpm, Imaj7–vi7–IVmaj7–V7sus with soft arps. */
export function buildMenuSong(): Song {
  const prog = [
    { root: 38, chord: [57, 61, 62, 66] }, // Dmaj7
    { root: 35, chord: [59, 62, 66, 69] }, // Bm7
    { root: 43, chord: [55, 59, 62, 66] }, // Gmaj7
    { root: 45, chord: [57, 62, 64, 67] }, // A7sus
  ];
  const bars: Bar[] = [];
  for (let i = 0; i < 8; i++) {
    const ch = prog[i % 4];
    const b = new BarBuilder();
    b.kick(0, 0.5).kick(8, 0.42);
    b.snare(4, 0.18).snare(12, 0.22);
    for (let s = 2; s < 16; s += 4) b.hatC(s, 0.35);
    if (i % 2 === 1) b.hatO(14, 0.2);
    b.bass(0, ch.root, 6, 0.8).bass(8, ch.root + 7, 4, 0.6).bass(12, ch.root, 4, 0.5);
    b.pad(0, ch.chord, 16, 0.8);
    const tones = ch.chord.map((n) => n + 12);
    const pattern = [0, 1, 2, 3, 2, 1, 0, 1];
    for (let k = 0; k < 8; k++) b.arp(k * 2, tones[pattern[k]], 2, 0.5);
    if (i >= 4) b.melody('lead', MENU_LEAD[i - 4], 0.55);
    bars.push(b.build());
  }
  return { bpm: 100, transpose: 0, bars, loopStart: 0, leadDelay: 0.8, gain: 0.85 };
}

const RESULTS_FANFARE: readonly (readonly [number, number, number])[][] = [
  [[0, 67, 1], [2, 67, 1], [4, 67, 2], [6, 72, 6], [12, 76, 4]],
  [[0, 77, 4], [4, 76, 2], [6, 74, 2], [8, 72, 8]],
  [[0, 74, 2], [2, 76, 2], [4, 77, 2], [6, 79, 2], [8, 81, 4], [12, 83, 4]],
  [[0, 84, 14]],
];

const RESULTS_LEAD: readonly (readonly [number, number, number])[][] = [
  [[0, 76, 4], [4, 79, 4], [8, 77, 2], [10, 76, 2], [12, 74, 4]],
  [[0, 72, 6], [8, 76, 4], [12, 74, 4]],
  [[0, 72, 4], [4, 74, 2], [6, 76, 2], [8, 77, 8]],
  [[0, 79, 8], [8, 76, 4], [12, 74, 4]],
];

/** Results: 4-bar C major fanfare, then a relaxed I–vi–IV–V loop. 112 bpm. */
export function buildResultsSong(): Song {
  const bars: Bar[] = [];
  const fanfare = [
    { root: 36, chord: [60, 64, 67, 72] },
    { root: 41, chord: [65, 69, 72, 77] },
    { root: 43, chord: [67, 71, 74, 79] },
    { root: 36, chord: [60, 64, 67, 72] },
  ];
  for (let i = 0; i < 4; i++) {
    const ch = fanfare[i];
    const b = new BarBuilder();
    if (i < 3) {
      b.kick(0, 1).kick(8, 0.9);
      b.chord(0, ch.chord, 7, 0.9).chord(8, ch.chord, 7, 0.8);
      b.bass(0, ch.root, 7, 1).bass(8, ch.root, 7, 0.9);
      if (i === 2) for (let s = 8; s < 16; s++) b.snare(s, 0.35 + (s - 8) * 0.08);
      else b.snare(4, 0.6).snare(12, 0.7);
    } else {
      b.crash(0, 1).kick(0, 1);
      b.chord(0, ch.chord, 15, 1);
      b.bass(0, ch.root, 14, 1);
    }
    b.melody('lead', RESULTS_FANFARE[i], 1);
    bars.push(b.build());
  }
  const loop = [
    { root: 36, chord: [60, 64, 67] },
    { root: 45, chord: [60, 64, 69] },
    { root: 41, chord: [60, 65, 69] },
    { root: 43, chord: [59, 62, 67] },
  ];
  for (let i = 0; i < 8; i++) {
    const ch = loop[i % 4];
    const next = loop[(i + 1) % 4];
    const b = new BarBuilder();
    b.kick(0, 0.8).kick(8, 0.7);
    b.snare(4, 0.5).snare(12, 0.55);
    for (let s = 2; s < 16; s += 4) b.hatC(s, 0.5);
    b.bass(0, ch.root, 4, 0.9).bass(6, ch.root + 7, 2, 0.6).bass(8, ch.root, 4, 0.85).bass(12, ch.root + 12, 2, 0.6)
      .bass(14, next.root > ch.root ? next.root - 1 : next.root + 1, 2, 0.6);
    b.pad(0, ch.chord, 16, 0.85);
    const tones = ch.chord.map((n) => n + 12);
    const pattern = [0, 1, 2, 1, 0, 1, 2, 1];
    for (let k = 0; k < 8; k++) b.arp(k * 2 + 1, tones[pattern[k]], 1, 0.4);
    if (i >= 4) b.melody('lead', RESULTS_LEAD[i - 4], 0.7);
    bars.push(b.build());
  }
  return { bpm: 112, transpose: 0, bars, loopStart: 4, leadDelay: 0.8, gain: 0.95 };
}

/** Star jingle: fast arpeggiated C–F–G–C major pattern, 170 bpm. */
export function buildStarJingle(): Song {
  const roots = [72, 77, 79, 72];
  const bars: Bar[] = [];
  for (let i = 0; i < 4; i++) {
    const r = roots[i];
    const seq = [r, r + 4, r + 7, r + 12, r + 16, r + 19, r + 16, r + 12, r + 7, r + 12, r + 16, r + 12, r + 7, r + 4, r + 7, r + 4];
    const b = new BarBuilder();
    for (let s = 0; s < 16; s++) b.arp(s, seq[s], 1, s % 4 === 0 ? 1 : 0.7);
    for (let s = 0; s < 16; s += 4) b.kick(s, 0.7).bass(s, r - 24, 2, 0.8);
    for (let s = 2; s < 16; s += 4) b.hatC(s, 0.6);
    bars.push(b.build());
  }
  return { bpm: 170, transpose: 0, bars, loopStart: 0, leadDelay: 0, gain: 1 };
}

// ---------------------------------------------------------------------------
// Music player (crossfading between sequencer instances)
// ---------------------------------------------------------------------------

const CROSSFADE_SECONDS = 0.8;

export class MusicPlayer {
  private current: Sequencer | null = null;
  private currentTrack: MusicTrack = 'none';
  private readonly ctx: AudioContext;
  private readonly dest: AudioNode;

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.dest = dest;
  }

  get track(): MusicTrack {
    return this.currentTrack;
  }

  play(track: MusicTrack): void {
    if (track === this.currentTrack) return;
    if (track === 'none') {
      this.stop();
      return;
    }
    const song = buildSong(track);
    const next = new Sequencer(this.ctx, this.dest, song);
    if (this.current) this.current.stop(CROSSFADE_SECONDS);
    next.start(this.ctx.currentTime + 0.05, CROSSFADE_SECONDS);
    this.current = next;
    this.currentTrack = track;
  }

  stop(): void {
    if (this.current) this.current.stop(CROSSFADE_SECONDS);
    this.current = null;
    this.currentTrack = 'none';
  }

  dispose(): void {
    if (this.current) this.current.dispose();
    this.current = null;
    this.currentTrack = 'none';
  }
}

function buildSong(track: MusicTrack): Song {
  switch (track) {
    case 'menu': return buildMenuSong();
    case 'race': return buildRaceSong(false);
    case 'finalLap': return buildRaceSong(true);
    case 'results': return buildResultsSong();
    default: return buildMenuSong();
  }
}

// Keep the noise buffer helper warm for drum hits on the first tick.
export function warmMusic(ctx: AudioContext): void {
  noiseBuffer(ctx, 'white');
  noiseBuffer(ctx, 'pink');
}
