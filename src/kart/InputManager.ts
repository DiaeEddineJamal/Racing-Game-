/**
 * Keyboard + Gamepad + touch input. `update()` is called once per render frame
 * and returns a reused InputState. Edge fields (useItem, pause, confirm, back,
 * menu*) are true only for the call right after the press.
 *
 * Touch is a third channel rather than a separate path: ui/TouchControls writes
 * into `touch` from pointer events, and update() folds it in with the other two.
 * That keeps one definition of "what the player is doing" for every device, and
 * means a phone with a Bluetooth pad connected can use both at once.
 */
import { createEmptyInput, type InputState } from '../core/types';
import { clamp } from '../core/math';

const KEY_THROTTLE = ['KeyW', 'ArrowUp'];
const KEY_BRAKE = ['KeyS', 'ArrowDown'];
const KEY_LEFT = ['KeyA', 'ArrowLeft'];
const KEY_RIGHT = ['KeyD', 'ArrowRight'];
const KEY_DRIFT = ['Space', 'ShiftLeft', 'ShiftRight'];
const KEY_ITEM = ['KeyE', 'ControlLeft', 'ControlRight', 'Enter', 'NumpadEnter'];
const KEY_LOOKBACK = ['KeyQ'];
const KEY_PAUSE = ['Escape', 'KeyP'];
const KEY_BACK = ['Escape', 'KeyP', 'Backspace'];
const KEY_CONFIRM = ['Enter', 'NumpadEnter', 'Space'];

/** Keys whose browser default (scrolling, etc.) we suppress. */
const GAME_KEYS = new Set<string>([
  ...KEY_THROTTLE,
  ...KEY_BRAKE,
  ...KEY_LEFT,
  ...KEY_RIGHT,
  ...KEY_DRIFT,
  ...KEY_ITEM,
  ...KEY_LOOKBACK,
  ...KEY_PAUSE,
  ...KEY_CONFIRM,
]);

// Standard gamepad mapping.
const PAD_A = 0;
const PAD_B = 1;
const PAD_X = 2;
const PAD_Y = 3;
const PAD_LB = 4;
const PAD_RB = 5;
const PAD_LT = 6;
const PAD_RT = 7;
const PAD_START = 9;
const PAD_UP = 12;
const PAD_DOWN = 13;
const PAD_LEFT = 14;
const PAD_RIGHT = 15;
const PAD_BUTTON_COUNT = 17;

const STICK_DEADZONE = 0.15;
const STEER_RAMP_UP_TIME = 0.12;
const STEER_RAMP_DOWN_TIME = 0.08;
const MENU_STICK_THRESHOLD = 0.55;

/**
 * Written by ui/TouchControls, read once per frame by InputManager. Edge fields
 * are latched by the control and consumed (cleared) by the next update().
 */
export interface TouchChannel {
  throttle: number;
  brake: number;
  /** Analog steer target in [-1, 1]. Ramped exactly like the keyboard. */
  steerTarget: number;
  drift: boolean;
  useItemHeld: boolean;
  lookBack: boolean;
  useItemEdge: boolean;
  pauseEdge: boolean;
  confirmEdge: boolean;
  backEdge: boolean;
}

export class InputManager {
  /** Touch surface state. See TouchChannel. */
  readonly touch: TouchChannel = {
    throttle: 0,
    brake: 0,
    steerTarget: 0,
    drift: false,
    useItemHeld: false,
    lookBack: false,
    useItemEdge: false,
    pauseEdge: false,
    confirmEdge: false,
    backEdge: false,
  };

  private readonly state: InputState = createEmptyInput();
  private readonly held = new Set<string>();
  /** Codes pressed since the previous update (consumed for edges). */
  private readonly pressed = new Set<string>();
  private keyboardSteer = 0;
  private touchSteer = 0;
  private lastTime = 0;

  private padButtons: boolean[] = new Array<boolean>(PAD_BUTTON_COUNT).fill(false);
  private prevPadButtons: boolean[] = new Array<boolean>(PAD_BUTTON_COUNT).fill(false);
  private padStickMenuX = 0;
  private padStickMenuY = 0;
  private prevPadStickMenuX = 0;
  private prevPadStickMenuY = 0;
  private disposed = false;

  constructor() {
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.lastTime = performance.now();
  }

  /** True while any gamepad is connected and readable. */
  get hasGamepad(): boolean {
    return this.getPad() !== null;
  }

  update(): InputState {
    const s = this.state;
    const now = performance.now();
    const dt = clamp((now - this.lastTime) / 1000, 0, 0.1);
    this.lastTime = now;

    // --- keyboard --------------------------------------------------------------
    const kbThrottle = this.anyHeld(KEY_THROTTLE) ? 1 : 0;
    const kbBrake = this.anyHeld(KEY_BRAKE) ? 1 : 0;
    const steerTarget = (this.anyHeld(KEY_RIGHT) ? 1 : 0) - (this.anyHeld(KEY_LEFT) ? 1 : 0);
    this.keyboardSteer = rampToward(this.keyboardSteer, steerTarget, dt);

    // --- touch -----------------------------------------------------------------
    const touch = this.touch;
    this.touchSteer = rampToward(this.touchSteer, clamp(touch.steerTarget, -1, 1), dt);

    // --- gamepad ---------------------------------------------------------------
    const pad = this.getPad();
    let padThrottle = 0;
    let padBrake = 0;
    let padSteer = 0;
    const prev = this.prevPadButtons;
    const cur = this.padButtons;
    // swap buffers
    this.prevPadButtons = cur;
    this.padButtons = prev;
    const buttons = this.padButtons;
    this.prevPadStickMenuX = this.padStickMenuX;
    this.prevPadStickMenuY = this.padStickMenuY;
    if (pad) {
      for (let i = 0; i < PAD_BUTTON_COUNT; i++) {
        const b = pad.buttons[i];
        buttons[i] = b ? b.pressed || b.value > 0.5 : false;
      }
      padThrottle = pad.buttons[PAD_RT] ? clamp(pad.buttons[PAD_RT].value, 0, 1) : 0;
      padBrake = pad.buttons[PAD_LT] ? clamp(pad.buttons[PAD_LT].value, 0, 1) : 0;
      if (padThrottle === 0 && buttons[PAD_RT]) padThrottle = 1;
      if (padBrake === 0 && buttons[PAD_LT]) padBrake = 1;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      padSteer = applyDeadzone(ax);
      this.padStickMenuX = Math.abs(ax) > MENU_STICK_THRESHOLD ? Math.sign(ax) : 0;
      this.padStickMenuY = Math.abs(ay) > MENU_STICK_THRESHOLD ? Math.sign(ay) : 0;
    } else {
      for (let i = 0; i < PAD_BUTTON_COUNT; i++) buttons[i] = false;
      this.padStickMenuX = 0;
      this.padStickMenuY = 0;
    }
    const padEdge = this.padEdge;

    // --- compose -----------------------------------------------------------------
    s.throttle = Math.max(kbThrottle, padThrottle, touch.throttle);
    s.brake = Math.max(kbBrake, padBrake, touch.brake);
    s.steer = clamp(this.keyboardSteer + padSteer + this.touchSteer, -1, 1);
    s.drift = this.anyHeld(KEY_DRIFT) || buttons[PAD_A] || buttons[PAD_RB] || touch.drift;
    s.useItemHeld = this.anyHeld(KEY_ITEM) || buttons[PAD_X] || buttons[PAD_LB] || touch.useItemHeld;
    s.lookBack = this.anyHeld(KEY_LOOKBACK) || buttons[PAD_Y] || touch.lookBack;

    s.useItem = this.anyPressed(KEY_ITEM) || padEdge(PAD_X) || padEdge(PAD_LB) || touch.useItemEdge;
    s.pause = this.anyPressed(KEY_PAUSE) || padEdge(PAD_START) || touch.pauseEdge;
    s.confirm = this.anyPressed(KEY_CONFIRM) || padEdge(PAD_A) || touch.confirmEdge;
    s.back = this.anyPressed(KEY_BACK) || padEdge(PAD_B) || touch.backEdge;
    s.menuUp =
      this.anyPressed(KEY_THROTTLE) ||
      padEdge(PAD_UP) ||
      (this.padStickMenuY < 0 && this.prevPadStickMenuY >= 0);
    s.menuDown =
      this.anyPressed(KEY_BRAKE) ||
      padEdge(PAD_DOWN) ||
      (this.padStickMenuY > 0 && this.prevPadStickMenuY <= 0);
    s.menuLeft =
      this.anyPressed(KEY_LEFT) ||
      padEdge(PAD_LEFT) ||
      (this.padStickMenuX < 0 && this.prevPadStickMenuX >= 0);
    s.menuRight =
      this.anyPressed(KEY_RIGHT) ||
      padEdge(PAD_RIGHT) ||
      (this.padStickMenuX > 0 && this.prevPadStickMenuX <= 0);

    this.pressed.clear();
    touch.useItemEdge = false;
    touch.pauseEdge = false;
    touch.confirmEdge = false;
    touch.backEdge = false;
    return s;
  }

  /** Drops every touch input. Called when the on-screen controls are hidden. */
  clearTouch(): void {
    const t = this.touch;
    t.throttle = 0;
    t.brake = 0;
    t.steerTarget = 0;
    t.drift = false;
    t.useItemHeld = false;
    t.lookBack = false;
    t.useItemEdge = false;
    t.pauseEdge = false;
    t.confirmEdge = false;
    t.backEdge = false;
    this.touchSteer = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.held.clear();
    this.pressed.clear();
  }

  // ---------------------------------------------------------------------------

  private anyHeld(codes: readonly string[]): boolean {
    for (let i = 0; i < codes.length; i++) if (this.held.has(codes[i])) return true;
    return false;
  }

  private anyPressed(codes: readonly string[]): boolean {
    for (let i = 0; i < codes.length; i++) if (this.pressed.has(codes[i])) return true;
    return false;
  }

  private readonly padEdge = (i: number): boolean => this.padButtons[i] && !this.prevPadButtons[i];

  private getPad(): Gamepad | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      return null;
    }
    let fallback: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      if (p.mapping === 'standard') return p;
      if (!fallback) fallback = p;
    }
    return fallback;
  }

  private isTextTarget(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t || !(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.isTextTarget(e)) return;
    const code = e.code;
    if (GAME_KEYS.has(code) && !e.metaKey && !e.altKey) e.preventDefault();
    if (e.repeat) return;
    if (!this.held.has(code)) this.pressed.add(code);
    this.held.add(code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
    this.clearTouch();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') this.held.clear();
  };
}

function applyDeadzone(v: number): number {
  const a = Math.abs(v);
  if (a < STICK_DEADZONE) return 0;
  const n = (a - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  // Slight curve for finer control near centre.
  return Math.sign(v) * Math.pow(clamp(n, 0, 1), 1.25);
}

/** Keyboard steer ramps to full in ~0.12s and returns to centre in ~0.08s. */
function rampToward(current: number, target: number, dt: number): number {
  if (current === target) return current;
  const movingOut = Math.abs(target) > Math.abs(current) && Math.sign(target) === Math.sign(current || target);
  const rate = movingOut ? 1 / STEER_RAMP_UP_TIME : 1 / STEER_RAMP_DOWN_TIME;
  const step = rate * dt;
  if (Math.abs(target - current) <= step) return target;
  return current + Math.sign(target - current) * step;
}
