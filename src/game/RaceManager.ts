/**
 * Race director: grid placement, countdown + start boost, ordered checkpoints,
 * laps, finish detection, positions, wrong-way detection, respawns and the
 * post-finish grace period. Runs inside the fixed-step loop.
 */
import * as THREE from 'three';
import type { Difficulty, IKart, ITrack, RaceSettings, RaceStanding, TrackSample } from '../core/types';
import { events } from '../core/events';
import { CHECKPOINT_COUNT, COUNTDOWN_STEP_SECONDS, VOID_Y } from '../core/constants';
import { seededRandom, trackDelta, wrap01 } from '../core/math';

export type RacePhase = 'grid' | 'countdown' | 'racing' | 'complete';

const PLAYER_GRID_SLOT = 7;
const COUNTDOWN_STEPS = 3;
const START_BOOST_WINDOW = 0.6;
const START_BOOST_WEAK_WINDOW = 1.2;
const START_SPINOUT_HOLD = 2.6;
const WRONG_WAY_SECONDS = 1.2;
const WRONG_WAY_SPEED = -1;
const VOID_SECONDS = 1.5;
const STUCK_SECONDS = 6;
const STUCK_SPEED = 0.5;
const RESPAWN_FREEZE_SECONDS = 0.6;
const PLACE_DEBOUNCE_SECONDS = 0.3;
const FINISH_GRACE_SECONDS = 12;
/** A checkpoint counts as reached while the kart is within this many sectors past it. */
const CHECKPOINT_WINDOW_SECTORS = 1.9;

interface Tracker {
  kart: IKart;
  nextCheckpoint: number;
  started: boolean;
  lapsCompleted: number;
  wrongWayTimer: number;
  voidTimer: number;
  stuckTimer: number;
  respawnFreeze: number;
  emittedPlace: number;
  candidatePlace: number;
  candidateTimer: number;
  throttleStreak: number;
  aiStartBoost: boolean;
  respawnCount: number;
}

function makeSampleScratch(): TrackSample {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: 0,
    wallHalfWidth: 0,
    t: 0,
  };
}

export class RaceManager {
  readonly totalLaps: number;
  readonly difficulty: Difficulty;

  private phase: RacePhase = 'grid';
  private time = 0;
  private countdownTimer = 0;
  private countdownEmitted = 0;
  private finishedCount = 0;
  private playerFinishedAt = -1;
  private allFinishedEmitted = false;

  private readonly trackers: Tracker[] = [];
  private readonly order: Tracker[] = [];
  private readonly checkpointT: number[] = [];
  private readonly sample = makeSampleScratch();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler();
  private readonly playerTracker: Tracker | null;

  constructor(
    private readonly track: ITrack,
    private readonly karts: readonly IKart[],
    settings: RaceSettings,
  ) {
    this.totalLaps = Math.max(1, Math.floor(settings.laps));
    this.difficulty = settings.difficulty;

    const cps = track.checkpoints;
    if (cps.length >= 2) {
      for (const c of cps) this.checkpointT.push(wrap01(c.t));
    } else {
      for (let i = 0; i < CHECKPOINT_COUNT; i++) this.checkpointT.push(i / CHECKPOINT_COUNT);
    }

    const rng = seededRandom(0x5eed + this.totalLaps * 7);
    const aiBoostChance = settings.difficulty === 'hard' ? 0.75 : settings.difficulty === 'normal' ? 0.5 : 0.3;
    for (const kart of karts) {
      const tr: Tracker = {
        kart,
        nextCheckpoint: 0,
        started: false,
        lapsCompleted: -1,
        wrongWayTimer: 0,
        voidTimer: 0,
        stuckTimer: 0,
        respawnFreeze: 0,
        emittedPlace: 0,
        candidatePlace: 0,
        candidateTimer: 0,
        throttleStreak: 0,
        aiStartBoost: !kart.state.isPlayer && rng() < aiBoostChance,
        respawnCount: 0,
      };
      this.trackers.push(tr);
      this.order.push(tr);
    }
    this.playerTracker = this.trackers.find((t) => t.kart.state.isPlayer) ?? null;

    this.placeOnGrid();
    this.sortOrder();
    for (let i = 0; i < this.order.length; i++) {
      const tr = this.order[i];
      tr.kart.state.place = i + 1;
      tr.emittedPlace = i + 1;
      tr.candidatePlace = i + 1;
    }
  }

  // ------------------------------------------------------------------ public

  get raceTime(): number {
    return this.time;
  }

  get currentPhase(): RacePhase {
    return this.phase;
  }

  get started(): boolean {
    return this.phase === 'racing' || this.phase === 'complete';
  }

  get allFinished(): boolean {
    return this.allFinishedEmitted;
  }

  /** Begin the 3-2-1-GO sequence (karts stay frozen until GO). */
  startCountdown(): void {
    if (this.phase !== 'grid') return;
    this.phase = 'countdown';
    this.countdownTimer = 0;
    this.countdownEmitted = 0;
    for (const tr of this.trackers) tr.kart.setFrozen(true);
  }

  update(dt: number): void {
    switch (this.phase) {
      case 'grid':
        return;
      case 'countdown':
        this.updateCountdown(dt);
        return;
      case 'racing':
      case 'complete':
        this.updateRacing(dt);
        return;
    }
  }

  getStandings(): RaceStanding[] {
    const out: RaceStanding[] = [];
    for (const tr of this.order) {
      const s = tr.kart.state;
      out.push({
        kartId: s.id,
        name: s.character.name,
        color: s.character.color,
        place: s.place,
        finishTime: s.finished ? s.finishTime : -1,
        isPlayer: s.isPlayer,
      });
    }
    out.sort((a, b) => a.place - b.place);
    return out;
  }

  dispose(): void {
    this.trackers.length = 0;
    this.order.length = 0;
  }

  // ----------------------------------------------------------------- private

  private placeOnGrid(): void {
    const grid = this.track.startGrid;
    if (grid.length === 0) return;
    let aiSlot = 0;
    for (const tr of this.trackers) {
      const s = tr.kart.state;
      let slotIndex: number;
      if (s.isPlayer) {
        slotIndex = Math.min(PLAYER_GRID_SLOT, grid.length - 1);
      } else {
        if (aiSlot === Math.min(PLAYER_GRID_SLOT, grid.length - 1)) aiSlot++;
        slotIndex = aiSlot % grid.length;
        aiSlot++;
      }
      const slot = grid[slotIndex];
      tr.kart.resetTo(slot.position, slot.quaternion);
      tr.kart.setFrozen(true);
      s.trackT = wrap01(slot.t);
      s.lap = 1;
      s.checkpointIndex = 0;
      s.finished = false;
      s.finishTime = 0;
      s.wrongWay = false;
      // If a track's grid sits just past the line, treat the kart as already started.
      if (trackDelta(0, s.trackT) >= 0 && trackDelta(0, s.trackT) < 0.25) {
        tr.started = true;
        tr.lapsCompleted = 0;
        tr.nextCheckpoint = 1;
        s.checkpointIndex = 1;
      }
      s.raceProgress = this.computeProgress(tr);
    }
  }

  private updateCountdown(dt: number): void {
    // Track how long the player has been holding the throttle (for the start boost).
    if (this.playerTracker) {
      const thr = this.playerTracker.kart.input.throttle;
      this.playerTracker.throttleStreak = thr > 0.5 ? this.playerTracker.throttleStreak + dt : 0;
    }

    this.countdownTimer += dt;
    const total = COUNTDOWN_STEPS * COUNTDOWN_STEP_SECONDS;
    while (this.countdownEmitted < COUNTDOWN_STEPS && this.countdownTimer >= this.countdownEmitted * COUNTDOWN_STEP_SECONDS) {
      events.emit('race:countdown', { count: COUNTDOWN_STEPS - this.countdownEmitted });
      this.countdownEmitted++;
    }
    if (this.countdownTimer >= total) {
      this.go();
    }
  }

  private go(): void {
    this.phase = 'racing';
    this.time = 0;
    for (const tr of this.trackers) {
      tr.kart.setFrozen(false);
      tr.stuckTimer = 0;
    }
    events.emit('race:start', { trackId: this.track.def.id });

    // Start boost / jump-start penalty.
    const p = this.playerTracker;
    if (p) {
      const held = p.throttleStreak;
      if (held >= START_SPINOUT_HOLD) {
        p.kart.applyHit('collision', -1);
      } else if (held > 0.02 && held <= START_BOOST_WINDOW) {
        p.kart.applyBoost(0.4, 1.0, 'start');
      } else if (held > START_BOOST_WINDOW && held <= START_BOOST_WEAK_WINDOW) {
        p.kart.applyBoost(0.2, 0.6, 'start');
      }
    }
    for (const tr of this.trackers) {
      if (tr.aiStartBoost) tr.kart.applyBoost(0.3, 0.8, 'start');
    }
  }

  private updateRacing(dt: number): void {
    this.time += dt;

    for (const tr of this.trackers) {
      this.updateTracker(tr, dt);
    }

    this.sortOrder();
    this.updatePlaces(dt);

    if (this.phase === 'racing' && this.playerFinishedAt >= 0 && !this.allFinishedEmitted) {
      const allDone = this.finishedCount >= this.trackers.length;
      if (allDone || this.time - this.playerFinishedAt >= FINISH_GRACE_SECONDS) {
        this.forceFinishRemaining();
        this.phase = 'complete';
        this.allFinishedEmitted = true;
        events.emit('race:allFinished', {});
      }
    }
  }

  private updateTracker(tr: Tracker, dt: number): void {
    const kart = tr.kart;
    const s = kart.state;

    // Respawn freeze.
    if (tr.respawnFreeze > 0) {
      tr.respawnFreeze -= dt;
      if (tr.respawnFreeze <= 0) {
        tr.respawnFreeze = 0;
        kart.setFrozen(false);
      }
      return;
    }

    const t = wrap01(s.trackT);

    // --- checkpoints (in order, tolerate skipping one) ------------------------
    if (!s.finished) {
      const n = this.checkpointT.length;
      for (let iter = 0; iter < 2; iter++) {
        const cpT = this.checkpointT[tr.nextCheckpoint];
        const d = trackDelta(cpT, t);
        if (d < 0 || d >= CHECKPOINT_WINDOW_SECTORS / n) break;
        this.passCheckpoint(tr);
        if (s.finished) break;
      }
    }

    // --- progress (monotonic) ----------------------------------------------
    const progress = this.computeProgress(tr);
    if (progress > s.raceProgress) s.raceProgress = progress;

    // --- wrong way ----------------------------------------------------------
    if (!s.finished) {
      const smp = this.track.sample(t, this.sample);
      const along = s.velocity.x * smp.tangent.x + s.velocity.y * smp.tangent.y + s.velocity.z * smp.tangent.z;
      if (along < WRONG_WAY_SPEED) {
        tr.wrongWayTimer += dt;
        if (tr.wrongWayTimer >= WRONG_WAY_SECONDS && !s.wrongWay) {
          s.wrongWay = true;
          events.emit('race:wrongWay', { kartId: s.id, wrongWay: true });
        }
      } else if (along > 0.5) {
        tr.wrongWayTimer = 0;
        if (s.wrongWay) {
          s.wrongWay = false;
          events.emit('race:wrongWay', { kartId: s.id, wrongWay: false });
        }
      }
    } else if (s.wrongWay) {
      s.wrongWay = false;
      events.emit('race:wrongWay', { kartId: s.id, wrongWay: false });
    }

    // --- respawn: void / fall / stuck ---------------------------------------
    let respawn = false;
    if (s.position.y < VOID_Y) {
      respawn = true;
    } else if (s.surface === 'void') {
      tr.voidTimer += dt;
      if (tr.voidTimer >= VOID_SECONDS) respawn = true;
    } else {
      tr.voidTimer = 0;
    }

    if (!respawn && !s.finished && !s.isFrozen) {
      const wantsToMove = s.isPlayer ? kart.input.throttle > 0.3 || kart.input.brake > 0.3 : true;
      if (Math.abs(s.speed) < STUCK_SPEED && wantsToMove && !s.isSpinning && !s.isSquished) {
        tr.stuckTimer += dt;
        if (tr.stuckTimer >= STUCK_SECONDS) respawn = true;
      } else {
        tr.stuckTimer = 0;
      }
    }

    if (respawn) this.respawn(tr);
  }

  private passCheckpoint(tr: Tracker): void {
    const s = tr.kart.state;
    const n = this.checkpointT.length;
    const idx = tr.nextCheckpoint;
    tr.nextCheckpoint = (idx + 1) % n;
    s.checkpointIndex = tr.nextCheckpoint;

    if (idx !== 0) return;

    // Crossed the finish line in valid order.
    if (!tr.started) {
      tr.started = true;
      tr.lapsCompleted = 0;
      return;
    }
    tr.lapsCompleted++;
    const newLap = tr.lapsCompleted + 1;
    if (tr.lapsCompleted >= this.totalLaps) {
      this.finish(tr);
      return;
    }
    s.lap = newLap;
    events.emit('race:lap', {
      kartId: s.id,
      lap: newLap,
      totalLaps: this.totalLaps,
      isPlayer: s.isPlayer,
      isFinalLap: newLap === this.totalLaps,
    });
  }

  private finish(tr: Tracker): void {
    const s = tr.kart.state;
    if (s.finished) return;
    s.finished = true;
    s.finishTime = this.time;
    s.lap = this.totalLaps + 1;
    this.finishedCount++;
    s.place = this.finishedCount;
    tr.emittedPlace = s.place;
    tr.candidatePlace = s.place;
    s.wrongWay = false;
    if (s.isPlayer && this.playerFinishedAt < 0) this.playerFinishedAt = this.time;
    events.emit('race:finish', { kartId: s.id, place: s.place, time: s.finishTime, isPlayer: s.isPlayer });
  }

  private forceFinishRemaining(): void {
    // Current order is already sorted: finished first, then by progress.
    for (const tr of this.order) {
      if (!tr.kart.state.finished) this.finish(tr);
    }
  }

  private computeProgress(tr: Tracker): number {
    const s = tr.kart.state;
    const n = this.checkpointT.length;
    const prev = (tr.nextCheckpoint - 1 + n) % n;
    const anchor = this.checkpointT[prev];
    // Unwrap t relative to the last validated checkpoint so a kart that reverses
    // back over the line reads as slightly negative instead of jumping to ~1.
    const frac = anchor + trackDelta(anchor, wrap01(s.trackT));
    // lapsCompleted is -1 until the first line crossing, so grid karts sit just below 0.
    return tr.lapsCompleted + frac;
  }

  private sortOrder(): void {
    // Insertion sort: 8 items, stable, allocation-free.
    const arr = this.order;
    for (let i = 1; i < arr.length; i++) {
      const item = arr[i];
      let j = i - 1;
      while (j >= 0 && this.compare(arr[j], item) > 0) {
        arr[j + 1] = arr[j];
        j--;
      }
      arr[j + 1] = item;
    }
  }

  private compare(a: Tracker, b: Tracker): number {
    const sa = a.kart.state;
    const sb = b.kart.state;
    if (sa.finished && sb.finished) return sa.place - sb.place;
    if (sa.finished) return -1;
    if (sb.finished) return 1;
    if (sb.raceProgress !== sa.raceProgress) return sb.raceProgress - sa.raceProgress;
    return sa.id - sb.id;
  }

  private updatePlaces(dt: number): void {
    for (let i = 0; i < this.order.length; i++) {
      const tr = this.order[i];
      const s = tr.kart.state;
      const place = i + 1;
      if (!s.finished) s.place = place;
      const target = s.place;
      if (target !== tr.candidatePlace) {
        tr.candidatePlace = target;
        tr.candidateTimer = 0;
      } else if (target !== tr.emittedPlace) {
        tr.candidateTimer += dt;
        if (tr.candidateTimer >= PLACE_DEBOUNCE_SECONDS || s.finished) {
          const from = tr.emittedPlace;
          tr.emittedPlace = target;
          events.emit('race:positionChange', { kartId: s.id, from, to: target, isPlayer: s.isPlayer });
        }
      }
    }
  }

  private respawn(tr: Tracker): void {
    const kart = tr.kart;
    const s = kart.state;
    const n = this.checkpointT.length;
    const idx = (tr.nextCheckpoint - 1 + n) % n;
    const cp = this.track.checkpoints[idx];
    let heading: number;
    if (cp) {
      this.tmpPos.copy(cp.position);
      heading = Math.atan2(-cp.forward.x, -cp.forward.z);
    } else {
      const smp = this.track.sample(this.checkpointT[idx], this.sample);
      this.tmpPos.copy(smp.position);
      heading = Math.atan2(-smp.tangent.x, -smp.tangent.z);
    }
    this.tmpPos.y += 0.35;
    this.tmpEuler.set(0, heading, 0);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    kart.resetTo(this.tmpPos, this.tmpQuat);
    s.trackT = this.checkpointT[idx];
    s.wrongWay = false;
    tr.wrongWayTimer = 0;
    tr.voidTimer = 0;
    tr.stuckTimer = 0;
    tr.respawnCount++;
    kart.setFrozen(true);
    tr.respawnFreeze = RESPAWN_FREEZE_SECONDS;
    events.emit('kart:respawn', { kartId: s.id, position: this.tmpPos.clone() });
  }
}
