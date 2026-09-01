/**
 * AIDriver - computes InputState for a CPU kart every fixed step.
 *
 * Racing line (centerline + personality offset + corner-inside bias), PD
 * steering toward a speed-scaled look-ahead point, drifting on corners,
 * hazard dodging, item-box seeking, item usage with reaction delays,
 * rubber-banding against the player and stuck / wrong-way recovery.
 * `update` is allocation-free (module scratch vectors).
 */
import * as THREE from 'three';
import type {
  Difficulty,
  IAIDriver,
  IItemManager,
  IKart,
  ITrack,
  InputState,
  ItemType,
  TrackSample,
} from '../core/types';
import { createEmptyInput } from '../core/types';
import { events } from '../core/events';
import { clamp, damp, seededRandom, trackDelta, wrap01 } from '../core/math';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const K_P = 2.2;
const K_D = 0.15;
const LOOKAHEAD_MIN = 8;
const LOOKAHEAD_MAX = 30;
const HAZARD_LOOKAHEAD = 25;
const HAZARD_LATERAL = 2.2;
const DODGE_CLEARANCE = 2.6;
const BOX_SEEK_DISTANCE = 60;
const STUCK_SECONDS = 1.5;
const REVERSE_SECONDS = 0.8;
const RECOVER_COOLDOWN = 2.5;

interface DifficultyProfile {
  noise: number;
  reactionMin: number;
  reactionMax: number;
  driftThreshold: number;
  releaseStage: 1 | 2 | 3;
  brakeLatAccel: number;
  easeThrottle: number;
  usesMushrooms: boolean;
  startThrottleBeforeGo: number;
}

const PROFILES: Record<Difficulty, DifficultyProfile> = {
  easy: {
    noise: 0.09,
    reactionMin: 1.0,
    reactionMax: 1.5,
    driftThreshold: 0.45,
    releaseStage: 1,
    brakeLatAccel: 34,
    easeThrottle: 0.6,
    usesMushrooms: false,
    startThrottleBeforeGo: 0.55,
  },
  normal: {
    noise: 0.045,
    reactionMin: 0.6,
    reactionMax: 1.0,
    driftThreshold: 0.35,
    releaseStage: 2,
    brakeLatAccel: 46,
    easeThrottle: 0.65,
    usesMushrooms: true,
    startThrottleBeforeGo: 0.45,
  },
  hard: {
    noise: 0.015,
    reactionMin: 0.4,
    reactionMax: 0.6,
    driftThreshold: 0.3,
    releaseStage: 3,
    brakeLatAccel: 62,
    easeThrottle: 0.75,
    usesMushrooms: true,
    startThrottleBeforeGo: 0.3,
  },
};

// ---------------------------------------------------------------------------
// Module scratch
// ---------------------------------------------------------------------------

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _target = new THREE.Vector3();

function makeSample(): TrackSample {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: 6,
    wallHalfWidth: 7,
    t: 0,
  };
}

const _s0 = makeSample();
const _s1 = makeSample();
const _s2 = makeSample();
const _s3 = makeSample();

/** Signed heading change from tangent a to tangent b (radians, + = turning right). */
function signedTurn(a: THREE.Vector3, b: THREE.Vector3): number {
  const cross = a.z * b.x - a.x * b.z; // (a x b).y
  const dot = a.x * b.x + a.z * b.z;
  return Math.atan2(-cross, dot);
}

// Countdown tracking shared by all drivers (used to time the start boost).
let countdownOneSeen = false;
let listenersInstalled = false;
function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  events.on('race:countdown', ({ count }) => {
    if (count === 1) countdownOneSeen = true;
  });
  events.on('race:start', () => {
    countdownOneSeen = false;
  });
}

type UseMode = 0 | 1 | 2; // none | forward | backward

export class AIDriver implements IAIDriver {
  readonly kart: IKart;

  private difficulty: Difficulty;
  private profile: DifficultyProfile;
  private readonly input: InputState = createEmptyInput();
  private readonly rng: () => number;

  // personality
  private readonly baseOffset: number;
  private readonly offsetDriftAmp: number;
  private readonly offsetDriftFreq: number;
  private readonly offsetPhase: number;
  private readonly skillJitter: number;
  private readonly hesitancy: number;
  private readonly aggression: number;
  private readonly bananaHoldLimit: number;
  private readonly startTimingError: number;

  // running state
  private time = 0;
  private prevAngle = 0;
  private hasPrev = false;
  private dodge = 0;
  private reactTimer = -1;
  private pendingMode: UseMode = 0;
  private holdTime = 0;
  private lastItem: ItemType = 'none';
  private stuckTimer = 0;
  private recoverTimer = 0;
  private recoverCooldown = 0;
  private movedOnce = false;
  private driftWant = false;
  private driftDir: -1 | 0 | 1 = 0;
  private driftHold = 0;
  private driftCooldown = 0;
  private frozenTime = 0;
  private sinceCountOne = -1;

  constructor(kart: IKart, difficulty: Difficulty, personalitySeed: number) {
    installListeners();
    this.kart = kart;
    this.difficulty = difficulty;
    this.profile = PROFILES[difficulty];
    this.rng = seededRandom(personalitySeed);
    const r = this.rng;
    this.baseOffset = (r() * 2 - 1) * 0.45;
    this.offsetDriftAmp = 0.08 + r() * 0.12;
    this.offsetDriftFreq = 0.12 + r() * 0.18;
    this.offsetPhase = r() * Math.PI * 2;
    this.skillJitter = (r() * 2 - 1) * 0.02;
    this.hesitancy = 0.7 + r() * 0.6;
    this.aggression = r();
    this.bananaHoldLimit = 6 + r() * 4;
    this.startTimingError = r();
  }

  setDifficulty(d: Difficulty): void {
    this.difficulty = d;
    this.profile = PROFILES[d];
  }

  // -------------------------------------------------------------------------

  update(dt: number, track: ITrack, karts: readonly IKart[], items: IItemManager, playerKart: IKart | null): InputState {
    const s = this.kart.state;
    const inp = this.input;
    const prof = this.profile;
    this.time += dt;

    // edge-triggered / menu flags are always cleared first
    inp.useItem = false;
    inp.useItemHeld = false;
    inp.lookBack = false;
    inp.pause = false;
    inp.confirm = false;
    inp.back = false;
    inp.menuUp = inp.menuDown = inp.menuLeft = inp.menuRight = false;

    this.driftCooldown = Math.max(0, this.driftCooldown - dt);
    this.recoverCooldown = Math.max(0, this.recoverCooldown - dt);

    const speed = s.speed;
    const top = Math.max(1, this.kart.topSpeed());
    if (speed > 3) this.movedOnce = true;

    this.kart.forwardDir(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.set(-_fwd.z, 0, _fwd.x);

    // ----- frozen on the grid: time the start boost -----------------------
    if (s.isFrozen) {
      this.frozenTime += dt;
      if (countdownOneSeen) this.sinceCountOne = this.sinceCountOne < 0 ? 0 : this.sinceCountOne + dt;
      let throttleAt: number;
      if (this.sinceCountOne >= 0) {
        throttleAt = 1 - prof.startThrottleBeforeGo;
        if (this.difficulty === 'easy' && this.startTimingError < 0.35) throttleAt = this.startTimingError < 0.15 ? 0.05 : 1.3;
        if (this.difficulty === 'normal') throttleAt += (this.startTimingError - 0.5) * 0.3;
      } else {
        throttleAt = 2.75; // fallback: assume freeze started with the 3-2-1 countdown
      }
      const elapsed = this.sinceCountOne >= 0 ? this.sinceCountOne : this.frozenTime;
      inp.throttle = elapsed >= throttleAt ? 1 : 0;
      inp.brake = 0;
      inp.steer = 0;
      inp.drift = false;
      this.hasPrev = false;
      this.kart.setInput(inp);
      return inp;
    }
    this.frozenTime = 0;
    this.sinceCountOne = -1;

    // ----- spinning / squished: hold throttle, do nothing clever -----------
    if (s.isSpinning) {
      inp.throttle = 1;
      inp.brake = 0;
      inp.steer = 0;
      inp.drift = false;
      this.driftWant = false;
      this.hasPrev = false;
      this.kart.setInput(inp);
      return inp;
    }

    // ----- track frames ------------------------------------------------------
    const len = Math.max(1, track.length);
    const t = s.trackT;
    const L = clamp(Math.max(speed, 0) * 0.9, LOOKAHEAD_MIN, LOOKAHEAD_MAX);
    track.sample(t, _s0);
    track.sample(wrap01(t + L / len), _s1);
    track.sample(wrap01(t + (2 * L) / len), _s2);
    const turn1 = signedTurn(_s0.tangent, _s1.tangent);
    const turn2 = signedTurn(_s1.tangent, _s2.tangent);
    const hw = Math.max(2, _s1.halfWidth);

    _rel.subVectors(s.position, _s0.position);
    const kartLat = _rel.dot(_s0.binormal);
    const tangentAngle = Math.atan2(_s0.tangent.dot(_right), _s0.tangent.dot(_fwd));

    // ----- recovery (reverse for a bit) --------------------------------------
    if (this.recoverTimer > 0) {
      this.recoverTimer -= dt;
      inp.throttle = 0;
      inp.brake = 1;
      inp.steer = -Math.sign(tangentAngle) * 0.9;
      inp.drift = false;
      this.driftWant = false;
      this.hasPrev = false;
      this.kart.setInput(inp);
      return inp;
    }
    const stuck = this.movedOnce && !s.isAirborne && Math.abs(speed) < 1 && !s.finished;
    this.stuckTimer = stuck ? this.stuckTimer + dt : 0;
    if (this.recoverCooldown <= 0 && ((s.wrongWay && Math.abs(speed) < 6 && this.movedOnce) || this.stuckTimer > STUCK_SECONDS)) {
      this.recoverTimer = REVERSE_SECONDS;
      this.recoverCooldown = RECOVER_COOLDOWN + REVERSE_SECONDS;
      this.stuckTimer = 0;
      this.driftWant = false;
    }

    // ----- lateral target: personality + corner inside bias ------------------
    const offsetFrac = this.baseOffset + Math.sin(this.time * this.offsetDriftFreq + this.offsetPhase) * this.offsetDriftAmp;
    const insideBias = clamp(turn1 * 0.9 + turn2 * 0.35, -0.4, 0.4);
    let latTarget = clamp(offsetFrac + insideBias, -0.6, 0.6) * hw;

    // item boxes when empty-handed
    if (s.item === 'none' && !s.itemRouletteActive) {
      const boxes = items.getActiveBoxPositions();
      let bestAhead = BOX_SEEK_DISTANCE;
      let found = false;
      let boxAhead = 0;
      let boxX = 0;
      let boxZ = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const dx = b.x - s.position.x;
        const dz = b.z - s.position.z;
        const ahead = dx * _fwd.x + dz * _fwd.z;
        if (ahead < 2 || ahead >= bestAhead) continue;
        const lat = dx * _right.x + dz * _right.z;
        if (Math.abs(lat) > hw * 1.6) continue;
        bestAhead = ahead;
        boxAhead = ahead;
        boxX = b.x;
        boxZ = b.z;
        found = true;
      }
      if (found) {
        track.sample(wrap01(t + boxAhead / len), _s3);
        const boxLat = (boxX - _s3.position.x) * _s3.binormal.x + (boxZ - _s3.position.z) * _s3.binormal.z;
        const w = clamp(1.15 - boxAhead / BOX_SEEK_DISTANCE, 0.35, 1);
        latTarget = latTarget + (clamp(boxLat, -hw + 0.8, hw - 0.8) - latTarget) * w;
      }
    }

    // ----- hazards: dodge + detect incoming shells -----------------------------
    let dodgeTarget = 0;
    let nearestHazard = HAZARD_LOOKAHEAD;
    let threatBehind = false;
    const hazards = items.getHazards();
    for (let i = 0; i < hazards.length; i++) {
      const h = hazards[i];
      const dx = h.position.x - s.position.x;
      const dz = h.position.z - s.position.z;
      const ahead = dx * _fwd.x + dz * _fwd.z;
      const lat = dx * _right.x + dz * _right.z;
      const vAlong = h.velocity.x * _fwd.x + h.velocity.z * _fwd.z;
      if (ahead > 0 && ahead < HAZARD_LOOKAHEAD) {
        if (h.ownerId === s.id && vAlong > 5) continue; // our own shell running away
        // moving hazards: predict where they will be when we get there
        let predLat = lat;
        if (vAlong < -3) predLat += (h.velocity.x * _right.x + h.velocity.z * _right.z) * (ahead / Math.max(1, speed - vAlong));
        if (Math.abs(predLat) < HAZARD_LATERAL && ahead < nearestHazard) {
          nearestHazard = ahead;
          const hazardTrackLat = kartLat + predLat;
          const roomRight = hw - hazardTrackLat;
          const roomLeft = hw + hazardTrackLat;
          const side = roomRight > roomLeft ? 1 : -1;
          const urgency = 0.55 + 0.45 * (1 - ahead / HAZARD_LOOKAHEAD);
          dodgeTarget = (side * DODGE_CLEARANCE - predLat) * urgency;
        }
      } else if (ahead < 0 && ahead > -12 && vAlong > 4 && Math.abs(lat) < 2.2) {
        threatBehind = true;
      }
    }
    this.dodge = damp(this.dodge, dodgeTarget, 9, dt);
    latTarget += this.dodge;

    if (s.surface === 'offroad') latTarget = 0;
    latTarget = clamp(latTarget, -(hw - 1.4), hw - 1.4);

    // ----- steering (PD toward look-ahead point) -------------------------------
    // Pure pursuit cuts inside on sustained bends; pull the aim point back toward
    // the desired line proportionally to the current lateral error.
    const aimLat = clamp(latTarget + clamp((latTarget - kartLat) * 1.0, -3.5, 3.5), -(hw - 0.5), hw - 0.5);
    _target.copy(_s1.position).addScaledVector(_s1.binormal, aimLat);
    _rel.subVectors(_target, s.position);
    _rel.y = 0;
    const angle = Math.atan2(_rel.dot(_right), _rel.dot(_fwd));
    let dAngle = this.hasPrev ? (angle - this.prevAngle) / Math.max(dt, 1e-4) : 0;
    dAngle = clamp(dAngle, -6, 6);
    this.prevAngle = angle;
    this.hasPrev = true;
    let steer = K_P * angle + K_D * dAngle;
    steer += prof.noise * Math.sin(this.time * 1.9 + this.offsetPhase) * Math.sin(this.time * 0.73 + this.offsetPhase * 2);
    if (s.surface === 'offroad') steer *= 1.3;
    steer = clamp(steer, -1, 1);

    // ----- throttle ---------------------------------------------------------------
    let throttle = 1;
    const curvature = Math.abs(turn1) / L;
    const latAccel = speed * speed * curvature;
    if (latAccel > prof.brakeLatAccel && speed > 0.6 * top && !s.isBoosting) throttle = prof.easeThrottle;
    if (s.wrongWay) throttle = 0.5;

    // rubber-banding against the player
    let gap = 0;
    if (playerKart && playerKart !== this.kart) gap = (playerKart.state.raceProgress - s.raceProgress) * len;
    const factor = this.speedFactor(gap) * (1 + this.skillJitter);
    const targetSpeed = factor * top;
    if (!s.isBoosting && speed > targetSpeed) {
      throttle = Math.min(throttle, clamp(1 - (speed - targetSpeed) / (0.05 * top), 0, 1));
    }

    // ----- drifting -----------------------------------------------------------------
    // turnP: heading change needed over the next ~1.2 s; turnFar: over the next ~2.4 s.
    const Lp = clamp(Math.max(speed, 0) * 1.2, 6, LOOKAHEAD_MAX);
    track.sample(wrap01(t + Lp / len), _s3);
    const turnP = signedTurn(_fwd, _s3.tangent);
    const turnFar = turnP + signedTurn(_s3.tangent, _s2.tangent);
    const onRoad = s.surface !== 'offroad' && s.surface !== 'void';
    let drift = false;

    if (
      !this.driftWant &&
      this.driftCooldown <= 0 &&
      onRoad &&
      !s.isAirborne &&
      !s.isHopping &&
      speed > 0.55 * top &&
      Math.abs(turnP) > prof.driftThreshold &&
      Math.abs(turnFar) > prof.driftThreshold * 1.4 &&
      Math.sign(turnFar) === Math.sign(turnP) &&
      (this.difficulty !== 'easy' || this.aggression > 0.4)
    ) {
      this.driftWant = true;
      this.driftDir = turnP > 0 ? 1 : -1;
      this.driftHold = 0;
    }

    if (this.driftWant) {
      this.driftHold += dt;
      drift = true;
      if (s.isDrifting && s.driftDirection !== 0) this.driftDir = s.driftDirection;
      if (s.isDrifting) {
        // keep the wheel on the drift side (a sign flip would cancel the drift) but let
        // the PD output modulate how tight the drift is
        if (Math.sign(steer) !== this.driftDir || Math.abs(steer) < 0.25) steer = this.driftDir * 0.25;
      } else if (this.driftHold < 0.3) {
        // hop phase: commit to the corner direction so the kart enters the drift
        steer = this.driftDir * Math.max(0.5, Math.abs(steer));
      }
      const stage = s.driftStage;
      let releaseStage: number = prof.releaseStage;
      if (this.difficulty === 'hard' && Math.abs(turnFar) < 0.5) releaseStage = 2;
      // heading has reached (or swung past) the aim direction -> corner is done
      const overRotated = Math.sign(angle) === -this.driftDir && Math.abs(angle) > 0.12;
      const aligned = Math.abs(angle) < 0.08 && Math.abs(turnP) < 0.15;
      // about to run out of road on the inside
      const insideEdge = this.driftDir * kartLat > hw - 1.6;
      let release = false;
      if (s.isDrifting && stage >= releaseStage) release = true;
      else if (s.isDrifting && this.driftHold > 0.25 && (overRotated || aligned || insideEdge)) release = true;
      else if (!s.isDrifting && this.driftHold > 0.6) release = true;
      else if (!onRoad || speed < 0.35 * top || this.driftHold > 3.2) release = true;
      if (release) {
        this.driftWant = false;
        drift = false;
        // an aborted drift (no stage reached) means this corner does not suit drifting;
        // wait longer before hopping again so the kart does not bunny-hop along the bend
        this.driftCooldown = stage >= 1 ? 0.6 : 1.6;
      }
    }

    // ----- items -----------------------------------------------------------------------
    if (s.item !== this.lastItem) {
      this.lastItem = s.item;
      this.holdTime = 0;
      this.reactTimer = -1;
      this.pendingMode = 0;
    }
    if (s.item !== 'none' && !s.itemRouletteActive && s.itemCount > 0) {
      this.holdTime += dt;
      const mode = this.decideItemUse(s.item, karts, gap, turn1, turn2, threatBehind, top);
      if (mode !== 0) {
        if (this.reactTimer < 0 || this.pendingMode !== mode) {
          this.pendingMode = mode;
          const quick = threatBehind && mode === 2;
          const base = prof.reactionMin + this.rng() * (prof.reactionMax - prof.reactionMin);
          this.reactTimer = quick ? base * 0.35 : base * this.hesitancy;
          if (s.item === 'star' || s.item === 'golden_mushroom' || s.item === 'triple_mushroom' || s.item === 'mushroom') {
            this.reactTimer *= 0.5;
          }
        } else {
          this.reactTimer -= dt;
          if (this.reactTimer <= 0) {
            inp.useItem = true;
            inp.lookBack = mode === 2;
            this.reactTimer = -1;
            this.pendingMode = 0;
            this.holdTime = 0;
          }
        }
      } else {
        this.reactTimer = -1;
        this.pendingMode = 0;
      }
    }

    // ----- airborne: neutral steering --------------------------------------------------
    if (s.isAirborne && !s.isHopping) steer = 0;

    inp.throttle = clamp(throttle, 0, 1);
    inp.brake = 0;
    inp.steer = steer;
    inp.drift = drift;
    this.kart.setInput(inp);
    return inp;
  }

  // -------------------------------------------------------------------------

  private speedFactor(gap: number): number {
    switch (this.difficulty) {
      case 'easy':
        return clamp(0.86 + 0.06 * Math.tanh(gap / 120), 0.82, 0.96);
      case 'normal':
        return clamp(0.94 + 0.05 * Math.tanh(gap / 100), 0.9, 1.0);
      case 'hard':
      default:
        return clamp(0.985 + 0.02 * Math.tanh(gap / 150), 0.97, 1.0);
    }
  }

  /** Decides whether to use the held item now: 0 = no, 1 = forward, 2 = backward. */
  private decideItemUse(
    item: ItemType,
    karts: readonly IKart[],
    gap: number,
    turn1: number,
    turn2: number,
    threatBehind: boolean,
    top: number,
  ): UseMode {
    const s = this.kart.state;
    const speed = s.speed;
    const straight = Math.abs(turn1) < 0.12 && Math.abs(turn2) < 0.2;

    // scan the field once
    let aheadDist = Infinity;
    let aheadAligned = false;
    let behindDist = Infinity;
    let behindAligned = false;
    let nearestAny = Infinity;
    let redTarget = false;
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (k === this.kart) continue;
      const ks = k.state;
      if (ks.finished) continue;
      const dx = ks.position.x - s.position.x;
      const dz = ks.position.z - s.position.z;
      const ahead = dx * _fwd.x + dz * _fwd.z;
      const lat = dx * _right.x + dz * _right.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestAny) nearestAny = dist;
      if (ahead > 0) {
        if (ahead < aheadDist) {
          aheadDist = ahead;
          aheadAligned = Math.abs(lat) < 1.5 + ahead * 0.12;
        }
        const d = trackDelta(s.trackT, ks.trackT);
        if (d > 0 && d < 0.3) redTarget = true;
      } else if (-ahead < behindDist) {
        behindDist = -ahead;
        behindAligned = Math.abs(lat) < 4;
      }
    }

    switch (item) {
      case 'banana':
      case 'triple_banana':
        if (threatBehind) return 2;
        if (behindDist < 15 && behindAligned) return 2;
        if (this.holdTime > this.bananaHoldLimit) return 2;
        if (this.difficulty === 'hard' && aheadDist > 6 && aheadDist < 20 && aheadAligned && speed > 0.5 * top && this.aggression > 0.5) return 1;
        return 0;
      case 'green_shell':
      case 'triple_green_shell':
        if (threatBehind) return 2;
        if (aheadDist < 45 && aheadAligned && Math.abs(turn1) < 0.25) return 1;
        if (this.difficulty !== 'easy' && behindDist < 10 && behindAligned && this.aggression > 0.6) return 2;
        if (this.holdTime > 15) return 1;
        return 0;
      case 'red_shell':
      case 'triple_red_shell':
        if (threatBehind) return 2;
        if (redTarget && aheadDist < 90) return 1;
        if (this.holdTime > 12) return 1;
        return 0;
      case 'blue_shell':
        return s.place !== 1 && this.holdTime > 2 ? 1 : 0;
      case 'mushroom':
      case 'triple_mushroom':
      case 'golden_mushroom':
        if (s.isBoosting) return 0;
        if (s.surface === 'offroad') return 1;
        if (!this.profile.usesMushrooms) return this.holdTime > 12 ? 1 : 0;
        if (straight && speed > 0.5 * top) return 1;
        if (gap > 80) return 1;
        if (this.holdTime > 8) return 1;
        return 0;
      case 'star':
        if (nearestAny < 20 || this.holdTime > 3) return 1;
        return 0;
      case 'lightning':
        return s.place >= 5 && this.holdTime > 0.8 + this.hesitancy ? 1 : 0;
      case 'bob_omb':
        if (threatBehind) return 2;
        if (aheadDist > 10 && aheadDist < 30 && aheadAligned) return 1;
        if (this.holdTime > 14) return behindDist < 12 ? 2 : 1;
        return 0;
      default:
        return 0;
    }
  }
}
