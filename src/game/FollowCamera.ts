/**
 * Chase camera: sits behind the kart with damped yaw, widens FOV with speed and
 * boost, leans into drifts, flips for look-back, shakes on hits and never dips
 * below the track surface. Also runs the countdown cinematic swoop.
 */
import * as THREE from 'three';
import type { IKart, ITrack, SurfaceQuery } from '../core/types';
import { events } from '../core/events';
import { clamp, clamp01, damp, angleDelta, smoothstep, wrapAngle, lerp } from '../core/math';

const CHASE_DISTANCE = 5.6;
const CHASE_HEIGHT = 2.25;
const LOOK_UP = 0.8;
const LOOK_AHEAD = 2.5;
const FOV_MIN = 68;
const FOV_MAX = 80;
const YAW_LAMBDA = 6;
const YAW_LAMBDA_DRIFT = 3.4;
const YAW_LAMBDA_LOOKBACK = 9;
/** How quickly the look-back blend (0 = ahead, 1 = behind) follows the button. */
const LOOKBACK_BLEND_LAMBDA = 9;
const POS_LAMBDA = 16;
const DRIFT_OFFSET = (12 * Math.PI) / 180;
const MIN_GROUND_CLEARANCE = 0.6;
const MAX_ROLL = 0.045;
const SHAKE_DECAY = 5.5;

function makeSurfaceScratch(): SurfaceQuery {
  return {
    t: 0,
    surface: 'road',
    groundY: 0,
    groundNormal: new THREE.Vector3(0, 1, 0),
    lateral: 0,
    halfWidth: 0,
    wallHalfWidth: 0,
    tangent: new THREE.Vector3(0, 0, -1),
    binormal: new THREE.Vector3(1, 0, 0),
    center: new THREE.Vector3(),
  };
}

export class FollowCamera {
  private readonly camera: THREE.PerspectiveCamera;
  private track: ITrack | null = null;
  private followKartId = -1;
  private initialised = false;

  private yaw = 0;
  private fov = FOV_MIN;
  private roll = 0;
  private lookBackBlend = 0;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();

  private shakeAmp = 0;
  private shakePhase = 0;

  private cine = false;
  private cineTime = 0;
  private cineDuration = 1;
  private cineFovFrom = 50;
  private readonly cineFrom = new THREE.Vector3();
  private readonly cineLookFrom = new THREE.Vector3();

  private readonly desired = new THREE.Vector3();
  private readonly desiredLook = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly surf = makeSurfaceScratch();
  private readonly unsubs: (() => void)[] = [];

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.unsubs.push(
      events.on('kart:collision', (e) => {
        if (e.kartId !== this.followKartId) return;
        this.shake(clamp(e.impulse * 0.05, 0.06, 0.45));
      }),
      events.on('item:hit', (e) => {
        if (e.kartId !== this.followKartId) return;
        this.shake(e.item === 'lightning' ? 0.35 : 0.65);
      }),
      events.on('item:explosion', (e) => {
        // Nearby explosions rumble the camera a little even if we weren't hit.
        const d = this.pos.distanceTo(e.position);
        if (d < e.radius * 4) this.shake(clamp(0.5 - d / (e.radius * 8), 0.05, 0.4));
      }),
    );
  }

  setTrack(track: ITrack | null): void {
    this.track = track;
  }

  /** Snap all smoothing state to the kart's current pose (after teleport / new race). */
  snapTo(kart: IKart): void {
    const s = kart.state;
    this.followKartId = s.id;
    this.yaw = s.heading;
    this.fov = FOV_MIN;
    this.roll = 0;
    this.lookBackBlend = 0;
    this.shakeAmp = 0;
    this.computeChase(kart, 0, this.desired, this.desiredLook);
    this.pos.copy(this.desired);
    this.look.copy(this.desiredLook);
    this.initialised = true;
    this.apply();
  }

  /**
   * Start a cinematic that eases from (fromPos, fromLook, fromFov) into the chase
   * position over `duration` seconds.
   */
  setCinematic(fromPos: THREE.Vector3, fromLook: THREE.Vector3, duration: number, fromFov = 50): void {
    this.cine = true;
    this.cineTime = 0;
    this.cineDuration = Math.max(0.01, duration);
    this.cineFovFrom = fromFov;
    this.cineFrom.copy(fromPos);
    this.cineLookFrom.copy(fromLook);
  }

  get isCinematic(): boolean {
    return this.cine;
  }

  shake(intensity: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, clamp01(intensity));
  }

  update(dt: number, kart: IKart, lookBack: boolean): void {
    const s = kart.state;
    if (!this.initialised || this.followKartId !== s.id) {
      this.snapTo(kart);
    }

    // --- look-back blend (smooth both ways, no snap) --------------------------
    this.lookBackBlend = damp(this.lookBackBlend, lookBack ? 1 : 0, LOOKBACK_BLEND_LAMBDA, dt);
    if (this.lookBackBlend < 0.002) this.lookBackBlend = 0;
    else if (this.lookBackBlend > 0.998) this.lookBackBlend = 1;
    const lb = this.lookBackBlend;

    // --- yaw target ---------------------------------------------------------
    let targetYaw = s.heading;
    let lambda = YAW_LAMBDA;
    if (lookBack) {
      targetYaw += Math.PI;
      lambda = YAW_LAMBDA_LOOKBACK;
    } else if (s.isDrifting && s.driftDirection !== 0) {
      targetYaw -= s.driftDirection * DRIFT_OFFSET;
      lambda = YAW_LAMBDA_DRIFT;
    }
    if (s.isSpinning) lambda *= 0.35; // let the kart spin in frame instead of whipping the camera
    const delta = angleDelta(this.yaw, targetYaw);
    this.yaw = wrapAngle(this.yaw + delta * (1 - Math.exp(-lambda * dt)));

    // --- chase pose ---------------------------------------------------------
    const top = Math.max(1, kart.topSpeed());
    const speedNorm = clamp01(Math.abs(s.speed) / top);
    this.computeChase(kart, speedNorm, this.desired, this.desiredLook);

    if (this.cine) {
      this.cineTime += dt;
      const k = smoothstep(0, 1, this.cineTime / this.cineDuration);
      const e = k * k * (3 - 2 * k); // extra ease-in-out for a slow start, crisp landing
      this.pos.lerpVectors(this.cineFrom, this.desired, e);
      this.look.lerpVectors(this.cineLookFrom, this.desiredLook, e);
      this.fov = lerp(this.cineFovFrom, FOV_MIN, e);
      this.roll = 0;
      if (this.cineTime >= this.cineDuration) {
        this.cine = false;
        this.yaw = s.heading;
      }
    } else {
      const a = 1 - Math.exp(-POS_LAMBDA * dt);
      this.pos.lerp(this.desired, a);
      this.look.lerp(this.desiredLook, 1 - Math.exp(-POS_LAMBDA * 1.4 * dt));

      // --- FOV: speed + boost -----------------------------------------------
      const boostAmount = s.isBoosting ? clamp01(0.5 + s.boostStrength) : 0;
      const targetFov = lerp(FOV_MIN, FOV_MAX, clamp01(speedNorm * speedNorm * 0.7 + boostAmount * 0.5));
      this.fov = damp(this.fov, targetFov, 4, dt);

      // --- roll with steering -----------------------------------------------
      const steer = s.steerVisual * (1 - 2 * lb);
      const driftLean = s.isDrifting ? s.driftDirection * 0.35 * (1 - lb) : 0;
      this.roll = damp(this.roll, -(steer + driftLean) * MAX_ROLL, 5, dt);
    }

    // --- ground clamp -------------------------------------------------------
    if (this.track) {
      const q = this.track.query(this.pos, s.trackT, this.surf);
      const minY = q.groundY + MIN_GROUND_CLEARANCE;
      if (this.pos.y < minY) this.pos.y = minY;
    }

    // --- shake --------------------------------------------------------------
    if (this.shakeAmp > 0.001) {
      this.shakePhase += dt * 60;
      this.shakeAmp = damp(this.shakeAmp, 0, SHAKE_DECAY, dt);
      if (this.shakeAmp < 0.001) this.shakeAmp = 0;
    }

    this.apply();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.track = null;
  }

  // ----------------------------------------------------------------- private

  private computeChase(kart: IKart, speedNorm: number, outPos: THREE.Vector3, outLook: THREE.Vector3): void {
    const s = kart.state;
    const yaw = this.yaw;
    const dist = CHASE_DISTANCE + speedNorm * 0.9 + (s.isBoosting ? 0.45 : 0);
    const height = CHASE_HEIGHT + speedNorm * 0.2;
    // Behind direction for a given yaw (kart forward is (-sin h, 0, -cos h)).
    outPos.set(Math.sin(yaw) * dist, height, Math.cos(yaw) * dist).add(s.position);

    // Look target: kart + up + a bit ahead along the kart's real heading (not the
    // damped camera yaw) so drifting shows the kart sliding across frame. The
    // look-back blend slides the target through the kart to behind it.
    const h = s.heading;
    this.forward.set(-Math.sin(h), 0, -Math.cos(h));
    outLook.copy(s.position).addScaledVector(this.forward, LOOK_AHEAD * (1 - 2 * this.lookBackBlend));
    outLook.y += LOOK_UP;
  }

  private apply(): void {
    const cam = this.camera;
    cam.position.copy(this.pos);
    if (this.shakeAmp > 0) {
      const a = this.shakeAmp * 0.35;
      const p = this.shakePhase;
      this.tmp.set(
        Math.sin(p * 1.3) * a + Math.sin(p * 3.7) * a * 0.5,
        Math.cos(p * 1.7) * a * 0.8 + Math.sin(p * 4.3) * a * 0.4,
        Math.sin(p * 2.1) * a * 0.3,
      );
      cam.position.add(this.tmp);
    }
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    if (this.roll !== 0) cam.rotateZ(this.roll);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
