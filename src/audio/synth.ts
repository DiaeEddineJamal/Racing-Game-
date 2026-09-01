/**
 * Web Audio synthesis building blocks. Everything audible in the game is
 * generated from these primitives - there are no audio files.
 */

export type NoiseColor = 'white' | 'pink' | 'brown';

export interface Envelope {
  /** Seconds to reach peak. */
  attack?: number;
  /** Seconds from peak to sustain level. */
  decay?: number;
  /** Sustain level as a fraction of peak (0..1). */
  sustain?: number;
  /** Seconds to fade out after the note duration ends. */
  release?: number;
}

export interface FilterOptions {
  type: BiquadFilterType;
  freq: number;
  /** Optional cutoff sweep target (exponential) over `sweepTime` or the tone duration. */
  endFreq?: number;
  sweepTime?: number;
  q?: number;
}

export interface ToneOptions {
  freq: number;
  /** Exponential frequency sweep target. */
  endFreq?: number;
  /** Duration of the frequency sweep (defaults to `duration`). */
  sweepTime?: number;
  type?: OscillatorType;
  /** Sustained portion length (seconds) before release. */
  duration: number;
  /** Peak gain. */
  gain?: number;
  env?: Envelope;
  /** Cents. */
  detune?: number;
  filter?: FilterOptions;
  vibrato?: { rate: number; depth: number };
  /** Absolute AudioContext time to start (defaults to now). */
  when?: number;
  /** -1..1 stereo pan (ignored when a spatial destination is used). */
  pan?: number;
}

export interface NoiseOptions {
  duration: number;
  gain?: number;
  env?: Envelope;
  color?: NoiseColor;
  filter?: FilterOptions;
  /** Playback rate multiplier (pitches the noise texture). */
  rate?: number;
  when?: number;
  pan?: number;
}

const MIN_GAIN = 0.0001;

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---------------------------------------------------------------------------
// Noise buffers (cached per context)
// ---------------------------------------------------------------------------

const noiseCache = new WeakMap<BaseAudioContext, Map<NoiseColor, AudioBuffer>>();

export function noiseBuffer(ctx: BaseAudioContext, color: NoiseColor = 'white', seconds = 2): AudioBuffer {
  let map = noiseCache.get(ctx);
  if (!map) {
    map = new Map();
    noiseCache.set(ctx, map);
  }
  const cached = map.get(color);
  if (cached) return cached;

  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  if (color === 'white') {
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  } else if (color === 'pink') {
    // Paul Kellet's economy pink noise filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.5;
    }
  }
  map.set(color, buffer);
  return buffer;
}

// ---------------------------------------------------------------------------
// Envelopes & parameter helpers
// ---------------------------------------------------------------------------

/**
 * Schedule an ADSR on a gain-like AudioParam starting at `when`. `duration` is
 * the total note length before the release begins. Returns the time at which
 * the envelope has fully released.
 */
export function adsr(param: AudioParam, when: number, peak: number, duration: number, env: Envelope = {}): number {
  const a = Math.max(0.001, env.attack ?? 0.005);
  const d = Math.max(0.001, env.decay ?? 0.05);
  const s = Math.min(1, Math.max(0, env.sustain ?? 0.6));
  const r = Math.max(0.005, env.release ?? 0.05);
  const p = Math.max(MIN_GAIN, peak);
  const sustainLevel = Math.max(MIN_GAIN, p * s);
  param.cancelScheduledValues(when);
  param.setValueAtTime(MIN_GAIN, when);
  param.linearRampToValueAtTime(p, when + a);
  param.exponentialRampToValueAtTime(sustainLevel, when + a + d);
  const relStart = Math.max(when + a + d, when + duration);
  param.setValueAtTime(sustainLevel, relStart);
  param.exponentialRampToValueAtTime(MIN_GAIN, relStart + r);
  return relStart + r;
}

/** Exponential (default) or linear sweep of a parameter between two values. */
export function sweep(param: AudioParam, from: number, to: number, when: number, duration: number, exponential = true): void {
  if (exponential) {
    param.setValueAtTime(Math.max(MIN_GAIN, from), when);
    param.exponentialRampToValueAtTime(Math.max(MIN_GAIN, to), when + Math.max(0.001, duration));
  } else {
    param.setValueAtTime(from, when);
    param.linearRampToValueAtTime(to, when + Math.max(0.001, duration));
  }
}

/** Smoothly move a continuous parameter (engine pitch, bus gains) toward a value. */
export function glide(param: AudioParam, value: number, now: number, timeConstant: number): void {
  param.setTargetAtTime(value, now, timeConstant);
}

/** tanh soft-clip transfer curve for a WaveShaperNode. */
export function softClipCurve(amount = 2, samples = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const norm = Math.tanh(amount);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / norm;
  }
  return curve;
}

function applyFilter(ctx: BaseAudioContext, head: AudioNode, f: FilterOptions, when: number, duration: number): AudioNode {
  const filter = ctx.createBiquadFilter();
  filter.type = f.type;
  filter.Q.value = f.q ?? 1;
  if (f.endFreq !== undefined) {
    sweep(filter.frequency, f.freq, f.endFreq, when, f.sweepTime ?? duration);
  } else {
    filter.frequency.value = f.freq;
  }
  head.connect(filter);
  return filter;
}

function connectOut(ctx: BaseAudioContext, head: AudioNode, dest: AudioNode, pan: number | undefined): AudioNode {
  if (pan !== undefined && pan !== 0 && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    head.connect(p);
    p.connect(dest);
    return p;
  }
  head.connect(dest);
  return head;
}

// ---------------------------------------------------------------------------
// One-shots
// ---------------------------------------------------------------------------

/** Play a single enveloped oscillator. Returns the time at which it ends. */
export function playTone(ctx: BaseAudioContext, dest: AudioNode, o: ToneOptions): number {
  const when = o.when ?? ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  if (o.detune) osc.detune.value = o.detune;
  osc.frequency.setValueAtTime(Math.max(MIN_GAIN, o.freq), when);
  if (o.endFreq !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(MIN_GAIN, o.endFreq), when + Math.max(0.001, o.sweepTime ?? o.duration));
  }

  const gain = ctx.createGain();
  const end = adsr(gain.gain, when, o.gain ?? 0.2, o.duration, o.env);

  let head: AudioNode = osc;
  if (o.filter) head = applyFilter(ctx, head, o.filter, when, o.duration);
  head.connect(gain);
  connectOut(ctx, gain, dest, o.pan);

  let lfo: OscillatorNode | null = null;
  if (o.vibrato && o.vibrato.depth > 0) {
    lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = o.vibrato.rate;
    const lg = ctx.createGain();
    lg.gain.value = o.vibrato.depth;
    lfo.connect(lg);
    lg.connect(osc.detune);
    lfo.start(when);
    lfo.stop(end + 0.02);
  }

  osc.start(when);
  osc.stop(end + 0.02);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
    if (lfo) lfo.disconnect();
  };
  return end;
}

/** Play a filtered, enveloped burst of noise. Returns the end time. */
export function playNoiseBurst(ctx: BaseAudioContext, dest: AudioNode, o: NoiseOptions): number {
  const when = o.when ?? ctx.currentTime;
  const src = ctx.createBufferSource();
  const buffer = noiseBuffer(ctx, o.color ?? 'white');
  src.buffer = buffer;
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = buffer.duration;
  if (o.rate !== undefined) src.playbackRate.value = o.rate;

  const gain = ctx.createGain();
  const end = adsr(gain.gain, when, o.gain ?? 0.2, o.duration, o.env ?? { attack: 0.002, decay: o.duration * 0.6, sustain: 0.3, release: 0.05 });

  let head: AudioNode = src;
  if (o.filter) head = applyFilter(ctx, head, o.filter, when, o.duration);
  head.connect(gain);
  connectOut(ctx, gain, dest, o.pan);

  src.start(when, Math.random() * Math.max(0, buffer.duration - 0.5));
  src.stop(end + 0.02);
  src.onended = () => {
    src.disconnect();
    gain.disconnect();
  };
  return end;
}

/**
 * Sequence of tones (arpeggio / melody). Each entry: [semitone offset or midi,
 * duration]. `baseMidi` is added to each note. Returns the end time.
 */
export function playSequence(
  ctx: BaseAudioContext,
  dest: AudioNode,
  notes: readonly (readonly [number, number])[],
  opts: { baseMidi?: number; type?: OscillatorType; gain?: number; when?: number; env?: Envelope; gap?: number; filter?: FilterOptions; vibrato?: { rate: number; depth: number } } = {},
): number {
  let t = opts.when ?? ctx.currentTime;
  const gap = opts.gap ?? 0;
  const base = opts.baseMidi ?? 0;
  let end = t;
  for (const [n, d] of notes) {
    end = playTone(ctx, dest, {
      freq: midiToFreq(base + n),
      type: opts.type ?? 'square',
      duration: d,
      gain: opts.gain ?? 0.15,
      env: opts.env ?? { attack: 0.005, decay: 0.05, sustain: 0.7, release: 0.06 },
      when: t,
      filter: opts.filter,
      vibrato: opts.vibrato,
    });
    t += d + gap;
  }
  return end;
}

/** Play several tones at once (a chord). */
export function playChord(
  ctx: BaseAudioContext,
  dest: AudioNode,
  midis: readonly number[],
  opts: { type?: OscillatorType; gain?: number; duration: number; when?: number; env?: Envelope; detune?: number; filter?: FilterOptions },
): number {
  const when = opts.when ?? ctx.currentTime;
  let end = when;
  for (const m of midis) {
    end = Math.max(end, playTone(ctx, dest, {
      freq: midiToFreq(m),
      type: opts.type ?? 'sawtooth',
      duration: opts.duration,
      gain: opts.gain ?? 0.08,
      env: opts.env,
      when,
      detune: opts.detune ? (Math.random() * 2 - 1) * opts.detune : 0,
      filter: opts.filter,
    }));
  }
  return end;
}
