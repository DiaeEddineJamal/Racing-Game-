/**
 * On-screen driving controls for phones and tablets, portrait and landscape.
 *
 * Layout follows how thumbs actually rest on a phone:
 *  - Left thumb: one analog steer bar with an arrow at each end. Sliding
 *    across it steers proportionally; a dead band in the middle lets the kart
 *    run straight without twitching. LOOK sits just above it, still in reach.
 *  - Right thumb: GAS (big, in the corner), DRIFT directly above it - the two
 *    are used together out of every corner - with BRAKE and ITEM inboard.
 *  - Top centre: PAUSE and the auto-gas toggle, pressed between corners.
 *
 * The stylesheet keeps the HUD out of the bottom band the controls occupy
 * (--touch-band), and the pads stay semi-transparent so the track reads
 * through them. Auto-accelerate is on by default (two thumbs, five inputs);
 * GAS still works, it is never hidden.
 *
 * Everything writes into InputManager's touch channel, so the kart never
 * learns where the input came from.
 */
import type { InputManager } from '../kart/InputManager';
import { el } from './dom';

const AUTO_GAS_KEY = 'lk.autoGas';

/** Short buzz on a press, where the browser allows it. */
function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* vibration is a nicety, never a requirement */
  }
}

function readAutoGas(): boolean {
  try {
    const stored = localStorage.getItem(AUTO_GAS_KEY);
    return stored === null ? true : stored === '1';
  } catch {
    return true;
  }
}

function writeAutoGas(on: boolean): void {
  try {
    localStorage.setItem(AUTO_GAS_KEY, on ? '1' : '0');
  } catch {
    /* private browsing */
  }
}

function svgIcon(path: string, viewBox = '0 0 24 24'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('touch-icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'currentColor');
  svg.appendChild(p);
  return svg;
}

function labeledButton(className: string, label: string, path: string, parent: HTMLElement): HTMLElement {
  const btn = el('div', `touch-btn ${className}`, undefined, parent);
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-label', label);
  btn.appendChild(svgIcon(path));
  el('span', 'touch-btn-label', label, btn);
  return btn;
}

export class TouchControls {
  private readonly root: HTMLElement;
  private readonly steerPad: HTMLElement;
  private readonly steerFill: HTMLElement;
  private readonly steerKnob: HTMLElement;
  private readonly arrowLeft: HTMLElement;
  private readonly arrowRight: HTMLElement;
  private readonly gasButton: HTMLElement;
  private readonly autoChip: HTMLElement;

  /** Pointer currently owning the steer pad, or -1. */
  private steerPointer = -1;
  private autoGas = readAutoGas();
  private visible = false;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly input: InputManager,
  ) {
    this.root = el('div', 'touch-controls hidden', undefined, parent);
    this.root.addEventListener('contextmenu', (ev) => ev.preventDefault());

    // ------------------------------------------------------------ steering
    this.steerPad = el('div', 'touch-steer', undefined, this.root);
    this.steerPad.setAttribute('role', 'slider');
    this.steerPad.setAttribute('aria-label', 'Steer');
    this.arrowLeft = el('div', 'touch-arrow left', undefined, this.steerPad);
    this.arrowLeft.appendChild(svgIcon('M15.5 4.5L7 12l8.5 7.5V4.5z'));
    this.steerFill = el('div', 'touch-steer-fill', undefined, this.steerPad);
    this.steerKnob = el('div', 'touch-steer-knob', undefined, this.steerPad);
    this.arrowRight = el('div', 'touch-arrow right', undefined, this.steerPad);
    this.arrowRight.appendChild(svgIcon('M8.5 4.5L17 12l-8.5 7.5V4.5z'));
    el('div', 'touch-steer-caption', 'STEER', this.steerPad);
    this.bindSteer();

    // -------------------------------------------------------------- drive
    const drive = el('div', 'touch-drive', undefined, this.root);
    const itemBtn = labeledButton('item', 'ITEM', 'M12 2l2.9 6.1L21 9.2l-4.5 4.3L17.8 20 12 16.9 6.2 20l1.3-6.5L3 9.2l6.1-1.1L12 2z', drive);
    const brakeBtn = labeledButton('brake', 'BRAKE', 'M7 5h10a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V7a2 2 0 012-2z', drive);
    const driftBtn = labeledButton('drift', 'DRIFT', 'M13 2L4 13h7l-2 9 11-12h-7l2-8z', drive);
    this.gasButton = labeledButton('gas', 'GAS', 'M12 3l8 11h-5v7H9v-7H4l8-11z', drive);

    this.bindHold(this.gasButton, {
      down: () => {
        this.input.touch.throttle = 1;
      },
      up: () => {
        this.input.touch.throttle = this.autoGas ? 1 : 0;
      },
    });
    this.bindHold(brakeBtn, {
      down: () => {
        const t = this.input.touch;
        t.brake = 1;
        // Auto-gas must yield to the brake or the kart never slows down.
        t.throttle = 0;
      },
      up: () => {
        const t = this.input.touch;
        t.brake = 0;
        t.throttle = this.autoGas ? 1 : 0;
      },
    });
    this.bindHold(itemBtn, {
      down: () => {
        const t = this.input.touch;
        t.useItemEdge = true;
        t.useItemHeld = true;
        buzz(15);
      },
      up: () => {
        this.input.touch.useItemHeld = false;
      },
    });
    this.bindHold(driftBtn, {
      down: () => {
        this.input.touch.drift = true;
        buzz(12);
      },
      up: () => {
        this.input.touch.drift = false;
      },
    });

    // The HUD item box is the same action: tapping a collected item should fire it.
    const onHudItem = (ev: PointerEvent): void => {
      if (!this.visible) return;
      const node = ev.target;
      if (!(node instanceof Element) || !node.closest('.item-frame')) return;
      ev.preventDefault();
      const t = this.input.touch;
      t.useItemEdge = true;
      t.useItemHeld = true;
      buzz(15);
    };
    const onHudItemUp = (ev: PointerEvent): void => {
      if (!this.visible) return;
      const node = ev.target;
      if (!(node instanceof Element) || !node.closest('.item-frame')) return;
      this.input.touch.useItemHeld = false;
    };
    parent.addEventListener('pointerdown', onHudItem);
    parent.addEventListener('pointerup', onHudItemUp);
    parent.addEventListener('pointercancel', onHudItemUp);
    this.cleanups.push(() => {
      parent.removeEventListener('pointerdown', onHudItem);
      parent.removeEventListener('pointerup', onHudItemUp);
      parent.removeEventListener('pointercancel', onHudItemUp);
    });

    // ------------------------------------------------------------- corner
    // Look-back is a driving control, so it sits on the steering side, just
    // above the pad where the left thumb can reach it without letting go.
    const aux = el('div', 'touch-aux', undefined, this.root);
    const corner = el('div', 'touch-corner', undefined, this.root);
    const lookBtn = el('div', 'touch-mini look', undefined, aux);
    lookBtn.setAttribute('aria-label', 'Look back');
    lookBtn.appendChild(svgIcon('M7 7l-5 5 5 5v-3h6.5a4.5 4.5 0 110 9H11v2h2.5a6.5 6.5 0 000-13H7V7z'));
    el('span', '', 'LOOK', lookBtn);
    this.bindHold(lookBtn, {
      down: () => {
        this.input.touch.lookBack = true;
      },
      up: () => {
        this.input.touch.lookBack = false;
      },
    });
    const pauseBtn = el('div', 'touch-mini pause', undefined, corner);
    pauseBtn.setAttribute('aria-label', 'Pause');
    pauseBtn.appendChild(svgIcon('M7 5h3v14H7V5zm7 0h3v14h-3V5z'));
    el('span', '', 'PAUSE', pauseBtn);
    this.bindHold(pauseBtn, {
      down: () => {
        this.input.touch.pauseEdge = true;
      },
      up: () => {
        /* pause is an edge; nothing to release */
      },
    });

    this.autoChip = el('div', 'touch-auto', '', corner);
    this.autoChip.setAttribute('role', 'button');
    this.bindHold(this.autoChip, {
      down: () => {
        this.setAutoGas(!this.autoGas);
        buzz(10);
      },
      up: () => {
        /* toggles on press */
      },
    });
    this.applyAutoGas();
  }

  /** Keep the pad above HUD nodes that are created later in a race. */
  bringToFront(): void {
    this.root.parentElement?.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    this.root.classList.toggle('hidden', !visible);
    if (visible) {
      // Auto-gas has to be armed the moment the controls appear, otherwise the
      // kart sits on the line waiting for a throttle press that never comes.
      this.input.touch.throttle = this.autoGas ? 1 : 0;
      this.bringToFront();
    } else {
      this.releaseAll();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAll();
    for (const off of this.cleanups) off();
    this.cleanups.length = 0;
    this.root.remove();
  }

  // ---------------------------------------------------------------------------

  private setAutoGas(on: boolean): void {
    this.autoGas = on;
    writeAutoGas(on);
    this.applyAutoGas();
    const t = this.input.touch;
    if (this.visible && t.brake === 0) t.throttle = on ? 1 : 0;
  }

  private applyAutoGas(): void {
    this.autoChip.textContent = this.autoGas ? 'AUTO GAS ON' : 'AUTO GAS OFF';
    this.autoChip.classList.toggle('on', this.autoGas);
    this.root.classList.toggle('auto-gas', this.autoGas);
    this.gasButton.classList.toggle('dim', this.autoGas);
    this.autoChip.setAttribute('aria-pressed', this.autoGas ? 'true' : 'false');
  }

  private releaseAll(): void {
    this.steerPointer = -1;
    this.arrowLeft.classList.remove('active');
    this.arrowRight.classList.remove('active');
    this.steerPad.classList.remove('steering');
    this.steerKnob.style.transform = 'translate(-50%, -50%)';
    this.steerFill.style.width = '0%';
    this.steerFill.style.left = '50%';
    for (const node of this.root.querySelectorAll('.active')) node.classList.remove('active');
    this.input.clearTouch();
  }

  /**
   * Analog steer: pointer x across the pad maps to -1..1. A dead band around
   * centre is the "hands off" rest, and the knob + fill show how far you're in.
   */
  private bindSteer(): void {
    const apply = (ev: PointerEvent): void => {
      const rect = this.steerPad.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / Math.max(1, rect.width);
      let steer = (x - 0.5) * 2.15;
      if (steer > 1) steer = 1;
      else if (steer < -1) steer = -1;
      if (Math.abs(steer) < 0.1) steer = 0;
      this.input.touch.steerTarget = steer;
      this.arrowLeft.classList.toggle('active', steer < -0.08);
      this.arrowRight.classList.toggle('active', steer > 0.08);
      this.steerPad.classList.toggle('steering', steer !== 0);
      const knobX = 50 + steer * 38;
      this.steerKnob.style.transform = `translate(${knobX - 50}%, -50%)`;
      if (steer === 0) {
        this.steerFill.style.width = '0%';
        this.steerFill.style.left = '50%';
      } else if (steer < 0) {
        const pct = Math.abs(steer) * 38;
        this.steerFill.style.left = `${50 - pct}%`;
        this.steerFill.style.width = `${pct}%`;
      } else {
        this.steerFill.style.left = '50%';
        this.steerFill.style.width = `${steer * 38}%`;
      }
    };

    const onDown = (ev: PointerEvent): void => {
      if (this.steerPointer >= 0) return;
      this.steerPointer = ev.pointerId;
      this.steerPad.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
      apply(ev);
    };
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== this.steerPointer) return;
      ev.preventDefault();
      apply(ev);
    };
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== this.steerPointer) return;
      this.steerPointer = -1;
      this.input.touch.steerTarget = 0;
      this.arrowLeft.classList.remove('active');
      this.arrowRight.classList.remove('active');
      this.steerPad.classList.remove('steering');
      this.steerKnob.style.transform = 'translate(-50%, -50%)';
      this.steerFill.style.width = '0%';
      this.steerFill.style.left = '50%';
    };

    this.steerPad.addEventListener('pointerdown', onDown);
    this.steerPad.addEventListener('pointermove', onMove);
    this.steerPad.addEventListener('pointerup', onUp);
    this.steerPad.addEventListener('pointercancel', onUp);
    this.cleanups.push(() => {
      this.steerPad.removeEventListener('pointerdown', onDown);
      this.steerPad.removeEventListener('pointermove', onMove);
      this.steerPad.removeEventListener('pointerup', onUp);
      this.steerPad.removeEventListener('pointercancel', onUp);
    });
  }

  /** Wires one button as a held control, with pointer capture so it never sticks. */
  private bindHold(node: HTMLElement, handlers: { down: () => void; up: () => void }): void {
    const onDown = (ev: PointerEvent): void => {
      ev.preventDefault();
      ev.stopPropagation();
      node.setPointerCapture?.(ev.pointerId);
      node.classList.add('active');
      handlers.down();
    };
    const onUp = (ev: PointerEvent): void => {
      if (node.hasPointerCapture?.(ev.pointerId)) node.releasePointerCapture(ev.pointerId);
      node.classList.remove('active');
      handlers.up();
    };
    node.addEventListener('pointerdown', onDown);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onUp);
    this.cleanups.push(() => {
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
    });
  }
}
