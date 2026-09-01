/**
 * Pause overlay: Resume / Restart / Quit to menu over a blurred backdrop.
 */
import type { InputState } from '../core/types';
import { events } from '../core/events';
import { button, el, FocusRing } from './dom';

export class PauseMenu {
  onResume: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onQuit: (() => void) | null = null;

  private readonly rootNode: HTMLElement;
  private readonly focus: FocusRing;
  private visible = false;

  constructor(root: HTMLElement) {
    this.rootNode = el('div', 'screen pause hidden', undefined, root);
    const panel = el('div', 'glass panel pause-panel', undefined, this.rootNode);
    el('div', 'panel-kicker', 'RACE PAUSED', panel);
    el('h2', 'panel-title', 'PAUSED', panel);
    const actions = el('div', 'actions column', undefined, panel);

    this.focus = new FocusRing((i) => this.activate(i));
    const resume = button('RESUME', 'primary', () => this.activate(0));
    const restart = button('RESTART RACE', '', () => this.activate(1));
    const quit = button('QUIT TO MENU', 'danger', () => this.activate(2));
    actions.append(resume, restart, quit);
    this.focus.add(resume);
    this.focus.add(restart);
    this.focus.add(quit);

    el('div', 'panel-hint', 'ESC / P  resume   ·   ↑↓  navigate   ·   ENTER  select', panel);
  }

  show(): void {
    this.focus.set(0);
    this.rootNode.classList.remove('hidden');
    this.visible = true;
  }

  hide(): void {
    this.rootNode.classList.add('hidden');
    this.visible = false;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  handleInput(input: InputState): void {
    if (!this.visible) return;
    if (input.menuUp || input.menuLeft) {
      if (this.focus.move(-1)) events.emit('ui:move', {});
    } else if (input.menuDown || input.menuRight) {
      if (this.focus.move(1)) events.emit('ui:move', {});
    }
    if (input.confirm) {
      this.focus.activate();
    } else if (input.back) {
      events.emit('ui:back', {});
      this.onResume?.();
    }
  }

  private activate(i: number): void {
    events.emit('ui:select', {});
    if (i === 0) this.onResume?.();
    else if (i === 1) this.onRestart?.();
    else this.onQuit?.();
  }

  dispose(): void {
    this.rootNode.remove();
  }
}
