/**
 * Runs one online race on the client side.
 *
 * Ownership is the whole design. Every kart is simulated by exactly one client:
 * your own kart by you, and the CPU field by the host. That client sends its
 * karts' state ~20 times a second; everyone else runs the same physics from the
 * inputs in those snapshots and nudges the result back toward the authoritative
 * position, so remote karts still drift, bounce and throw up dust locally
 * instead of sliding around like cursors.
 *
 * Damage follows the same rule (see ItemManager.owns): a kart is only ever hit
 * by the client that owns it, so two clients can never both decide the same kart
 * was struck by the same shell.
 */
import * as THREE from 'three';
import type { IItemManager, IKart, ItemType } from '../core/types';
import { ALL_ITEM_TYPES, createEmptyInput } from '../core/types';
import { events } from '../core/events';
import type { NetClient } from './NetClient';
import type { KartSnapshot, NetEvent } from './protocol';
import {
  CPU_SNAPSHOT_DIVISOR,
  SNAPSHOT_HZ,
  STATUS_AIR,
  STATUS_BOOST,
  STATUS_FINISHED,
  STATUS_ROULETTE,
  STATUS_SHRUNK,
  STATUS_SPIN,
  STATUS_SQUISH,
  STATUS_STAR,
} from './protocol';

/** Beyond this much position error we stop easing and just teleport. */
const SNAP_DISTANCE = 9;
/**
 * Exponential convergence rate for position and heading correction. Scaled up
 * with the size of the error: a centimetre of drift should be nudged away over
 * several frames (correcting it hard is what makes remote karts jitter), while
 * half a car length needs pulling in now.
 */
const CORRECTION_RATE = 5;
const CORRECTION_RATE_PER_METRE = 3.5;
const MAX_CORRECTION_RATE = 22;
/** A snapshot older than this means the owner went quiet; coast on last input. */
const STALE_SECONDS = 2;
/**
 * How far ahead of a snapshot we are willing to guess. Every snapshot describes
 * where a kart was half a round trip ago, so correcting straight onto it drags
 * remote karts permanently backwards - at 80 km/h and 90 ms of latency that is
 * a full car length of error that never goes away. Extrapolating along the
 * kart's own heading closes it. Past a third of a second the guess is worth
 * less than the error it introduces, so it stops there.
 */
const MAX_EXTRAPOLATION = 0.34;
/** Sanity clamp on the yaw rate estimated from consecutive snapshots (rad/s). */
const MAX_YAW_RATE = 4;

interface RemoteSlot {
  kart: IKart;
  snapshot: KartSnapshot | null;
  /** Seconds since `snapshot` arrived. */
  age: number;
  /** Yaw rate estimated from the last two snapshots, radians per second. */
  yawRate: number;
}

const _target = new THREE.Vector3();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

export class NetRace {
  /** Kart ids this client simulates. ItemManager and Game both read this. */
  readonly owned = new Set<number>();

  /** Server-arbitrated finishing places, kartId -> place. */
  readonly places = new Map<number, number>();

  private readonly remotes = new Map<number, RemoteSlot>();
  private readonly localKarts: IKart[] = [];
  private readonly outbox: KartSnapshot[] = [];
  private readonly unsubs: (() => void)[] = [];
  private sendTimer = 0;
  private tick = 0;
  private reported = new Set<number>();
  private disposed = false;

  constructor(
    private readonly net: NetClient,
    private readonly karts: readonly IKart[],
    private readonly items: IItemManager,
    ownedIds: readonly number[],
  ) {
    for (const id of ownedIds) this.owned.add(id);
    for (const kart of karts) {
      if (this.owned.has(kart.state.id)) this.localKarts.push(kart);
      else this.remotes.set(kart.state.id, { kart, snapshot: null, age: 0, yawRate: 0 });
    }
    this.items.owns = (id) => this.owned.has(id);

    this.net.onStates = (snapshots) => this.receiveStates(snapshots);
    this.net.onEvent = (event) => this.receiveEvent(event);
    this.net.onOrder = (order) => {
      this.places.set(order.kartId, order.place);
    };

    // A kart we own being struck consumes the projectile everywhere, not just here.
    this.unsubs.push(
      events.on('item:hit', (e) => {
        if (!this.owned.has(e.kartId) || e.sourceKartId < 0) return;
        this.net.sendEvent({
          t: 'kill',
          owner: e.sourceKartId,
          kind: Math.max(0, ALL_ITEM_TYPES.indexOf(e.item)),
          x: e.position.x,
          z: e.position.z,
        });
      }),
      events.on('item:use', (e) => {
        if (!this.owned.has(e.kartId)) return;
        const kart = this.find(e.kartId);
        const back = kart ? kart.input.brake > 0.5 || kart.input.lookBack : false;
        this.net.sendEvent({ t: 'use', i: e.kartId, item: Math.max(0, ALL_ITEM_TYPES.indexOf(e.item)), back });
      }),
      events.on('kart:respawn', (e) => {
        if (this.owned.has(e.kartId)) this.net.sendEvent({ t: 'respawn', i: e.kartId });
      }),
      events.on('race:finish', (e) => {
        if (!this.owned.has(e.kartId) || this.reported.has(e.kartId)) return;
        this.reported.add(e.kartId);
        this.net.sendFinish({ kartId: e.kartId, time: e.time });
      }),
    );
  }

  /**
   * Feeds the last received inputs to remote karts. Call before the karts are
   * stepped, so their own physics produces this frame's motion.
   */
  applyRemoteInputs(dt: number): void {
    for (const slot of this.remotes.values()) {
      slot.age += dt;
      const snap = slot.snapshot;
      const input = createEmptyInput();
      if (snap && slot.age < STALE_SECONDS) {
        input.throttle = snap.th;
        input.brake = snap.br;
        input.steer = snap.st;
        input.drift = snap.d !== 0;
      }
      slot.kart.setInput(input);
    }
  }

  /**
   * Eases remote karts toward the authoritative pose. Call after the karts have
   * been stepped.
   */
  correctRemotes(dt: number): void {
    // Half a round trip is how stale a freshly arrived snapshot already is.
    const latency = Math.min(MAX_EXTRAPOLATION, this.net.pingMs / 2000);
    for (const slot of this.remotes.values()) {
      const snap = slot.snapshot;
      if (!snap) continue;
      const s = slot.kart.state;

      // Where the owner's kart most likely is *now*, not where it was when the
      // packet left: advance it along its own arc by latency + time since arrival.
      const lead = Math.min(MAX_EXTRAPOLATION, latency + slot.age);
      const midHeading = snap.h + slot.yawRate * lead * 0.5;
      const travel = snap.s * lead;
      _target.set(snap.x - Math.sin(midHeading) * travel, snap.y, snap.z - Math.cos(midHeading) * travel);
      const targetHeading = snap.h + slot.yawRate * lead;

      const error = s.position.distanceTo(_target);
      if (error > SNAP_DISTANCE) {
        // Too far gone to hide: teleport rather than skate across the track.
        _euler.set(0, targetHeading, 0);
        _quat.setFromEuler(_euler);
        slot.kart.resetTo(_target, _quat);
      } else {
        const rate = Math.min(MAX_CORRECTION_RATE, CORRECTION_RATE + error * CORRECTION_RATE_PER_METRE);
        const blend = 1 - Math.exp(-rate * dt);
        s.position.lerp(_target, blend);
        let dh = targetHeading - s.heading;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        s.heading += dh * blend;
        _euler.set(0, s.heading, 0);
        s.quaternion.setFromEuler(_euler);
        s.speed += (snap.s - s.speed) * blend;
      }

      // Presentation-only state the owner is authoritative for.
      s.lap = snap.l;
      s.raceProgress = snap.p;
      s.item = snap.it >= 0 ? (ALL_ITEM_TYPES[snap.it] as ItemType) : 'none';
      s.itemCount = snap.ic;
      s.driftStage = Math.max(0, Math.min(3, snap.dg)) as 0 | 1 | 2 | 3;
      s.driftDirection = (snap.d < 0 ? -1 : snap.d > 0 ? 1 : 0) as -1 | 0 | 1;
      s.isDrifting = snap.d !== 0;
      s.isBoosting = (snap.f & STATUS_BOOST) !== 0;
      s.isSpinning = (snap.f & STATUS_SPIN) !== 0;
      s.isInvincible = (snap.f & STATUS_STAR) !== 0;
      s.isShrunk = (snap.f & STATUS_SHRUNK) !== 0;
      s.isSquished = (snap.f & STATUS_SQUISH) !== 0;
      s.isAirborne = (snap.f & STATUS_AIR) !== 0;
      s.itemRouletteActive = (snap.f & STATUS_ROULETTE) !== 0;
      if ((snap.f & STATUS_FINISHED) !== 0) s.finished = true;
    }
  }

  /** Sends our karts' state at a fixed rate. Call once per rendered frame. */
  send(dt: number): void {
    if (this.disposed) return;
    this.net.updatePing(dt);
    if (this.localKarts.length === 0) return;
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer += 1 / SNAPSHOT_HZ;
    if (this.sendTimer < 0) this.sendTimer = 1 / SNAPSHOT_HZ;
    this.tick++;
    // The host owns the CPU field as well as its own kart. CPUs go out at half
    // rate: nobody is side-by-side with them at the line, and it halves what the
    // host has to push upstream every tick.
    const sendCpus = this.tick % CPU_SNAPSHOT_DIVISOR === 0;

    this.outbox.length = 0;
    for (const kart of this.localKarts) {
      const s = kart.state;
      if (!sendCpus && !s.isPlayer && this.localKarts.length > 1) continue;
      const input = kart.input;
      let f = 0;
      if (s.isBoosting) f |= STATUS_BOOST;
      if (s.isSpinning) f |= STATUS_SPIN;
      if (s.isInvincible) f |= STATUS_STAR;
      if (s.isShrunk) f |= STATUS_SHRUNK;
      if (s.isSquished) f |= STATUS_SQUISH;
      if (s.isAirborne) f |= STATUS_AIR;
      if (s.finished) f |= STATUS_FINISHED;
      if (s.itemRouletteActive) f |= STATUS_ROULETTE;
      this.outbox.push({
        i: s.id,
        x: round(s.position.x),
        y: round(s.position.y),
        z: round(s.position.z),
        h: round(s.heading, 3),
        s: round(s.speed),
        st: round(input.steer, 2),
        th: round(input.throttle, 2),
        br: round(input.brake, 2),
        d: s.driftDirection,
        dg: s.driftStage,
        l: s.lap,
        p: round(s.raceProgress, 3),
        it: s.item === 'none' ? -1 : ALL_ITEM_TYPES.indexOf(s.item),
        ic: s.itemCount,
        f,
      });
    }
    this.net.sendStates(this.outbox);
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.items.owns = null;
    this.net.onStates = null;
    this.net.onEvent = null;
    this.net.onOrder = null;
    this.remotes.clear();
    this.localKarts.length = 0;
  }

  // --- inbound -------------------------------------------------------------

  private receiveStates(snapshots: KartSnapshot[]): void {
    for (const snap of snapshots) {
      // The server relays the whole room, our own karts included; those we drop.
      const slot = this.remotes.get(snap.i);
      if (!slot) continue;
      const prev = slot.snapshot;
      if (prev && slot.age > 1e-3 && slot.age < STALE_SECONDS) {
        let dh = snap.h - prev.h;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        const rate = dh / slot.age;
        slot.yawRate = Math.max(-MAX_YAW_RATE, Math.min(MAX_YAW_RATE, rate));
      } else {
        slot.yawRate = 0;
      }
      slot.snapshot = snap;
      slot.age = 0;
    }
  }

  private receiveEvent(event: NetEvent): void {
    switch (event.t) {
      case 'use': {
        // Replay the throw locally so the projectile exists on this screen too.
        const kart = this.find(event.i);
        if (!kart || this.owned.has(event.i)) return;
        const item = ALL_ITEM_TYPES[event.item] as ItemType | undefined;
        if (!item) return;
        const s = kart.state;
        s.item = item;
        s.itemCount = Math.max(1, s.itemCount);
        s.itemRouletteActive = false;
        this.items.requestUse(kart, event.back);
        return;
      }
      case 'kill': {
        // Our projectile hit someone else's kart; drop our copy of it.
        this.items.killHazardNear?.(event.owner, ALL_ITEM_TYPES[event.kind] as ItemType, event.x, event.z);
        return;
      }
      case 'respawn': {
        // Nothing to do: the respawn shows up in the next position snapshot.
        return;
      }
      case 'lap':
        return;
    }
  }

  private find(kartId: number): IKart | null {
    for (const k of this.karts) if (k.state.id === kartId) return k;
    return null;
  }
}

function round(v: number, places = 2): number {
  const m = 10 ** places;
  return Math.round(v * m) / m;
}
