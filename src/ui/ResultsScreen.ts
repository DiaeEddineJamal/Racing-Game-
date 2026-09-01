/**
 * Post-race standings table with staggered row animation, confetti for a podium
 * finish and Race Again / Change Track / Main Menu actions.
 */
import type { InputState, RaceStanding } from '../core/types';
import { events } from '../core/events';
import { formatRaceTime, ordinal } from '../core/math';
import { button, cssHex, el, FocusRing, TextField } from './dom';

const CONFETTI_COUNT = 56;
const CONFETTI_COLORS = ['#ffd23f', '#ff3ab8', '#37a8ff', '#7cff6b', '#ff7a2f', '#ffffff'];

export class ResultsScreen {
  onRaceAgain: (() => void) | null = null;
  onChangeTrack: (() => void) | null = null;
  onMainMenu: (() => void) | null = null;

  private readonly rootNode: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly heading: TextField;
  private readonly subheading: TextField;
  private readonly table: HTMLElement;
  private readonly confetti: HTMLElement;
  private readonly focus: FocusRing;
  private visible = false;

  constructor(root: HTMLElement) {
    this.rootNode = el('div', 'screen results hidden', undefined, root);
    this.confetti = el('div', 'confetti', undefined, this.rootNode);
    this.panel = el('div', 'glass panel results-panel', undefined, this.rootNode);
    el('div', 'panel-kicker', 'RACE COMPLETE', this.panel);
    this.heading = new TextField(el('h2', 'panel-title results-title', '', this.panel));
    this.subheading = new TextField(el('div', 'results-sub', '', this.panel));
    this.table = el('div', 'standings', undefined, this.panel);
    const actions = el('div', 'actions', undefined, this.panel);
    this.focus = new FocusRing((i) => this.activate(i));
    const again = button('RACE AGAIN', 'primary', () => this.activate(0));
    const change = button('CHANGE TRACK', '', () => this.activate(1));
    const menu = button('MAIN MENU', 'ghost', () => this.activate(2));
    actions.append(again, change, menu);
    this.focus.add(again);
    this.focus.add(change);
    this.focus.add(menu);
  }

  show(standings: readonly RaceStanding[]): void {
    this.table.replaceChildren();
    this.confetti.replaceChildren();
    const player = standings.find((s) => s.isPlayer);
    const place = player ? player.place : standings.length;
    const winnerTime = standings.length > 0 ? standings[0].finishTime : 0;

    this.heading.set(place === 1 ? 'VICTORY!' : `${ordinal(place).toUpperCase()} PLACE`);
    this.subheading.set(
      place === 1
        ? 'Untouchable. The crowd goes wild.'
        : place <= 3
          ? 'Podium finish. Champagne is on ice.'
          : place <= 5
            ? 'Solid run. The podium is within reach.'
            : 'Rough race. Time for revenge.',
    );
    this.panel.classList.toggle('gold', place === 1);

    standings.forEach((s, i) => {
      const row = el('div', 'standing-row', undefined, this.table);
      row.style.animationDelay = `${0.12 + i * 0.09}s`;
      if (s.isPlayer) row.classList.add('you');
      if (s.place <= 3) row.classList.add(`podium-${s.place}`);
      el('span', 'standing-place', ordinal(s.place), row);
      const chip = el('span', 'standing-chip', undefined, row);
      chip.style.background = cssHex(s.color);
      el('span', 'standing-name', s.name + (s.isPlayer ? '  (YOU)' : ''), row);
      const t = s.finishTime;
      const label =
        !isFinite(t) || t <= 0
          ? 'DNF'
          : i === 0
            ? formatRaceTime(t)
            : `+${(t - winnerTime).toFixed(3)}`;
      el('span', 'standing-time', label, row);
    });

    if (place <= 3) this.spawnConfetti();

    this.focus.set(0);
    this.rootNode.classList.remove('hidden');
    this.panel.classList.remove('panel-in');
    void this.panel.offsetWidth;
    this.panel.classList.add('panel-in');
    this.visible = true;
  }

  hide(): void {
    this.rootNode.classList.add('hidden');
    this.confetti.replaceChildren();
    this.visible = false;
  }

  handleInput(input: InputState): void {
    if (!this.visible) return;
    if (input.menuLeft || input.menuUp) {
      if (this.focus.move(-1)) events.emit('ui:move', {});
    } else if (input.menuRight || input.menuDown) {
      if (this.focus.move(1)) events.emit('ui:move', {});
    }
    if (input.confirm) this.focus.activate();
    else if (input.back) this.activate(2);
  }

  dispose(): void {
    this.rootNode.remove();
  }

  private activate(i: number): void {
    events.emit(i === 2 ? 'ui:back' : 'ui:select', {});
    if (i === 0) this.onRaceAgain?.();
    else if (i === 1) this.onChangeTrack?.();
    else this.onMainMenu?.();
  }

  private spawnConfetti(): void {
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const piece = el('span', 'confetti-piece', undefined, this.confetti);
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      piece.style.animationDelay = `${Math.random() * 2.5}s`;
      piece.style.animationDuration = `${3 + Math.random() * 2.5}s`;
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      piece.style.width = `${6 + Math.random() * 8}px`;
      piece.style.height = `${10 + Math.random() * 10}px`;
    }
  }
}
