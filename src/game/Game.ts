/**
 * Game: owns the renderer, scene, camera, lights, fixed-step loop and the
 * state machine. This is the only module allowed to import other workstreams'
 * concrete classes; everything is typed against the core interfaces.
 */
import * as THREE from 'three';
import type {
  CharacterDef,
  Difficulty,
  GameState,
  IAIDriver,
  IAudioEngine,
  IItemManager,
  IKart,
  InputState,
  IParticleSystem,
  IPostFX,
  ITrack,
  MusicTrack,
  RaceSettings,
  TrackDefinition,
} from '../core/types';
import { createEmptyInput } from '../core/types';
import { events } from '../core/events';
import { COUNTDOWN_STEP_SECONDS, FIXED_DT, KART_COUNT, MAX_FRAME_DT } from '../core/constants';
import { AdaptiveResolution, detectQuality, type QualityProfile } from '../core/quality';
import { clamp, clamp01, damp } from '../core/math';

import { Kart } from '../kart/Kart';
import { InputManager } from '../kart/InputManager';
import { CHARACTERS, getCharacter } from '../kart/roster';
import { Track } from '../track/Track';
import { TRACKS, getTrackDef } from '../track/tracks';
import { ItemManager } from '../items/ItemManager';
import { buildItemIcon } from '../items/itemVisuals';
import { AIDriver } from '../ai/AIDriver';
import { AudioEngine } from '../audio/AudioEngine';
import { ParticleSystem } from '../fx/ParticleSystem';
import { PostFX } from '../fx/PostFX';
import { Weather } from '../fx/Weather';
import { buildEnvironmentProbe } from '../fx/EnvironmentProbe';

import { RaceManager } from './RaceManager';
import { FollowCamera } from './FollowCamera';
import { MenuBackdrop } from './MenuBackdrop';
import type { MenuFraming } from './MenuBackdrop';
import { NetClient } from '../net/NetClient';
import { NetRace } from '../net/NetRace';
import { HUD } from '../ui/HUD';
import { MainMenu } from '../ui/MainMenu';
import { OnlineMenu } from '../ui/OnlineMenu';
import type { MenuPanel } from '../ui/MainMenu';
import { ResultsScreen } from '../ui/ResultsScreen';
import { PauseMenu } from '../ui/PauseMenu';
import { LoadingScreen } from '../ui/LoadingScreen';
import { TouchControls } from '../ui/TouchControls';
import { el } from '../ui/dom';
import { showToast } from '../ui/toast';

const MIN_LOADING_SECONDS = 0.8;
/** Give up waiting for async shader compilation after this long and just go. */
const MAX_COMPILE_WAIT_SECONDS = 8;
const RESULTS_DELAY_SECONDS = 1.6;
const MAX_STEPS_PER_FRAME = 8;
const SUN_DISTANCE = 90;
const SHADOW_HALF_EXTENT = 30;
/** Tone mapping exposure when a circuit does not override it. */
const BASE_EXPOSURE = 0.95;
/**
 * How much of the environment probe reaches the materials. The probe exists so
 * bodywork has something to reflect; pushed higher it doubles as ambient light
 * and flattens the circuit into a bright haze.
 */
const ENV_PROBE_INTENSITY = 0.28;
const EMPTY_KARTS: readonly IKart[] = [];

function framingFor(panel: MenuPanel): MenuFraming {
  return panel === 'characterSelect' ? 'characters' : panel === 'trackSelect' ? 'tracks' : 'title';
}

interface PartialRace {
  track: ITrack | null;
  karts: IKart[];
  items: IItemManager | null;
  followCamera: FollowCamera | null;
  hud: HUD | null;
}

interface RaceContext {
  settings: RaceSettings;
  trackDef: TrackDefinition;
  track: ITrack;
  karts: IKart[];
  /** The kart this client drives. Not always karts[0] in an online race. */
  player: IKart;
  /** Live network session, or null for a single-player race. */
  net: NetRace | null;
  aiDrivers: IAIDriver[];
  playerAutoDriver: IAIDriver | null;
  items: IItemManager;
  raceManager: RaceManager;
  followCamera: FollowCamera;
  hud: HUD;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /** Soft camera-following fill so karts read on dark tracks (0 intensity on bright ones). */
  fill: THREE.DirectionalLight;
  fog: THREE.FogExp2 | null;
  background: THREE.Color;
  weather: Weather;
  envProbe: THREE.Texture | null;
  unsubs: (() => void)[];
  resultsTimer: number;
}

export class Game {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly uiRoot: HTMLElement;

  private readonly input: InputManager;
  private readonly audio: IAudioEngine;
  private readonly particles: IParticleSystem;
  private readonly postfx: IPostFX;
  private postfxOk = true;

  private readonly quality: QualityProfile = detectQuality();
  private readonly adaptive: AdaptiveResolution;
  private renderScale = 1;

  private readonly touch: TouchControls;
  /** On-screen pad is shown during a race once we know this is a finger, not a mouse. */
  private touchUi: boolean;
  private readonly backdrop: MenuBackdrop;
  private readonly mainMenu: MainMenu;
  private readonly netClient = new NetClient();
  private readonly onlineMenu: OnlineMenu;
  /** True while the player is inside the online flow (lobby or an online race). */
  private online = false;
  private readonly results: ResultsScreen;
  private readonly pauseMenu: PauseMenu;
  private readonly loading: LoadingScreen;
  private readonly muteIndicator: HTMLElement;

  private state: GameState = 'boot';
  private prePauseState: GameState = 'racing';
  private race: RaceContext | null = null;
  private pendingSettings: RaceSettings | null = null;
  private loadingElapsed = 0;
  private loadingFrames = 0;
  private loadingProgress = 0;
  private shadersReady = false;

  private rafId = 0;
  private lastTime = -1;
  private elapsed = 0;
  private accumulator = 0;
  private pendingUseItem = false;
  private currentMusic: MusicTrack = 'none';
  private audioStarted = false;
  private disposed = false;

  private readonly playerInput: InputState = createEmptyInput();
  /** Fed to the sim while an online race is paused, so the kart coasts to a stop. */
  private readonly idleInput: InputState = createEmptyInput();
  private readonly unsubs: (() => void)[] = [];
  private readonly sunDir = new THREE.Vector3(0.4, 0.8, 0.3);
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private speedFx = 0;
  private boostFx = 0;
  private hitFx = 0;

  constructor(container: HTMLElement) {
    this.container = container;

    // ---------------------------------------------------------- renderer
    const q = this.quality;
    this.adaptive = new AdaptiveResolution(q.minRenderScale);
    document.body.classList.toggle('touch-device', q.touch);
    document.body.dataset.quality = q.tier;

    this.renderer = new THREE.WebGLRenderer({ antialias: q.antialias, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = BASE_EXPOSURE;
    this.renderer.shadowMap.enabled = q.shadows;
    // Soft shadows cost a lot of samples; phones get the cheap filter.
    this.renderer.shadowMap.type = q.tier === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.maxPixelRatio));
    this.renderer.domElement.className = 'game-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1200);
    this.camera.position.set(0, 3, 8);
    this.scene.add(this.camera);

    this.uiRoot = el('div', '', undefined, container);
    this.uiRoot.id = 'ui';

    // ---------------------------------------------------------- systems
    this.input = new InputManager();
    this.audio = new AudioEngine();
    this.particles = new ParticleSystem();
    this.scene.add(this.particles.object);
    this.postfx = new PostFX();
    if (q.postFX) {
      try {
        this.postfx.init(this.renderer, this.scene, this.camera);
      } catch (err) {
        console.error('[Game] PostFX init failed, using plain rendering', err);
        this.postfxOk = false;
      }
    } else {
      // Low tier: bloom and the composite pass are the first things to go.
      this.postfxOk = false;
    }

    // ---------------------------------------------------------- ui
    this.backdrop = new MenuBackdrop();
    this.mainMenu = new MainMenu(this.uiRoot, CHARACTERS as readonly CharacterDef[], TRACKS as readonly TrackDefinition[]);
    this.mainMenu.onHighlight = (id) => this.backdrop.setCharacter(getCharacter(id));
    this.mainMenu.onPanelChange = (panel) => this.onMenuPanel(panel);
    this.mainMenu.onStart = (settings) => this.startRace(settings);

    this.mainMenu.onPlayOnline = () => this.showOnline();

    this.onlineMenu = new OnlineMenu(
      this.uiRoot,
      this.netClient,
      CHARACTERS as readonly CharacterDef[],
      TRACKS as readonly TrackDefinition[],
    );
    this.onlineMenu.onHighlight = (id) => this.backdrop.setCharacter(getCharacter(id));
    this.onlineMenu.onExit = () => {
      this.online = false;
      this.showMenu('title');
    };
    this.onlineMenu.onStart = (setup, trackId, laps, difficulty) => {
      this.online = true;
      const me = setup.grid.find((g) => g.kartId === setup.localKartId);
      this.startRace({ characterId: me?.characterId ?? CHARACTERS[0].id, trackId, laps, difficulty, online: setup });
    };

    this.results = new ResultsScreen(this.uiRoot);
    this.results.onRaceAgain = () => {
      // Online, one client cannot restart on its own: everyone goes back to the room.
      if (this.online) this.backToLobby();
      else if (this.race) this.startRace(this.race.settings);
    };
    this.results.onChangeTrack = () => {
      if (this.online) this.backToLobby();
      else this.returnToMenu('trackSelect');
    };
    this.results.onMainMenu = () => {
      if (this.online) {
        this.online = false;
        this.netClient.abandonRace();
        this.netClient.leaveRoom();
      }
      this.returnToMenu('title');
    };

    this.pauseMenu = new PauseMenu(this.uiRoot);
    this.pauseMenu.onResume = () => this.resume();
    this.pauseMenu.onRestart = () => {
      const settings = this.race?.settings;
      this.leavePause();
      if (this.online) this.backToLobby();
      else if (settings) this.startRace(settings);
      else this.returnToMenu('title');
    };
    this.pauseMenu.onQuit = () => {
      this.leavePause();
      if (this.online) {
        this.backToLobby();
        return;
      }
      this.returnToMenu('title');
    };

    this.loading = new LoadingScreen(this.uiRoot);
    this.muteIndicator = el('div', 'mute-indicator', '🔇 MUTED', this.uiRoot);
    this.touchUi = q.touch;
    this.touch = new TouchControls(this.uiRoot, this.input);

    // ---------------------------------------------------------- listeners
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('pointerdown', this.onPointerDown, { passive: true });
    window.addEventListener('keydown', this.onGesture);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);

    this.onResize();
  }

  // ------------------------------------------------------------------ public

  start(): void {
    if (this.state !== 'boot') return;
    this.showMenu('title');
    this.lastTime = -1;
    this.rafId = requestAnimationFrame(this.loop);
  }

  get currentState(): GameState {
    return this.state;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('keydown', this.onGesture);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.disposeRace();
    this.backdrop.detach(this.scene);
    this.backdrop.dispose();
    this.mainMenu.dispose();
    this.onlineMenu.dispose();
    this.netClient.disconnect();
    this.results.dispose();
    this.pauseMenu.dispose();
    this.loading.dispose();
    this.touch.dispose();
    this.muteIndicator.remove();
    this.input.dispose();
    this.safe(() => this.audio.dispose());
    this.safe(() => this.particles.dispose());
    this.safe(() => this.postfx.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.uiRoot.remove();
  }

  // ------------------------------------------------------------- main loop

  private readonly loop = (now: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    if (this.lastTime < 0) this.lastTime = now;
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    if (dt < 0) dt = 0;
    this.elapsed += dt;

    // Only adapt during a race: menus are cheap, and a menu-time downscale
    // would be inherited by the first frames of the race that follows.
    if (this.race && this.adaptive.update(dt)) {
      this.renderScale = this.adaptive.value;
      this.onResize();
    }

    const input = this.input.update();
    try {
      this.frame(dt, input);
    } catch (err) {
      console.error('[Game] frame error', err);
      events.emit('ui:error', {});
    }
  };

  private frame(dt: number, input: InputState): void {
    switch (this.state) {
      case 'boot':
        return;
      case 'title':
      case 'characterSelect':
      case 'trackSelect':
        if (this.online) {
          if (input.back) this.onlineMenu.handleBack();
        } else {
          this.mainMenu.handleInput(input);
        }
        this.backdrop.update(dt, this.camera);
        this.particles.update(dt, EMPTY_KARTS, this.camera);
        this.audio.update(dt, EMPTY_KARTS, -1, this.camera);
        this.render(dt);
        return;
      case 'loading':
        this.frameLoading(dt);
        return;
      case 'countdown':
      case 'racing':
      case 'finished':
        if (input.pause) {
          this.pause();
          this.render(dt);
          return;
        }
        this.simulate(dt, input);
        this.renderRace(dt, this.state === 'racing' && input.lookBack);
        return;
      case 'paused':
        this.pauseMenu.handleInput(input);
        if (input.pause && this.state === 'paused') this.resume();
        if (this.online && this.race) {
          // Online, the world cannot stop for one player: keep simulating and
          // keep sending snapshots, with the paused kart simply off the throttle.
          this.simulate(dt, this.idleInput);
          this.renderRace(dt, false);
        } else {
          this.render(dt);
        }
        return;
      case 'results':
        this.results.handleInput(input);
        if (this.race && this.state === 'results') {
          // Keep the world alive behind the results panel.
          this.simulate(dt, input);
          this.renderRace(dt, false);
        } else {
          this.render(dt);
        }
        return;
    }
  }

  private frameLoading(dt: number): void {
    this.loading.update(dt);
    this.loadingElapsed += dt;
    this.loadingFrames++;
    // Give the loading screen a frame to paint before the synchronous build.
    if (!this.race && this.loadingFrames >= 2 && this.pendingSettings) {
      const settings = this.pendingSettings;
      try {
        this.buildRace(settings);
      } catch (err) {
        console.error('[Game] failed to build race', err);
        showToast('Could not build the race. Check the console for details.', 'error');
        this.pendingSettings = null;
        this.loading.hide();
        this.showMenu('title');
        return;
      }
      this.warmShaders();
    }

    // Fake progress creeps toward 90% while shaders compile off-thread, then snaps to 100%.
    const ready = this.race !== null && (this.shadersReady || this.loadingElapsed > MAX_COMPILE_WAIT_SECONDS);
    const target = !this.race ? 0.12 : ready ? 1 : 0.9;
    this.loadingProgress = damp(this.loadingProgress, target, ready ? 14 : 1.4, dt);
    this.loading.setProgress(this.loadingProgress);

    if (this.race && ready) {
      // Warm the remaining passes (shadow depth, post-processing) behind the overlay.
      this.renderRace(dt, false);
      if (this.loadingElapsed >= MIN_LOADING_SECONDS && this.loadingProgress > 0.985) this.enterCountdown();
    }
  }

  /** Kick off parallel shader compilation for the freshly built race scene. */
  private warmShaders(): void {
    const r = this.race;
    this.shadersReady = false;
    if (!r) return;
    const renderer = this.renderer as { compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<unknown> };
    if (typeof renderer.compileAsync !== 'function') {
      this.shadersReady = true;
      return;
    }
    let promise: Promise<unknown>;
    try {
      promise = renderer.compileAsync.call(this.renderer, this.scene, this.camera);
    } catch (err) {
      console.warn('[Game] compileAsync threw; falling back to synchronous compile', err);
      this.shadersReady = true;
      return;
    }
    const done = (): void => {
      if (this.race === r) this.shadersReady = true;
    };
    promise.then(done, (err: unknown) => {
      console.warn('[Game] compileAsync failed; falling back to synchronous compile', err);
      done();
    });
  }

  private simulate(dt: number, input: InputState): void {
    const r = this.race;
    if (!r) return;
    if (input.useItem) this.pendingUseItem = true;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step(FIXED_DT, r, input, this.pendingUseItem);
      this.pendingUseItem = false;
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps >= MAX_STEPS_PER_FRAME) this.accumulator = 0;
  }

  private step(dt: number, r: RaceContext, input: InputState, useItem: boolean): void {
    const { track, karts, items } = r;
    const player = r.player;
    // Remote karts run the same physics from the last inputs we received.
    r.net?.applyRemoteInputs(dt);

    // Player input (or auto-drive after finishing).
    if (r.playerAutoDriver) {
      r.playerAutoDriver.update(dt, track, karts, items, null);
    } else {
      const p = this.playerInput;
      p.throttle = input.throttle;
      p.brake = input.brake;
      p.steer = input.steer;
      p.drift = input.drift;
      p.useItem = useItem;
      p.useItemHeld = input.useItemHeld;
      p.lookBack = input.lookBack;
      p.pause = false;
      p.confirm = false;
      p.back = false;
      p.menuUp = false;
      p.menuDown = false;
      p.menuLeft = false;
      p.menuRight = false;
      player.setInput(p);
    }

    for (let i = 0; i < r.aiDrivers.length; i++) {
      r.aiDrivers[i].update(dt, track, karts, items, player);
    }

    for (let i = 0; i < karts.length; i++) {
      karts[i].update(dt, track, karts);
    }

    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      const inp = k.input;
      if (inp.useItem && !k.state.itemRouletteActive && k.state.item !== 'none') {
        items.requestUse(k, inp.brake > 0.5 || inp.lookBack);
      }
    }

    // Nudge remote karts back onto their owner's authoritative pose before the
    // race manager reads positions for laps and places.
    r.net?.correctRemotes(dt);

    items.update(dt);
    r.raceManager.update(dt);
  }

  private renderRace(dt: number, lookBack: boolean): void {
    const r = this.race;
    if (!r) {
      this.render(dt);
      return;
    }
    const player = r.player;
    r.net?.send(dt);
    for (let i = 0; i < r.karts.length; i++) r.karts[i].updateVisuals(dt);
    r.track.update(dt, this.elapsed);
    r.followCamera.update(dt, player, lookBack);
    this.updateSun(r, player);
    if (r.weather.active) {
      // One terrain sample under the camera is enough for flakes to settle on:
      // the shader fades them out across half a metre either side of it.
      const cam = this.camera.position;
      r.weather.update(dt, this.camera, r.track.heightAt(cam.x, cam.z));
    }
    this.particles.update(dt, r.karts, this.camera);
    this.audio.update(dt, r.karts, player.state.id, this.camera);
    r.hud.update(dt, player, r.karts, r.raceManager.raceTime, r.raceManager.totalLaps);
    r.hud.setNetwork(r.net ? this.netClient.pingMs : null);
    this.updatePostFxFeel(dt, player);

    if (this.state === 'finished' && r.resultsTimer > 0) {
      r.resultsTimer -= dt;
      if (r.resultsTimer <= 0) this.enterResults();
    }
    this.render(dt);
  }

  private render(dt: number): void {
    if (this.postfxOk) {
      try {
        this.postfx.render(dt);
        return;
      } catch (err) {
        console.error('[Game] PostFX render failed; falling back to plain rendering', err);
        this.postfxOk = false;
        this.safe(() => this.postfx.setEnabled(false));
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Weather lightning: a white frame plus a short spike in the key light. */
  private strikeLightning(color: number): void {
    const r = this.race;
    if (!r) return;
    if (this.postfxOk) this.safe(() => this.postfx.flash(color, 0.22));
    const sun = r.sun;
    const base = sun.intensity;
    sun.intensity = base * 2.4;
    // Restored on the next frame; a longer ramp would fight updateSun.
    requestAnimationFrame(() => {
      if (this.race === r) sun.intensity = base;
    });
  }

  private updateSun(r: RaceContext, player: IKart): void {
    const p = player.state.position;
    // Snap the shadow frustum to a coarse grid to avoid edge shimmer while driving.
    const snap = 2;
    this.tmpA.set(Math.round(p.x / snap) * snap, Math.round(p.y / snap) * snap, Math.round(p.z / snap) * snap);
    r.sun.target.position.copy(this.tmpA);
    r.sun.position.copy(this.tmpA).addScaledVector(this.sunDir, SUN_DISTANCE);

    // Fill light shines from just above the camera toward the player kart.
    if (r.fill.visible) {
      r.fill.position.copy(this.camera.position);
      r.fill.position.y += 2;
      r.fill.target.position.copy(p);
    }
  }

  private updatePostFxFeel(dt: number, player: IKart): void {
    if (!this.postfxOk) return;
    const s = player.state;
    const top = Math.max(1, player.topSpeed());
    const speedTarget = clamp01((Math.abs(s.speed) - top * 0.55) / (top * 0.9));
    const boostTarget = s.isBoosting ? clamp01(0.45 + s.boostStrength) : s.isInvincible ? 0.35 : 0;
    this.speedFx = damp(this.speedFx, speedTarget, 5, dt);
    this.boostFx = damp(this.boostFx, boostTarget, s.isBoosting ? 12 : 4, dt);
    if (this.hitFx > 0) {
      this.hitFx = damp(this.hitFx, 0, 3, dt);
      if (this.hitFx < 0.005) this.hitFx = 0;
    }
    this.postfx.setSpeedEffect(this.speedFx);
    this.postfx.setBoostEffect(this.boostFx);
    this.postfx.setHitEffect(this.hitFx);
  }

  // ------------------------------------------------------------ state flow

  private setState(next: GameState): void {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.uiRoot.dataset.state = next;
    // The driving pad belongs to the race, not the menus - and not the pause
    // screen either, where a stray thumb would keep the throttle open.
    this.syncTouchPad();
    events.emit('game:stateChange', { from, to: next });
  }

  private showMenu(panel: MenuPanel): void {
    this.results.hide();
    this.pauseMenu.hide();
    this.loading.hide();
    this.onlineMenu.hide();
    this.backdrop.setCharacter(this.mainMenu.highlightedCharacter);
    this.backdrop.setFraming(framingFor(panel), true);
    this.backdrop.attach(this.scene, this.camera, this.renderer);
    this.mainMenu.show(panel);
    this.setState(panel);
    this.playMusic('menu');
  }

  private onMenuPanel(panel: MenuPanel): void {
    if (this.state === 'title' || this.state === 'characterSelect' || this.state === 'trackSelect') {
      this.setState(panel);
      this.backdrop.setFraming(framingFor(panel));
    }
  }

  private returnToMenu(panel: MenuPanel): void {
    this.disposeRace();
    this.showMenu(panel);
  }

  /** Title screen -> online lobby. The menu backdrop keeps running behind it. */
  private showOnline(): void {
    this.online = true;
    this.disposeRace();
    this.results.hide();
    this.pauseMenu.hide();
    this.loading.hide();
    this.mainMenu.hide();
    this.backdrop.setFraming('characters', true);
    this.backdrop.attach(this.scene, this.camera, this.renderer);
    this.onlineMenu.show();
    this.setState('characterSelect');
    this.playMusic('menu');
  }

  /** Leaves the current online race but stays in the room. */
  private backToLobby(): void {
    if (this.netClient.isHost) this.netClient.abandonRace();
    this.disposeRace();
    this.results.hide();
    this.pauseMenu.hide();
    this.loading.hide();
    this.mainMenu.hide();
    this.backdrop.setFraming('characters', true);
    this.backdrop.attach(this.scene, this.camera, this.renderer);
    this.onlineMenu.show('lobby');
    this.setState('characterSelect');
    this.playMusic('menu');
  }

  private startRace(settings: RaceSettings): void {
    this.disposeRace();
    this.backdrop.detach(this.scene);
    this.mainMenu.hide();
    this.onlineMenu.hide();
    this.results.hide();
    this.pauseMenu.hide();
    this.safe(() => this.particles.reset());

    let trackDef: TrackDefinition;
    try {
      trackDef = getTrackDef(settings.trackId) as TrackDefinition;
    } catch {
      trackDef = TRACKS[0] as TrackDefinition;
    }
    if (!trackDef) {
      showToast('No tracks are available yet.', 'error');
      this.showMenu('title');
      return;
    }
    this.pendingSettings = { ...settings, trackId: trackDef.id };
    this.loadingElapsed = 0;
    this.loadingFrames = 0;
    this.loadingProgress = 0;
    this.shadersReady = false;
    this.loading.show(trackDef);
    this.scene.background = new THREE.Color(0x0b0b1a);
    this.scene.fog = null;
    this.setState('loading');
  }

  private buildRace(settings: RaceSettings): void {
    // Partially constructed pieces, cleaned up if a later constructor throws.
    const partial: PartialRace = { track: null, karts: [], items: null, followCamera: null, hud: null };
    try {
      this.buildRaceInner(settings, partial);
    } catch (err) {
      const { hud, followCamera, items, karts, track } = partial;
      if (hud) this.safe(() => hud.dispose());
      if (followCamera) this.safe(() => followCamera.dispose());
      if (items) this.safe(() => items.dispose());
      for (const k of karts) this.safe(() => k.dispose());
      if (track) this.safe(() => track.dispose());
      throw err;
    }
  }

  private buildRaceInner(settings: RaceSettings, partial: PartialRace): void {
    const trackDef = getTrackDef(settings.trackId) as TrackDefinition;
    const track: ITrack = new Track(trackDef);
    partial.track = track;
    const env = trackDef.environment;
    const karts = partial.karts;

    const difficulty: Difficulty = settings.difficulty;
    const aiDrivers: IAIDriver[] = [];
    const online = settings.online;
    let player: IKart;

    if (online) {
      // The grid comes from the server, so every client builds the same one.
      for (const entry of online.grid) {
        const def = getCharacter(entry.characterId) as CharacterDef;
        const kart = new Kart(entry.kartId, def, entry.kartId === online.localKartId);
        kart.state.displayName = entry.name;
        karts.push(kart);
      }
      karts.sort((a, b) => a.state.id - b.state.id);
      player = karts.find((k) => k.state.id === online.localKartId) ?? karts[0];
      // Only the host drives the CPU field; everyone else receives it over the wire.
      if (online.host) {
        for (const entry of online.grid) {
          if (entry.human) continue;
          const kart = karts.find((k) => k.state.id === entry.kartId);
          if (kart) aiDrivers.push(new AIDriver(kart, difficulty, entry.kartId));
        }
      }
    } else {
      // Karts: player 0 with the chosen character, AI 1..7 with the rest shuffled.
      let playerChar: CharacterDef;
      try {
        playerChar = getCharacter(settings.characterId) as CharacterDef;
      } catch {
        playerChar = CHARACTERS[0] as CharacterDef;
      }
      const others = (CHARACTERS as readonly CharacterDef[]).filter((c) => c.id !== playerChar.id);
      for (let i = others.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = others[i];
        others[i] = others[j];
        others[j] = t;
      }
      karts.push(new Kart(0, playerChar, true));
      for (let id = 1; id < KART_COUNT; id++) {
        const def = others.length > 0 ? others[(id - 1) % others.length] : playerChar;
        karts.push(new Kart(id, def, false));
      }
      player = karts[0];
      for (let id = 1; id < karts.length; id++) {
        aiDrivers.push(new AIDriver(karts[id], difficulty, id));
      }
    }

    const items: IItemManager = new ItemManager(this.particles);
    partial.items = items;
    items.init(track, karts);

    let net: NetRace | null = null;
    if (online) {
      // We simulate our own kart, plus the CPU field when we are the host.
      const owned = [online.localKartId];
      if (online.host) {
        for (const entry of online.grid) if (!entry.human) owned.push(entry.kartId);
      }
      net = new NetRace(this.netClient, karts, items, owned);
    }

    const raceManager = new RaceManager(track, karts, settings);
    const followCamera = new FollowCamera(this.camera);
    partial.followCamera = followCamera;
    followCamera.setTrack(track);

    const hud = new HUD(this.uiRoot, buildItemIcon);
    partial.hud = hud;
    hud.setTrack(track);
    this.touch.bringToFront();

    // Lights from the track environment.
    const sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
    const sc = sun.shadow.camera;
    sc.left = -SHADOW_HALF_EXTENT;
    sc.right = SHADOW_HALF_EXTENT;
    sc.top = SHADOW_HALF_EXTENT;
    sc.bottom = -SHADOW_HALF_EXTENT;
    sc.near = 1;
    sc.far = SUN_DISTANCE + SHADOW_HALF_EXTENT * 3;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    this.sunDir.set(env.sunDirection.x, env.sunDirection.y, env.sunDirection.z);
    if (this.sunDir.lengthSq() < 1e-6) this.sunDir.set(0.4, 0.8, 0.3);
    if (this.sunDir.y < 0) this.sunDir.y = -this.sunDir.y;
    if (this.sunDir.y < 0.15) this.sunDir.y = 0.15;
    this.sunDir.normalize();
    const hemi = new THREE.HemisphereLight(env.ambientSky, env.ambientGround, env.ambientIntensity);
    // Camera-following fill: strong on dim night tracks, zero on sunny ones.
    const darkness =
      clamp(0.9 - env.ambientIntensity, 0, 0.6) + clamp((1.6 - env.sunIntensity) * 0.3, 0, 0.3);
    const fill = new THREE.DirectionalLight(0xd9e4ff, darkness);
    fill.castShadow = false;
    fill.visible = darkness > 0.01;
    const fog = env.fogDensity > 0 ? new THREE.FogExp2(env.fogColor, env.fogDensity) : null;
    const background = new THREE.Color(env.skyHorizon);

    // Weather is presentation only: it never touches physics, and both clients
    // in an online race build the same layers from the same track definition.
    const weather = new Weather(env.weather, this.quality.weatherScale);
    weather.onLightning = (color) => this.strikeLightning(color);
    weather.setViewportHeight(this.renderer.domElement.height);

    // Reflections for the bodywork, painted from this circuit's own sky.
    const envProbe = buildEnvironmentProbe(this.renderer, env, this.quality.envMapSize);
    this.scene.environment = envProbe;
    // Enough for the bodywork to catch the sky; more than this and the probe
    // starts acting as a second ambient light and washes the circuit out.
    this.scene.environmentIntensity = envProbe ? ENV_PROBE_INTENSITY : 0;
    this.renderer.toneMappingExposure = env.exposure ?? BASE_EXPOSURE;

    this.scene.add(track.object);
    for (const k of karts) this.scene.add(k.object);
    this.scene.add(items.object);
    this.scene.add(sun, sun.target, hemi, fill, fill.target);
    if (weather.active) this.scene.add(weather.object);
    this.scene.fog = fog;
    this.scene.background = background;

    const r: RaceContext = {
      settings,
      trackDef,
      track,
      karts,
      player,
      net,
      aiDrivers,
      playerAutoDriver: null,
      items,
      raceManager,
      followCamera,
      hud,
      sun,
      hemi,
      fill,
      fog,
      background,
      weather,
      envProbe,
      unsubs: [],
      resultsTimer: 0,
    };
    this.race = r;
    this.adaptive.reset();
    this.renderScale = 1;
    this.onResize();
    this.accumulator = 0;
    this.pendingUseItem = false;
    this.speedFx = 0;
    this.boostFx = 0;
    this.hitFx = 0;

    // `?auto=1` hands the player's kart to the AI. It is not dev-only on purpose:
    // tools/browser-check.mjs drives real races through the production build with it.
    if (new URLSearchParams(location.search).has('auto')) {
      r.playerAutoDriver = new AIDriver(player, 'hard', player.state.id);
    }
    if (import.meta.env.DEV) {
      (window as unknown as { __lk?: unknown }).__lk = {
        game: this,
        getRace: () => this.race,
        renderer: this.renderer,
        events,
      };
    }

    // Sync visuals once so the first rendered frame is sane.
    for (const k of karts) k.updateVisuals(0);
    followCamera.snapTo(player);
    this.updateSun(r, player);

    r.unsubs.push(
      events.on('race:start', () => {
        if (this.race === r && this.state === 'countdown') this.setState('racing');
      }),
      events.on('race:lap', (e) => {
        if (this.race !== r || !e.isPlayer) return;
        if (e.isFinalLap) this.playMusic('finalLap');
      }),
      events.on('race:finish', (e) => {
        if (this.race !== r || !e.isPlayer) return;
        this.onPlayerFinished(r);
      }),
      events.on('race:allFinished', () => {
        if (this.race !== r) return;
        if (this.state === 'finished') r.resultsTimer = RESULTS_DELAY_SECONDS;
        else if (this.state === 'racing' || this.state === 'countdown') this.enterResults();
      }),
      events.on('item:hit', (e) => {
        if (this.race !== r || !e.isPlayer) return;
        this.hitFx = 1;
      }),
      events.on('item:lightning', () => {
        if (this.race !== r || !this.postfxOk) return;
        this.safe(() => this.postfx.flash(0xffffff, 0.3));
      }),
    );
  }

  private enterCountdown(): void {
    const r = this.race;
    if (!r) return;
    this.pendingSettings = null;
    this.loading.hide();
    r.hud.show();

    // Cinematic: wide shot of the grid swooping into the chase position.
    const grid = r.track.startGrid;
    const center = this.tmpA.set(0, 0, 0);
    const n = Math.min(grid.length, KART_COUNT);
    if (n > 0) {
      for (let i = 0; i < n; i++) center.add(grid[i].position);
      center.multiplyScalar(1 / n);
    } else {
      center.copy(r.player.state.position);
    }
    const forward = this.tmpB;
    r.player.forwardDir(forward);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.y = 0;
    forward.normalize();
    const right = this.tmpC.set(-forward.z, 0, forward.x);
    const from = center.clone().addScaledVector(forward, 18).addScaledVector(right, 11);
    from.y += 6.5;
    const look = center.clone();
    look.y += 0.8;
    r.followCamera.setCinematic(from, look, 3 * COUNTDOWN_STEP_SECONDS, 46);

    r.raceManager.startCountdown();
    this.setState('countdown');
    this.safe(() => this.audio.setCircuit?.(r.trackDef.id));
    this.playMusic('race');
  }

  private onPlayerFinished(r: RaceContext): void {
    if (this.state !== 'racing' && this.state !== 'countdown') return;
    try {
      r.playerAutoDriver = new AIDriver(r.player, 'normal', r.player.state.id);
    } catch (err) {
      console.warn('[Game] could not create auto-driver for the player', err);
      r.playerAutoDriver = null;
    }
    if (this.postfxOk) this.safe(() => this.postfx.flash(0xffffff, 0.35));
    this.setState('finished');
    if (r.raceManager.allFinished) r.resultsTimer = RESULTS_DELAY_SECONDS;
  }

  private enterResults(): void {
    const r = this.race;
    if (!r || this.state === 'results') return;
    r.hud.hide();
    const standings = r.raceManager.getStandings();
    if (r.net) {
      // The server decides who actually crossed first; local simulation only
      // fills in racers it never heard a finish for.
      for (const row of standings) {
        const place = r.net.places.get(row.kartId);
        if (place !== undefined) row.place = place;
      }
      standings.sort((a, b) => a.place - b.place);
    }
    this.results.show(standings);
    this.setState('results');
    this.playMusic('results');
  }

  private pause(): void {
    if (this.state !== 'countdown' && this.state !== 'racing' && this.state !== 'finished') return;
    this.prePauseState = this.state;
    this.setState('paused');
    this.pauseMenu.show();
    events.emit('game:pause', {});
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.pauseMenu.hide();
    this.accumulator = 0;
    this.pendingUseItem = false;
    this.setState(this.prePauseState);
    events.emit('game:resume', {});
  }

  /** Leave the paused state without returning to the race (restart / quit). */
  private leavePause(): void {
    this.pauseMenu.hide();
    if (this.state === 'paused') {
      // Other systems may have ducked audio / frozen timers on game:pause.
      events.emit('game:resume', {});
    }
  }

  private disposeRace(): void {
    const r = this.race;
    if (!r) return;
    this.race = null;
    r.net?.dispose();
    for (const u of r.unsubs) u();
    r.unsubs.length = 0;

    this.scene.remove(r.track.object);
    for (const k of r.karts) this.scene.remove(k.object);
    this.scene.remove(r.items.object);
    this.scene.remove(r.sun, r.sun.target, r.hemi, r.fill, r.fill.target);
    this.scene.remove(r.weather.object);
    r.weather.dispose();
    r.envProbe?.dispose();
    this.scene.environment = null;
    this.scene.environmentIntensity = 1;
    this.renderer.toneMappingExposure = BASE_EXPOSURE;
    r.sun.dispose();
    r.hemi.dispose();
    r.fill.dispose();
    this.scene.fog = null;

    this.safe(() => r.items.dispose());
    for (const k of r.karts) this.safe(() => k.dispose());
    this.safe(() => r.track.dispose());
    r.raceManager.dispose();
    r.followCamera.dispose();
    r.hud.dispose();
    this.safe(() => this.particles.reset());
    if (this.postfxOk) {
      this.safe(() => {
        this.postfx.setSpeedEffect(0);
        this.postfx.setBoostEffect(0);
        this.postfx.setHitEffect(0);
      });
    }
    this.accumulator = 0;
    this.pendingUseItem = false;
  }

  // ---------------------------------------------------------------- audio

  private playMusic(track: MusicTrack): void {
    this.currentMusic = track;
    this.safe(() => this.audio.playMusic(track));
  }

  private enableTouchUi(): void {
    if (this.touchUi) return;
    this.touchUi = true;
    document.body.classList.add('touch-device');
    this.syncTouchPad();
  }

  private syncTouchPad(): void {
    const racing = this.state === 'countdown' || this.state === 'racing' || this.state === 'finished';
    this.touch.setVisible(racing && this.touchUi);
  }

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (ev.pointerType === 'touch') this.enableTouchUi();
    this.onGesture();
  };

  private readonly onGesture = (): void => {
    if (this.audioStarted) return;
    this.audioStarted = true;
    window.removeEventListener('keydown', this.onGesture);
    this.audio
      .init()
      .then(() => {
        if (this.currentMusic !== 'none') this.safe(() => this.audio.playMusic(this.currentMusic));
      })
      .catch((err: unknown) => {
        console.warn('[Game] audio init failed', err);
        this.audioStarted = false;
        window.addEventListener('keydown', this.onGesture);
      });
  };

  private toggleMute(): void {
    const muted = !this.audio.muted;
    this.safe(() => this.audio.setMuted(muted));
    this.muteIndicator.classList.toggle('visible', muted);
  }

  // ------------------------------------------------------------- listeners

  private readonly onResize = (): void => {
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    // Device pixel ratio is capped by the quality tier, then scaled again by the
    // adaptive controller. Phones ship 3x screens they cannot afford to fill.
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio) * this.renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.race?.weather.setViewportHeight(this.renderer.domElement.height);
    if (this.postfxOk) {
      try {
        this.postfx.setSize(w, h, pr);
      } catch (err) {
        console.error('[Game] PostFX resize failed', err);
        this.postfxOk = false;
      }
    }
  };

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.repeat) return;
    // Ignore shortcuts while a text field has focus (the lobby name / room code).
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (ev.key === 'm' || ev.key === 'M') this.toggleMute();
    else if ((ev.key === 'o' || ev.key === 'O') && this.state === 'title') this.showOnline();
  };

  private readonly onBlur = (): void => {
    // Never auto-pause an online race: the other players are still driving.
    if (this.online) return;
    if (this.state === 'racing' || this.state === 'countdown') this.pause();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.onBlur();
  };

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error('[Game]', err);
    }
  }
}
