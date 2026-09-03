/**
 * ItemManager - item boxes, roulette, held/orbiting items, projectiles and
 * hazards (bananas, shells, bob-ombs) plus their collisions with karts.
 *
 * Only talks to the rest of the game through the core interfaces and the event
 * bus. Runs inside the fixed-step loop (`update(dt)`).
 */
import * as THREE from 'three';
import type {
  HazardInfo,
  IItemManager,
  IKart,
  IParticleSystem,
  ITrack,
  ItemType,
  SurfaceQuery,
  TrackSample,
} from '../core/types';
import { events } from '../core/events';
import { GRAVITY, ITEM_BOX_RESPAWN_SECONDS, ITEM_ROULETTE_SECONDS, KART_RADIUS } from '../core/constants';
import { TAU, clamp, lerp, trackDelta, wrap01 } from '../core/math';
import { baseItemType, buildItemMesh, disposeItemVisualCaches } from './itemVisuals';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const MAX_HAZARDS = 40;
const OWNER_GRACE = 0.35;
const BOX_SIZE = 0.95;
const BOX_HOVER = 1.05;
const BOX_PICKUP_RADIUS = KART_RADIUS + 0.9;
const BOX_SCALE_IN = 0.4;
const ROULETTE_TICKS = 10;
const LIGHTNING_COOLDOWN = 20;
const GOLDEN_MIN_SPACING = 0.25;

const GREEN_SPEED = 34;
const RED_SPEED = 30;
const BLUE_SPEED = 45;
const SHELL_HEIGHT = 0.35;
const GREEN_LIFE = 9;
const RED_LIFE = 8;
const BANANA_LIFE = 40;
const BOMB_FUSE = 2.5;
const EXPLOSION_RADIUS = 4;
const ORBIT_RADIUS = 1.5;
const ORBIT_HEIGHT = 0.55;
const ORBIT_SPEED = 2.4;

type HazardKind = 'banana' | 'green_shell' | 'red_shell' | 'blue_shell' | 'bob_omb';

interface Hazard extends HazardInfo {
  kind: HazardKind;
  mesh: THREE.Object3D;
  age: number;
  life: number;
  hintT: number;
  speed: number;
  bounces: number;
  maxBounces: number;
  homing: boolean;
  targetId: number;
  /** Ballistic flight (lobbed banana / bomb). */
  airborne: boolean;
  /** Not moving any more (banana on the ground, bomb at rest). */
  resting: boolean;
  fuse: number;
  blinkPhase: number;
  wobblePhase: number;
  bodyMat: THREE.MeshStandardMaterial | null;
  /** Blue shell: centerline parameter of the flight. */
  flightT: number;
  trailTimer: number;
  /** Excluded from getHazards() (blue shell high in the air). */
  hidden: boolean;
  /** Item type reported in events. */
  reportType: ItemType;
}

interface KartRecord {
  kart: IKart;
  rouletteActive: boolean;
  rouletteTimer: number;
  tickTimer: number;
  ticks: number;
  lastUseTime: number;
  orbitType: ItemType;
  orbitMeshes: THREE.Object3D[];
  orbitAngle: number;
  orbitHitCooldown: number;
  /** trackT at the previous step (row-crossing detection for debugCounts). */
  prevT: number;
}

interface BoxSlot {
  base: THREE.Vector3;
  groundY: number;
  world: THREE.Vector3;
  active: boolean;
  respawnTimer: number;
  scale: number;
  phase: number;
}

type WeightRow = Partial<Record<ItemType, number>>;

/** Place-weighted item table (index = place - 1). Tuned to feel like Mario Kart. */
const ITEM_TABLE: readonly WeightRow[] = [
  // 1st
  { banana: 35, green_shell: 35, triple_banana: 10, bob_omb: 5, red_shell: 15 },
  // 2nd
  { banana: 22, green_shell: 26, red_shell: 22, triple_green_shell: 12, mushroom: 10, bob_omb: 8 },
  // 3rd
  { banana: 16, green_shell: 22, red_shell: 26, triple_green_shell: 14, mushroom: 14, bob_omb: 8 },
  // 4th
  { red_shell: 26, triple_red_shell: 14, mushroom: 26, triple_mushroom: 14, bob_omb: 12, star: 8 },
  // 5th
  { red_shell: 22, triple_red_shell: 16, mushroom: 22, triple_mushroom: 18, bob_omb: 12, star: 10 },
  // 6th
  { triple_mushroom: 28, star: 20, red_shell: 15, lightning: 10, golden_mushroom: 22, triple_red_shell: 5 },
  // 7th
  { star: 22, lightning: 13, golden_mushroom: 24, blue_shell: 12, triple_mushroom: 19, triple_red_shell: 10 },
  // 8th
  { star: 22, lightning: 17, golden_mushroom: 22, blue_shell: 16, triple_mushroom: 15, triple_red_shell: 8 },
];

/** Roulette tick intervals (seconds), decelerating and summing to ~ITEM_ROULETTE_SECONDS. */
const TICK_INTERVALS: number[] = (() => {
  const r = 1.18;
  const a = (ITEM_ROULETTE_SECONDS * 0.95 * (r - 1)) / (Math.pow(r, ROULETTE_TICKS) - 1);
  const out: number[] = [];
  for (let i = 0; i < ROULETTE_TICKS; i++) out.push(a * Math.pow(r, i));
  return out;
})();

// ---------------------------------------------------------------------------
// Scratch (module-level, never allocated per frame)
// ---------------------------------------------------------------------------

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _scale = new THREE.Vector3();

function makeQuery(): SurfaceQuery {
  return {
    t: 0,
    surface: 'road',
    groundY: 0,
    groundNormal: new THREE.Vector3(0, 1, 0),
    lateral: 0,
    halfWidth: 6,
    wallHalfWidth: 7,
    tangent: new THREE.Vector3(0, 0, -1),
    binormal: new THREE.Vector3(1, 0, 0),
    center: new THREE.Vector3(),
  };
}

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

const _query = makeQuery();
const _query2 = makeQuery();
const _sample = makeSample();
const _sample2 = makeSample();

const BOX_VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vWorldPos;
void main() {
  mat4 model = modelMatrix;
  #ifdef USE_INSTANCING
    model = modelMatrix * instanceMatrix;
  #endif
  vec4 worldPos = model * vec4(position, 1.0);
  vNormal = normalize(mat3(model) * normal);
  vWorldPos = worldPos.xyz;
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const BOX_FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vWorldPos;
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vViewDir);
  float ndv = abs(dot(n, v));
  float fres = pow(1.0 - ndv, 2.2);
  float hue = fract(ndv * 0.9 + uTime * 0.15 + (vWorldPos.x + vWorldPos.z) * 0.35 + vWorldPos.y * 0.5 + n.y * 0.2);
  vec3 col = hsv2rgb(vec3(hue, 1.0, 1.0));
  col = mix(col, vec3(1.0), fres * 0.35);
  float alpha = 0.6 + fres * 0.35;
  gl_FragColor = vec4(col * 1.15, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

let nextHazardId = 1;

export class ItemManager implements IItemManager {
  readonly object = new THREE.Group();

  /**
   * Cheap cumulative counters for balancing / soak tests (reset with `reset()`).
   * `rowPassEmpty` counts karts crossing an item-box row while empty-handed, so
   * `pickup / rowPassEmpty` is the effective pickup rate.
   */
  readonly debugCounts = { pickup: 0, use: 0, hit: 0, destroyed: 0, rowPassEmpty: 0, explosion: 0 };

  /**
   * Online play: returns true for karts this client simulates. Damage is only
   * ever applied to those, so two clients can never both decide the same kart
   * was hit. Null in single player, where this client owns everything.
   */
  owns: ((kartId: number) => boolean) | null = null;

  private readonly particles: IParticleSystem | null;
  private track: ITrack | null = null;
  private karts: readonly IKart[] = [];
  private records: KartRecord[] = [];
  private time = 0;
  private lastLightningTime = -1000;

  private readonly hazards: Hazard[] = [];
  private readonly hazardOut: HazardInfo[] = [];
  private readonly boxes: BoxSlot[] = [];
  private readonly boxOut: THREE.Vector3[] = [];
  private rowTs: number[] = [];

  private boxMesh: THREE.InstancedMesh | null = null;
  private innerMesh: THREE.InstancedMesh | null = null;
  private ringMesh: THREE.InstancedMesh | null = null;
  private boxMaterial: THREE.ShaderMaterial | null = null;
  private innerMaterial: THREE.MeshBasicMaterial | null = null;
  private ringMaterial: THREE.MeshBasicMaterial | null = null;
  private boxGeometry: THREE.BufferGeometry | null = null;
  private innerGeometry: THREE.BufferGeometry | null = null;
  private ringGeometry: THREE.BufferGeometry | null = null;
  private questionTexture: THREE.CanvasTexture | null = null;

  constructor(particles: IParticleSystem | null) {
    this.particles = particles;
    this.object.name = 'ItemManager';
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(track: ITrack, karts: readonly IKart[]): void {
    this.clearAll();
    this.track = track;
    this.karts = karts;
    this.records = karts.map((kart) => ({
      kart,
      rouletteActive: false,
      rouletteTimer: 0,
      tickTimer: 0,
      ticks: 0,
      lastUseTime: -10,
      orbitType: 'none',
      orbitMeshes: [],
      orbitAngle: Math.random() * TAU,
      orbitHitCooldown: 0,
      prevT: kart.state.trackT,
    }));
    this.rowTs = track.def.itemBoxRows.slice();
    this.resetDebugCounts();
    this.buildBoxes(track);
  }

  private resetDebugCounts(): void {
    const c = this.debugCounts;
    c.pickup = c.use = c.hit = c.destroyed = c.rowPassEmpty = c.explosion = 0;
  }

  reset(): void {
    this.clearAll();
    for (const b of this.boxes) {
      b.active = true;
      b.respawnTimer = 0;
      b.scale = 1;
    }
    for (const rec of this.records) {
      rec.rouletteActive = false;
      rec.rouletteTimer = 0;
      rec.lastUseTime = -10;
      const s = rec.kart.state;
      s.item = 'none';
      s.itemCount = 0;
      s.itemRouletteActive = false;
      rec.prevT = s.trackT;
    }
    this.lastLightningTime = -1000;
    this.time = 0;
    this.resetDebugCounts();
  }

  dispose(): void {
    this.clearAll();
    this.disposeBoxes();
    this.records = [];
    this.karts = [];
    this.track = null;
    disposeItemVisualCaches();
  }

  /** Removes hazards + orbit meshes (keeps boxes and kart records). */
  private clearAll(): void {
    for (let i = this.hazards.length - 1; i >= 0; i--) this.removeHazard(i);
    for (const rec of this.records) {
      this.clearOrbit(rec);
      rec.rouletteActive = false;
    }
  }

  // -------------------------------------------------------------------------
  // Item boxes
  // -------------------------------------------------------------------------

  private buildBoxes(track: ITrack): void {
    this.disposeBoxes();
    this.boxes.length = 0;
    const positions = track.itemBoxPositions;
    if (positions.length === 0) return;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const q = track.query(p, undefined, _query);
      this.boxes.push({
        base: p.clone(),
        groundY: q.groundY,
        world: new THREE.Vector3(p.x, q.groundY + BOX_HOVER, p.z),
        active: true,
        respawnTimer: 0,
        scale: 1,
        phase: (i * 0.73) % TAU,
      });
    }

    const n = this.boxes.length;
    this.boxGeometry = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
    this.boxMaterial = new THREE.ShaderMaterial({
      vertexShader: BOX_VERT,
      fragmentShader: BOX_FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    this.boxMesh = new THREE.InstancedMesh(this.boxGeometry, this.boxMaterial, n);
    this.boxMesh.frustumCulled = false;
    this.boxMesh.renderOrder = 3;
    this.boxMesh.name = 'itemBoxes';
    this.object.add(this.boxMesh);

    this.questionTexture = this.makeQuestionTexture();
    this.innerGeometry = new THREE.BoxGeometry(0.46, 0.46, 0.46);
    this.innerMaterial = new THREE.MeshBasicMaterial({
      map: this.questionTexture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.innerMesh = new THREE.InstancedMesh(this.innerGeometry, this.innerMaterial, n);
    this.innerMesh.frustumCulled = false;
    this.innerMesh.renderOrder = 2;
    this.innerMesh.name = 'itemBoxQuestion';
    this.object.add(this.innerMesh);

    this.ringGeometry = new THREE.RingGeometry(0.55, 1.0, 24);
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x9fe0ff,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ringMesh = new THREE.InstancedMesh(this.ringGeometry, this.ringMaterial, n);
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 1;
    this.ringMesh.name = 'itemBoxRings';
    this.object.add(this.ringMesh);

    this.updateBoxMatrices();
  }

  private makeQuestionTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, 128, 128);
      ctx.font = 'bold 100px "Arial Black", Impact, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 12;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#8a4b00';
      ctx.strokeText('?', 64, 70);
      ctx.fillStyle = '#fff4b8';
      ctx.fillText('?', 64, 70);
    }
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private disposeBoxes(): void {
    if (this.boxMesh) this.object.remove(this.boxMesh);
    if (this.innerMesh) this.object.remove(this.innerMesh);
    if (this.ringMesh) this.object.remove(this.ringMesh);
    this.boxMesh?.dispose();
    this.innerMesh?.dispose();
    this.ringMesh?.dispose();
    this.boxGeometry?.dispose();
    this.innerGeometry?.dispose();
    this.ringGeometry?.dispose();
    this.boxMaterial?.dispose();
    this.innerMaterial?.dispose();
    this.ringMaterial?.dispose();
    this.questionTexture?.dispose();
    this.boxMesh = this.innerMesh = this.ringMesh = null;
    this.boxGeometry = this.innerGeometry = this.ringGeometry = null;
    this.boxMaterial = null;
    this.innerMaterial = this.ringMaterial = null;
    this.questionTexture = null;
  }

  private updateBoxes(dt: number): void {
    for (const b of this.boxes) {
      if (!b.active) {
        b.respawnTimer -= dt;
        if (b.respawnTimer <= 0) {
          b.active = true;
          b.scale = 0;
          events.emit('item:boxRespawn', { position: b.world.clone() });
        }
      } else if (b.scale < 1) {
        b.scale = Math.min(1, b.scale + dt / BOX_SCALE_IN);
      }
      b.world.set(b.base.x, b.groundY + BOX_HOVER + Math.sin(this.time * 2.1 + b.phase) * 0.12, b.base.z);
    }
    this.updateBoxMatrices();

    // pickups
    for (const rec of this.records) {
      const s = rec.kart.state;
      const emptyHanded = s.item === 'none' && !s.itemRouletteActive && !rec.rouletteActive;
      // debug: count empty-handed row crossings (pickup / rowPassEmpty = pickup efficiency)
      const adv = trackDelta(rec.prevT, s.trackT);
      if (adv > 0 && adv < 0.05 && emptyHanded && !s.finished) {
        for (let i = 0; i < this.rowTs.length; i++) {
          const d = trackDelta(rec.prevT, this.rowTs[i]);
          if (d >= 0 && d < adv) this.debugCounts.rowPassEmpty++;
        }
      }
      rec.prevT = s.trackT;
      if (!emptyHanded || s.isSpinning) continue;
      if (this.owns && !this.owns(s.id)) continue;
      for (const b of this.boxes) {
        if (!b.active || b.scale < 0.5) continue;
        const dx = s.position.x - b.world.x;
        const dz = s.position.z - b.world.z;
        const dy = s.position.y - b.groundY;
        if (dx * dx + dz * dz > BOX_PICKUP_RADIUS * BOX_PICKUP_RADIUS || dy > 2.6 || dy < -1.5) continue;
        b.active = false;
        b.respawnTimer = ITEM_BOX_RESPAWN_SECONDS;
        b.scale = 0;
        this.startRoulette(rec);
        this.debugCounts.pickup++;
        events.emit('item:pickup', { kartId: s.id, position: b.world.clone(), isPlayer: s.isPlayer });
        this.particles?.emit('itemBoxBurst', b.world);
        break;
      }
    }
  }

  private updateBoxMatrices(): void {
    if (!this.boxMesh || !this.innerMesh || !this.ringMesh) return;
    if (this.boxMaterial) this.boxMaterial.uniforms.uTime.value = this.time;
    const pulse = 0.85 + Math.sin(this.time * 3) * 0.15;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const sc = b.active ? easeOutBack(b.scale) : 0;
      _e.set(this.time * 0.8 + b.phase, this.time * 1.3 + b.phase * 2, 0);
      _q.setFromEuler(_e);
      _scale.setScalar(sc);
      _m.compose(b.world, _q, _scale);
      this.boxMesh.setMatrixAt(i, _m);

      _e.set(0, -this.time * 1.6 + b.phase, 0);
      _q.setFromEuler(_e);
      _scale.setScalar(sc);
      _m.compose(b.world, _q, _scale);
      this.innerMesh.setMatrixAt(i, _m);

      _v1.set(b.base.x, b.groundY + 0.03, b.base.z);
      _e.set(-Math.PI / 2, 0, this.time * 0.5);
      _q.setFromEuler(_e);
      _scale.setScalar(b.active ? pulse * (0.6 + 0.4 * b.scale) : pulse * 0.5);
      _m.compose(_v1, _q, _scale);
      this.ringMesh.setMatrixAt(i, _m);
    }
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.innerMesh.instanceMatrix.needsUpdate = true;
    this.ringMesh.instanceMatrix.needsUpdate = true;
  }

  getActiveBoxPositions(): readonly THREE.Vector3[] {
    this.boxOut.length = 0;
    for (const b of this.boxes) if (b.active && b.scale >= 0.5) this.boxOut.push(b.world);
    return this.boxOut;
  }

  // -------------------------------------------------------------------------
  // Roulette
  // -------------------------------------------------------------------------

  private startRoulette(rec: KartRecord): void {
    rec.rouletteActive = true;
    rec.rouletteTimer = ITEM_ROULETTE_SECONDS;
    rec.ticks = 0;
    rec.tickTimer = TICK_INTERVALS[0];
    rec.kart.state.itemRouletteActive = true;
    rec.kart.state.item = 'none';
    rec.kart.state.itemCount = 0;
  }

  private updateRoulette(rec: KartRecord, dt: number): void {
    if (!rec.rouletteActive) return;
    const s = rec.kart.state;
    rec.rouletteTimer -= dt;
    rec.tickTimer -= dt;
    if (rec.tickTimer <= 0 && rec.ticks < ROULETTE_TICKS) {
      events.emit('item:rouletteTick', { kartId: s.id, isPlayer: s.isPlayer });
      rec.ticks++;
      if (rec.ticks < ROULETTE_TICKS) rec.tickTimer += TICK_INTERVALS[rec.ticks];
    }
    if (rec.rouletteTimer <= 0) {
      rec.rouletteActive = false;
      const item = this.rollItem(s.place);
      s.item = item;
      s.itemCount = item.startsWith('triple_') || item === 'golden_mushroom' ? 3 : 1;
      s.itemRouletteActive = false;
      events.emit('item:rouletteEnd', { kartId: s.id, item, isPlayer: s.isPlayer });
    }
  }

  private rollItem(place: number): ItemType {
    const row = ITEM_TABLE[clamp(Math.round(place), 1, ITEM_TABLE.length) - 1];
    const allowLightning = this.time - this.lastLightningTime > LIGHTNING_COOLDOWN;
    let total = 0;
    for (const key in row) {
      const item = key as ItemType;
      if (item === 'lightning' && !allowLightning) continue;
      if (item === 'blue_shell' && place <= 1) continue;
      total += row[item] ?? 0;
    }
    if (total <= 0) return 'banana';
    let r = Math.random() * total;
    for (const key in row) {
      const item = key as ItemType;
      if (item === 'lightning' && !allowLightning) continue;
      if (item === 'blue_shell' && place <= 1) continue;
      r -= row[item] ?? 0;
      if (r <= 0) return item;
    }
    return 'banana';
  }

  // -------------------------------------------------------------------------
  // Using items
  // -------------------------------------------------------------------------

  requestUse(kart: IKart, aimBack: boolean): void {
    const s = kart.state;
    if (!this.track) return;
    if (s.item === 'none' || s.itemCount <= 0 || s.itemRouletteActive || s.isSpinning || s.isFrozen) return;
    const rec = this.records.find((r) => r.kart === kart);
    if (rec && rec.rouletteActive) return;
    const item = s.item;
    const base = baseItemType(item);

    if (item === 'golden_mushroom' && rec && this.time - rec.lastUseTime < GOLDEN_MIN_SPACING) return;

    const speed = s.speed;
    const top = kart.topSpeed();
    kart.forwardDir(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();

    switch (base) {
      case 'banana': {
        const throwForward = !aimBack && speed > 0.5 * top;
        if (throwForward) this.spawnLobbed('banana', kart, 'banana', 7.5, Math.max(speed, 0) + 12);
        else this.spawnDropped('banana', kart, 'banana');
        break;
      }
      case 'green_shell':
        this.spawnShell('green_shell', kart, aimBack, item);
        break;
      case 'red_shell':
        this.spawnShell('red_shell', kart, aimBack, item);
        break;
      case 'blue_shell':
        this.spawnBlueShell(kart);
        break;
      case 'mushroom':
        kart.applyBoost(0.55, 1.5, 'mushroom');
        this.particles?.emit('boostRing', s.position);
        break;
      case 'golden_mushroom':
        kart.applyBoost(0.55, 1.5, 'golden');
        this.particles?.emit('boostRing', s.position, { color: 0xffc531 });
        break;
      case 'star':
        kart.applyStar(8);
        break;
      case 'lightning':
        this.useLightning(kart);
        break;
      case 'bob_omb':
        if (aimBack) this.spawnDropped('bob_omb', kart, 'bob_omb');
        else this.spawnLobbed('bob_omb', kart, 'bob_omb', 8.5, Math.max(speed, 0) + 13);
        break;
      default:
        return;
    }

    if (rec) rec.lastUseTime = this.time;
    s.itemCount = Math.max(0, s.itemCount - 1);
    if (s.itemCount === 0) s.item = 'none';
    this.debugCounts.use++;
    events.emit('item:use', { kartId: s.id, item, position: s.position.clone(), isPlayer: s.isPlayer });
  }

  private useLightning(user: IKart): void {
    const uid = user.state.id;
    this.lastLightningTime = this.time;
    for (const other of this.karts) {
      if (other === user) continue;
      const os = other.state;
      if (this.owns && !this.owns(os.id)) continue;
      if (os.isInvincible || os.finished) continue;
      other.applyShrink(6);
      if (!os.isAirborne) other.applyHit('lightning', uid);
      _v1.copy(os.position);
      _v1.y += 2.5;
      this.particles?.emit('lightningStrike', _v1, { direction: _v2.set(0, -1, 0) });
      this.debugCounts.hit++;
      events.emit('item:hit', {
        kartId: os.id,
        item: 'lightning',
        position: os.position.clone(),
        sourceKartId: uid,
        isPlayer: os.isPlayer,
      });
    }
    events.emit('item:lightning', { sourceKartId: uid });
  }

  // -------------------------------------------------------------------------
  // Hazard spawning
  // -------------------------------------------------------------------------

  private newHazard(kind: HazardKind, reportType: ItemType, owner: IKart): Hazard {
    if (this.hazards.length >= MAX_HAZARDS) this.removeHazard(0);
    const mesh = buildItemMesh(kind);
    let bodyMat: THREE.MeshStandardMaterial | null = null;
    if (kind === 'bob_omb') {
      const body = mesh.getObjectByName('bombBody') as THREE.Mesh | undefined;
      if (body && body.material instanceof THREE.MeshStandardMaterial) {
        bodyMat = body.material.clone();
        body.material = bodyMat;
      }
    }
    const h: Hazard = {
      id: nextHazardId++,
      type: kind,
      reportType,
      kind,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      radius: kind === 'banana' ? 0.45 : kind === 'bob_omb' ? 0.5 : 0.45,
      ownerId: owner.state.id,
      mesh,
      age: 0,
      life: kind === 'banana' ? BANANA_LIFE : kind === 'green_shell' ? GREEN_LIFE : kind === 'red_shell' ? RED_LIFE : 30,
      hintT: owner.state.trackT,
      speed: 0,
      bounces: 0,
      maxBounces: 0,
      homing: false,
      targetId: -1,
      airborne: false,
      resting: false,
      fuse: BOMB_FUSE,
      blinkPhase: 0,
      wobblePhase: Math.random() * TAU,
      bodyMat,
      flightT: 0,
      trailTimer: 0,
      hidden: false,
    };
    this.hazards.push(h);
    this.object.add(mesh);
    return h;
  }

  private spawnDropped(kind: HazardKind, kart: IKart, reportType: ItemType): void {
    if (!this.track) return;
    const h = this.newHazard(kind, reportType, kart);
    h.position.copy(kart.state.position).addScaledVector(_fwd, -1.7);
    const q = this.track.query(h.position, h.hintT, _query);
    h.hintT = q.t;
    h.position.y = q.groundY + 0.02;
    h.velocity.set(0, 0, 0);
    h.resting = true;
    h.mesh.position.copy(h.position);
    h.mesh.rotation.y = Math.random() * TAU;
  }

  private spawnLobbed(kind: HazardKind, kart: IKart, reportType: ItemType, upSpeed: number, fwdSpeed: number): void {
    const h = this.newHazard(kind, reportType, kart);
    h.position.copy(kart.state.position).addScaledVector(_fwd, 1.3);
    h.position.y += 0.6;
    h.velocity.copy(_fwd).multiplyScalar(fwdSpeed);
    h.velocity.y = upSpeed;
    h.airborne = true;
    h.mesh.position.copy(h.position);
  }

  private spawnShell(kind: 'green_shell' | 'red_shell', kart: IKart, aimBack: boolean, reportType: ItemType): void {
    if (!this.track) return;
    const s = kart.state;
    const h = this.newHazard(kind, reportType, kart);
    const dir = aimBack ? -1 : 1;
    h.position.copy(s.position).addScaledVector(_fwd, dir * 1.4);
    const q = this.track.query(h.position, h.hintT, _query);
    h.hintT = q.t;
    h.position.y = q.groundY + SHELL_HEIGHT;
    if (kind === 'green_shell') {
      h.speed = GREEN_SPEED;
      h.maxBounces = 6;
      h.homing = false;
    } else if (aimBack) {
      // red shell thrown backwards behaves like a green shell
      h.speed = RED_SPEED;
      h.maxBounces = 6;
      h.homing = false;
    } else {
      h.speed = RED_SPEED;
      h.maxBounces = 0;
      h.targetId = this.findRedTarget(kart);
      h.homing = h.targetId >= 0;
    }
    h.velocity.copy(_fwd).multiplyScalar(dir * h.speed);
    h.mesh.position.copy(h.position);
  }

  private findRedTarget(owner: IKart): number {
    const ot = owner.state.trackT;
    let best = -1;
    let bestD = 0.35;
    for (const k of this.karts) {
      if (k === owner) continue;
      const ks = k.state;
      if (ks.finished) continue;
      const d = trackDelta(ot, ks.trackT);
      if (d > 0.002 && d < bestD) {
        bestD = d;
        best = ks.id;
      }
    }
    return best;
  }

  private findLeader(exclude: IKart): IKart | null {
    let best: IKart | null = null;
    for (const k of this.karts) {
      if (k === exclude) continue;
      if (!best || k.state.place < best.state.place) best = k;
    }
    return best;
  }

  private spawnBlueShell(kart: IKart): void {
    if (!this.track) return;
    const target = this.findLeader(kart);
    const h = this.newHazard('blue_shell', 'blue_shell', kart);
    h.position.copy(kart.state.position).addScaledVector(_fwd, 1.5);
    h.position.y += 1.0;
    h.flightT = kart.state.trackT;
    h.speed = BLUE_SPEED;
    h.targetId = target ? target.state.id : -1;
    h.homing = true;
    h.life = 30;
    h.velocity.copy(_fwd).multiplyScalar(BLUE_SPEED);
    h.mesh.position.copy(h.position);
    h.hidden = true;
    events.emit('item:blueShellLaunch', { targetKartId: h.targetId });
  }

  private kartById(id: number): IKart | null {
    for (const k of this.karts) if (k.state.id === id) return k;
    return null;
  }

  // -------------------------------------------------------------------------
  // Hazard simulation
  // -------------------------------------------------------------------------

  private removeHazard(index: number): void {
    const h = this.hazards[index];
    if (!h) return;
    this.object.remove(h.mesh);
    h.bodyMat?.dispose();
    this.hazards.splice(index, 1);
  }

  private destroyHazard(index: number, preset: 'shellBreak' | 'bananaSplat' | null, emitEvent: boolean): void {
    const h = this.hazards[index];
    if (!h) return;
    if (preset) this.particles?.emit(preset, h.position);
    if (emitEvent) {
      this.debugCounts.destroyed++;
      events.emit('item:destroyed', { item: h.reportType, position: h.position.clone() });
    }
    this.removeHazard(index);
  }

  /**
   * Online: another client reported that one of `ownerId`'s projectiles hit it.
   * Removes our copy of that projectile so the shell does not fly on forever on
   * screens other than the victim's. Matched by owner, kind and proximity - ids
   * are local, so position is the only thing both sides agree on.
   */
  killHazardNear(ownerId: number, kind: ItemType, x: number, z: number, radius = 14): void {
    let best = -1;
    let bestDist = radius * radius;
    for (let i = 0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      if (h.ownerId !== ownerId || h.reportType !== kind) continue;
      const dx = h.position.x - x;
      const dz = h.position.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best >= 0) this.destroyHazard(best, this.breakPresetFor(this.hazards[best].kind), true);
  }

  private breakPresetFor(kind: HazardKind): 'shellBreak' | 'bananaSplat' {
    return kind === 'banana' ? 'bananaSplat' : 'shellBreak';
  }

  private updateHazards(dt: number): void {
    const track = this.track;
    if (!track) return;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.age += dt;
      if (h.age > h.life) {
        this.removeHazard(i);
        continue;
      }
      let alive = true;
      switch (h.kind) {
        case 'green_shell':
        case 'red_shell':
          alive = this.moveShell(h, i, dt, track);
          break;
        case 'blue_shell':
          alive = this.moveBlueShell(h, i, dt, track);
          break;
        case 'banana':
          this.moveGroundItem(h, dt, track);
          break;
        case 'bob_omb':
          this.moveGroundItem(h, dt, track);
          h.fuse -= dt;
          this.blinkBomb(h, dt);
          if (h.fuse <= 0) {
            this.explode(h.position, h.ownerId, 'bob_omb', 'explosion');
            this.removeHazard(i);
            alive = false;
          }
          break;
      }
      if (!alive) continue;
      this.animateHazard(h, dt);
    }
    this.collideHazardsWithKarts();
    this.collideHazardsWithHazards();
  }

  private moveShell(h: Hazard, index: number, dt: number, track: ITrack): boolean {
    if (h.homing) this.steerRedShell(h, dt, track);
    else {
      // gentle track following so shells stay useful on long bends
      const q0 = track.query(h.position, h.hintT, _query2);
      const along = h.velocity.dot(q0.tangent);
      if (Math.abs(along) > 1) {
        _v1.copy(q0.tangent).multiplyScalar(Math.sign(along));
        h.velocity.lerp(_v1.multiplyScalar(h.speed), Math.min(1, 0.35 * dt));
      }
    }
    h.velocity.y = 0;
    if (h.velocity.lengthSq() > 1e-6) h.velocity.setLength(h.speed);
    h.position.addScaledVector(h.velocity, dt);
    const q = track.query(h.position, h.hintT, _query);
    h.hintT = q.t;
    const limit = q.wallHalfWidth - 0.4;
    if (Math.abs(q.lateral) > limit) {
      if (h.bounces >= h.maxBounces) {
        this.destroyHazard(index, 'shellBreak', true);
        return false;
      }
      const vb = h.velocity.dot(q.binormal);
      h.velocity.addScaledVector(q.binormal, -2 * vb);
      const over = Math.abs(q.lateral) - limit;
      h.position.addScaledVector(q.binormal, -Math.sign(q.lateral) * (over + 0.05));
      h.bounces++;
      events.emit('item:shellBounce', { position: h.position.clone() });
      this.particles?.emit('hitSparks', h.position);
    }
    if (q.surface === 'void' && Math.abs(q.lateral) > q.halfWidth) {
      this.destroyHazard(index, 'shellBreak', true);
      return false;
    }
    h.position.y = q.groundY + SHELL_HEIGHT;
    return true;
  }

  private steerRedShell(h: Hazard, dt: number, track: ITrack): void {
    const target = this.kartById(h.targetId);
    if (!target || target.state.finished) {
      h.homing = false;
      return;
    }
    const ts = target.state;
    const q = track.query(h.position, h.hintT, _query2);
    _v1.subVectors(ts.position, h.position);
    _v1.y = 0;
    const dist = _v1.length();
    if (dist < 16) {
      // aim at the target with a little lead
      _v1.addScaledVector(ts.velocity, 0.12);
      _v1.y = 0;
      _v1.normalize();
    } else {
      // follow the centerline toward the target's t
      const ahead = trackDelta(q.t, ts.trackT);
      const sign = ahead >= 0 ? 1 : -1;
      _v1.copy(q.tangent).multiplyScalar(sign).addScaledVector(q.binormal, -q.lateral * 0.18);
      _v1.y = 0;
      _v1.normalize();
    }
    _v2.copy(h.velocity);
    _v2.y = 0;
    if (_v2.lengthSq() < 1e-6) _v2.copy(_v1);
    _v2.normalize();
    const cross = _v2.x * _v1.z - _v2.z * _v1.x;
    const dot = clamp(_v2.dot(_v1), -1, 1);
    const angle = Math.atan2(cross, dot);
    const maxTurn = (dist < 16 ? 6.5 : 3.5) * dt;
    const turn = clamp(angle, -maxTurn, maxTurn);
    // rotate _v2 by 'turn' about Y (positive turn = toward _v1 given the cross convention above)
    const c = Math.cos(turn);
    const sn = Math.sin(turn);
    const nx = _v2.x * c - _v2.z * sn;
    const nz = _v2.x * sn + _v2.z * c;
    h.velocity.set(nx * h.speed, 0, nz * h.speed);
  }

  private moveBlueShell(h: Hazard, index: number, dt: number, track: ITrack): boolean {
    let target = this.kartById(h.targetId);
    if (!target) {
      const owner = this.kartById(h.ownerId);
      target = owner ? this.findLeader(owner) : null;
      h.targetId = target ? target.state.id : -1;
    }
    if (!target) {
      this.destroyHazard(index, 'shellBreak', true);
      return false;
    }
    const ts = target.state;
    const len = Math.max(1, track.length);
    // forward distance along the track to the target (always in [0, 1) so a leader more
    // than half a lap ahead is still "ahead", not "passed")
    const remaining = wrap01(ts.trackT - h.flightT);
    const remainingM = remaining * len;
    _v1.subVectors(ts.position, h.position);
    const dist = _v1.length();
    if (dist < 2.5 || (remainingM < 1.5 && h.age > 0.5)) {
      h.position.copy(ts.position);
      this.explode(h.position, h.ownerId, 'blue_shell', 'blue_shell');
      this.removeHazard(index);
      return false;
    }
    h.flightT = wrap01(h.flightT + (h.speed * dt) / len);
    const s = track.sample(h.flightT, _sample);
    // lateral: drift toward the target's lateral offset when close
    const st = track.sample(ts.trackT, _sample2);
    _v2.subVectors(ts.position, st.position);
    const targetLat = clamp(_v2.dot(st.binormal), -st.halfWidth, st.halfWidth);
    const closeness = clamp(1 - remainingM / 30, 0, 1);
    const lat = lerp(0, targetLat, closeness);
    const rise = clamp(h.age / 0.6, 0, 1);
    const descend = clamp(remainingM / 14, 0, 1);
    const altitude = lerp(0.9, 3.6, rise) * lerp(0.25, 1, descend) + 0.3;
    _v3.copy(s.position).addScaledVector(s.binormal, lat);
    _v3.y = s.position.y + altitude;
    h.velocity.subVectors(_v3, h.position).multiplyScalar(1 / Math.max(dt, 1e-4));
    h.position.copy(_v3);
    h.hintT = h.flightT;
    h.hidden = altitude > 3;
    h.trailTimer -= dt;
    if (h.trailTimer <= 0) {
      h.trailTimer = 0.05;
      this.particles?.emit('starSparkle', h.position, { color: 0x3f8cff, scale: 0.8 });
    }
    return true;
  }

  private moveGroundItem(h: Hazard, dt: number, track: ITrack): void {
    if (h.resting) return;
    if (h.airborne) {
      h.velocity.y -= GRAVITY * dt;
      h.position.addScaledVector(h.velocity, dt);
      const q = track.query(h.position, h.hintT, _query);
      h.hintT = q.t;
      const floor = q.groundY + 0.02;
      if (h.position.y <= floor && h.velocity.y < 0) {
        h.position.y = floor;
        if (h.kind === 'bob_omb' && h.velocity.y < -4) {
          h.velocity.y *= -0.3;
          h.velocity.x *= 0.5;
          h.velocity.z *= 0.5;
        } else {
          h.airborne = false;
          h.velocity.y = 0;
          if (h.kind === 'banana') {
            h.velocity.set(0, 0, 0);
            h.resting = true;
          } else {
            h.velocity.multiplyScalar(0.4);
          }
          this.particles?.emit('landPuff', h.position, { scale: 0.5 });
        }
      }
      return;
    }
    // rolling on the ground (bomb after landing)
    const damp = Math.exp(-4 * dt);
    h.velocity.multiplyScalar(damp);
    if (h.velocity.lengthSq() < 0.05) {
      h.velocity.set(0, 0, 0);
      h.resting = true;
      return;
    }
    h.position.addScaledVector(h.velocity, dt);
    const q = track.query(h.position, h.hintT, _query);
    h.hintT = q.t;
    h.position.y = q.groundY + 0.02;
  }

  private blinkBomb(h: Hazard, dt: number): void {
    if (!h.bodyMat) return;
    const urgency = clamp(1 - h.fuse / BOMB_FUSE, 0, 1);
    h.blinkPhase += dt * (5 + urgency * 22);
    const on = Math.sin(h.blinkPhase) > 0.2;
    if (on) {
      h.bodyMat.color.setHex(0xd42a1f);
      h.bodyMat.emissive.setHex(0xff2a10);
      h.bodyMat.emissiveIntensity = 0.5 + urgency;
    } else {
      h.bodyMat.color.setHex(0x15151c);
      h.bodyMat.emissive.setHex(0x000000);
      h.bodyMat.emissiveIntensity = 0;
    }
  }

  private animateHazard(h: Hazard, dt: number): void {
    const m = h.mesh;
    m.position.copy(h.position);
    switch (h.kind) {
      case 'green_shell':
      case 'red_shell':
        m.rotation.y += 14 * dt;
        break;
      case 'blue_shell': {
        m.rotation.y += 10 * dt;
        break;
      }
      case 'banana':
        if (h.airborne) {
          m.rotation.x += 9 * dt;
          m.rotation.y += 4 * dt;
        } else {
          m.rotation.x = 0;
          m.rotation.z = Math.sin(this.time * 3.2 + h.wobblePhase) * 0.12;
        }
        break;
      case 'bob_omb':
        if (h.airborne) m.rotation.x += 6 * dt;
        else {
          m.rotation.x = 0;
          m.rotation.z = Math.sin(this.time * 18) * 0.06 * clamp(1 - h.fuse / BOMB_FUSE, 0, 1);
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Collisions
  // -------------------------------------------------------------------------

  private collideHazardsWithKarts(): void {
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      if (h.kind === 'blue_shell') continue;
      const rr = KART_RADIUS + h.radius;
      for (const kart of this.karts) {
        const s = kart.state;
        if (this.owns && !this.owns(s.id)) continue;
        if (s.id === h.ownerId && h.age < OWNER_GRACE) continue;
        if (s.isSpinning || s.finished) continue;
        const dx = s.position.x - h.position.x;
        const dy = s.position.y + 0.45 - h.position.y;
        const dz = s.position.z - h.position.z;
        if (dx * dx + dy * dy + dz * dz > rr * rr) continue;
        if (h.kind === 'bob_omb') {
          this.explode(h.position, h.ownerId, 'bob_omb', 'explosion');
          this.removeHazard(i);
          break;
        }
        if (s.isInvincible) {
          this.destroyHazard(i, this.breakPresetFor(h.kind), true);
          break;
        }
        kart.applyHit(h.kind, h.ownerId);
        if (h.kind === 'banana') {
          kart.forwardDir(_fwd);
          _right.crossVectors(_fwd, _up).normalize();
          _v1.copy(_right).multiplyScalar(Math.random() < 0.5 ? -1.8 : 1.8);
          _v1.y = 1.2;
          kart.applyImpulse(_v1);
        } else {
          _v1.copy(h.velocity).normalize().multiplyScalar(2.5);
          _v1.y = 1.5;
          kart.applyImpulse(_v1);
        }
        this.debugCounts.hit++;
        events.emit('item:hit', {
          kartId: s.id,
          item: h.reportType,
          position: s.position.clone(),
          sourceKartId: h.ownerId,
          isPlayer: s.isPlayer,
        });
        this.destroyHazard(i, this.breakPresetFor(h.kind), false);
        break;
      }
    }
  }

  private collideHazardsWithHazards(): void {
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const a = this.hazards[i];
      if (!a) continue;
      if (a.kind === 'blue_shell') continue;
      const aMoving = a.kind === 'green_shell' || a.kind === 'red_shell';
      for (let j = i - 1; j >= 0; j--) {
        const b = this.hazards[j];
        if (b.kind === 'blue_shell') continue;
        const bMoving = b.kind === 'green_shell' || b.kind === 'red_shell';
        if (!aMoving && !bMoving) continue;
        if (a.airborne || b.airborne) continue;
        const rr = a.radius + b.radius;
        if (a.position.distanceToSquared(b.position) > rr * rr) continue;
        // destroy the higher index first so indices stay valid
        this.resolveHazardPair(i, j);
        break;
      }
    }
  }

  /** Destroys both hazards of a colliding pair (higher index first so the lower one stays valid). */
  private resolveHazardPair(i: number, j: number): void {
    const hi = Math.max(i, j);
    const lo = Math.min(i, j);
    this.smashHazard(hi, this.hazards[hi]);
    this.smashHazard(lo, this.hazards[lo]);
  }

  private smashHazard(index: number, h: Hazard): void {
    if (h.kind === 'bob_omb') {
      this.explode(h.position, h.ownerId, 'bob_omb', 'explosion');
      this.removeHazard(index);
    } else {
      this.destroyHazard(index, this.breakPresetFor(h.kind), true);
    }
  }

  private explode(position: THREE.Vector3, ownerId: number, reportType: ItemType, cause: 'blue_shell' | 'explosion'): void {
    for (const kart of this.karts) {
      const s = kart.state;
      if (this.owns && !this.owns(s.id)) continue;
      const d = s.position.distanceTo(position);
      if (d > EXPLOSION_RADIUS + KART_RADIUS) continue;
      if (s.isInvincible) continue;
      const landed = kart.applyHit(cause, ownerId);
      _v1.subVectors(s.position, position);
      _v1.y = 0;
      if (_v1.lengthSq() < 1e-4) _v1.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      _v1.normalize().multiplyScalar(8 * clamp(1 - d / (EXPLOSION_RADIUS + KART_RADIUS), 0.3, 1));
      _v1.y = 6;
      kart.applyImpulse(_v1);
      if (landed || cause === 'blue_shell') {
        this.debugCounts.hit++;
        events.emit('item:hit', {
          kartId: s.id,
          item: reportType,
          position: s.position.clone(),
          sourceKartId: ownerId,
          isPlayer: s.isPlayer,
        });
      }
    }
    this.debugCounts.explosion++;
    events.emit('item:explosion', { position: position.clone(), radius: EXPLOSION_RADIUS });
    this.particles?.emit('explosion', position, { scale: 1.2 });
  }

  // -------------------------------------------------------------------------
  // Orbiting triple items
  // -------------------------------------------------------------------------

  private clearOrbit(rec: KartRecord): void {
    for (const m of rec.orbitMeshes) this.object.remove(m);
    rec.orbitMeshes.length = 0;
    rec.orbitType = 'none';
  }

  private updateOrbits(dt: number): void {
    for (const rec of this.records) {
      const s = rec.kart.state;
      const isTriple = s.item.startsWith('triple_');
      const wantType: ItemType = isTriple && s.itemCount > 0 && !s.itemRouletteActive ? baseItemType(s.item) : 'none';
      const wantCount = wantType === 'none' ? 0 : s.itemCount;
      if (wantType !== rec.orbitType || wantCount !== rec.orbitMeshes.length) {
        this.clearOrbit(rec);
        rec.orbitType = wantType;
        for (let i = 0; i < wantCount; i++) {
          const m = buildItemMesh(wantType);
          rec.orbitMeshes.push(m);
          this.object.add(m);
        }
      }
      rec.orbitHitCooldown = Math.max(0, rec.orbitHitCooldown - dt);
      const n = rec.orbitMeshes.length;
      if (n === 0) continue;
      rec.orbitAngle += dt * ORBIT_SPEED;
      const scale = s.isShrunk ? 0.6 : 1;
      for (let i = 0; i < n; i++) {
        const a = rec.orbitAngle + (i * TAU) / n;
        const m = rec.orbitMeshes[i];
        m.position.set(
          s.position.x + Math.cos(a) * ORBIT_RADIUS * scale,
          s.position.y + ORBIT_HEIGHT * scale,
          s.position.z + Math.sin(a) * ORBIT_RADIUS * scale,
        );
        m.scale.setScalar(scale);
        m.rotation.y = -a + Math.PI / 2;
        if (rec.orbitType === 'banana') m.rotation.z = Math.sin(this.time * 4 + i) * 0.2;
      }
      // orbiting shells / bananas hit karts they touch
      if (rec.orbitType === 'mushroom' || rec.orbitHitCooldown > 0) continue;
      outer: for (let i = 0; i < n; i++) {
        const m = rec.orbitMeshes[i];
        for (const other of this.karts) {
          if (other === rec.kart) continue;
          const os = other.state;
          if (this.owns && !this.owns(os.id)) continue;
          if (os.isSpinning || os.finished) continue;
          const rr = KART_RADIUS + 0.45;
          if (m.position.distanceToSquared(os.position) > rr * rr) continue;
          if (os.isInvincible) {
            this.particles?.emit(rec.orbitType === 'banana' ? 'bananaSplat' : 'shellBreak', m.position);
            events.emit('item:destroyed', { item: rec.orbitType, position: m.position.clone() });
          } else {
            other.applyHit(rec.orbitType, s.id);
            _v1.subVectors(os.position, s.position);
            _v1.y = 0;
            _v1.normalize().multiplyScalar(3);
            _v1.y = 1.5;
            other.applyImpulse(_v1);
            this.particles?.emit(rec.orbitType === 'banana' ? 'bananaSplat' : 'shellBreak', m.position);
            this.debugCounts.hit++;
            events.emit('item:hit', {
              kartId: os.id,
              item: rec.orbitType,
              position: os.position.clone(),
              sourceKartId: s.id,
              isPlayer: os.isPlayer,
            });
          }
          s.itemCount = Math.max(0, s.itemCount - 1);
          if (s.itemCount === 0) s.item = 'none';
          rec.orbitHitCooldown = 0.5;
          break outer;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-step update
  // -------------------------------------------------------------------------

  update(dt: number): void {
    if (!this.track) return;
    this.time += dt;
    this.updateBoxes(dt);
    for (const rec of this.records) this.updateRoulette(rec, dt);
    this.updateOrbits(dt);
    this.updateHazards(dt);
  }

  getHazards(): readonly HazardInfo[] {
    this.hazardOut.length = 0;
    for (const h of this.hazards) if (!h.hidden) this.hazardOut.push(h);
    return this.hazardOut;
  }
}

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const t = x - 1;
  return 1 + c3 * t * t * t + c1 * t * t;
}
