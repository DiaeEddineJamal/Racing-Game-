/**
 * Main menu: Title → Character Select → Track Select. Pure DOM; the 3D backdrop
 * behind it is owned by Game (mirrored via onHighlight).
 */
import type { CharacterDef, Difficulty, InputState, RaceSettings, TrackDefinition } from '../core/types';
import { events } from '../core/events';
import { GAME_TITLE, DEFAULT_LAPS } from '../core/constants';
import { button, cssHex, cssRgba, el, TextField } from './dom';
import { trackPoster } from './trackPoster';

export type MenuPanel = 'title' | 'characterSelect' | 'trackSelect';

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];
const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'EASY', normal: 'NORMAL', hard: 'HARD' };
const DIFFICULTY_BLURB: Record<Difficulty, string> = {
  easy: 'Relaxed rivals, generous rubber-banding.',
  normal: 'The classic Grand Prix challenge.',
  hard: 'Ruthless AI, near-perfect lines, no mercy.',
};
const STAT_KEYS: readonly { key: keyof CharacterDef['stats']; label: string }[] = [
  { key: 'speed', label: 'SPD' },
  { key: 'acceleration', label: 'ACC' },
  { key: 'handling', label: 'HND' },
  { key: 'weight', label: 'WGT' },
  { key: 'miniTurbo', label: 'MT' },
];
/** Fallback when the grid has not been laid out yet (first frame, or hidden). */
const CHAR_COLUMNS = 4;

/** How many cards the grid is actually showing across right now. Media queries
 *  change this with the window, so up/down must ask rather than assume. */
function columnsOf(grid: HTMLElement | null, fallback: number): number {
  if (!grid) return fallback;
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter((c) => c !== 'none' && c !== '');
  return cols.length > 0 ? cols.length : fallback;
}
const MIN_LAPS = 1;
const MAX_LAPS = 9;

export class MainMenu {
  onStart: ((settings: RaceSettings) => void) | null = null;
  onPlayOnline: (() => void) | null = null;
  onHighlight: ((characterId: string) => void) | null = null;
  onPanelChange: ((panel: MenuPanel) => void) | null = null;

  private readonly rootNode: HTMLElement;
  private readonly panels: Record<MenuPanel, HTMLElement>;
  private panel: MenuPanel = 'title';
  private visible = false;

  // Character select
  private readonly charCards: HTMLElement[] = [];
  private charIndex = 0;
  private readonly charName: TextField;
  private readonly charTagline: TextField;

  // Track select
  private readonly trackCards: HTMLElement[] = [];
  private trackIndex = 0;
  private readonly diffButtons: HTMLElement[] = [];
  private difficultyIndex = 1;
  private readonly diffBlurb: TextField;
  /** User-chosen race length; persists across circuits until they change it. */
  private lapsCount = DEFAULT_LAPS;
  private readonly lapsWrap: HTMLElement;
  private readonly lapsLabel: TextField;
  private readonly startButton: HTMLElement;
  /** 0 = track cards row, 1 = difficulty row, 2 = laps row, 3 = start button. */
  private trackRow = 0;

  constructor(
    root: HTMLElement,
    private readonly characters: readonly CharacterDef[],
    private readonly tracks: readonly TrackDefinition[],
  ) {
    this.rootNode = el('div', 'screen menu hidden', undefined, root);
    this.lapsCount = tracks[0] && tracks[0].laps > 0 ? tracks[0].laps : DEFAULT_LAPS;

    // ---------------------------------------------------------------- title
    const title = el('section', 'panel-title-screen', undefined, this.rootNode);
    const logoWrap = el('div', 'logo', undefined, title);
    const words = GAME_TITLE.split(' ');
    words.forEach((w, i) => {
      const line = el('span', `logo-word logo-word-${i}`, undefined, logoWrap);
      line.dataset.text = w;
      line.textContent = w;
    });
    el('div', 'logo-sub', 'ARCADE GRAND PRIX', title);
    const modes = el('div', 'title-modes', undefined, title);
    const single = button('GRAND PRIX', 'primary', () => this.goTo('characterSelect', true));
    const online = button('PLAY ONLINE', '', () => {
      events.emit('ui:select', {});
      this.onPlayOnline?.();
    });
    modes.append(single, online);
    const prompt = el('div', 'press-start', undefined, title);
    el('span', 'press-start-text', 'ENTER FOR A GRAND PRIX · O TO RACE FRIENDS', prompt);
    const legend = el('div', 'controls-legend glass', undefined, title);
    const keys: [string, string][] = [
      ['W / ↑', 'Throttle'],
      ['S / ↓', 'Brake / Reverse'],
      ['A D / ← →', 'Steer'],
      ['SPACE / SHIFT', 'Hop · Drift'],
      ['E / CTRL', 'Use item (hold BRAKE to throw back)'],
      ['Q', 'Look back'],
      ['ESC / P', 'Pause'],
      ['M', 'Mute'],
    ];
    for (const [k, v] of keys) {
      const row = el('div', 'legend-row', undefined, legend);
      el('kbd', '', k, row);
      el('span', '', v, row);
    }
    el('div', 'version', 'v1.0 · Three.js · online multiplayer · gamepad supported', title);
    title.addEventListener('click', (ev) => {
      // The mode buttons stop propagation themselves; this is the "click anywhere" path.
      if (ev.defaultPrevented) return;
      if (this.panel === 'title') this.goTo('characterSelect', true);
    });

    // ------------------------------------------------------- character select
    const chars = el('section', 'panel-select panel-chars', undefined, this.rootNode);
    const charHead = el('header', 'select-header', undefined, chars);
    el('div', 'panel-kicker', 'STEP 1 / 2', charHead);
    el('h2', 'panel-title', 'CHOOSE YOUR RACER', charHead);
    const charGrid = el('div', 'card-grid char-grid', undefined, chars);
    characters.forEach((c, i) => {
      const card = this.buildCharacterCard(c);
      card.addEventListener('pointerenter', () => this.setCharacter(i));
      card.addEventListener('click', () => {
        if (this.charIndex === i) this.goTo('trackSelect', true);
        else this.setCharacter(i, true);
      });
      card.addEventListener('dblclick', () => this.goTo('trackSelect', true));
      charGrid.appendChild(card);
      this.charCards.push(card);
    });
    const charFoot = el('footer', 'select-footer glass', undefined, chars);
    const charInfo = el('div', 'select-info', undefined, charFoot);
    this.charName = new TextField(el('div', 'select-info-name', '', charInfo));
    this.charTagline = new TextField(el('div', 'select-info-tagline', '', charInfo));
    const charActions = el('div', 'actions', undefined, charFoot);
    charActions.appendChild(button('← BACK', 'ghost', () => this.goTo('title', true)));
    charActions.appendChild(button('CONTINUE →', 'primary', () => this.goTo('trackSelect', true)));

    // ----------------------------------------------------------- track select
    const tr = el('section', 'panel-select panel-tracks', undefined, this.rootNode);
    const trHead = el('header', 'select-header', undefined, tr);
    el('div', 'panel-kicker', 'STEP 2 / 2', trHead);
    el('h2', 'panel-title', 'PICK A CIRCUIT', trHead);
    const trackGrid = el('div', 'card-grid track-grid', undefined, tr);
    tracks.forEach((t, i) => {
      const card = this.buildTrackCard(t);
      card.addEventListener('pointerenter', () => {
        this.trackRow = 0;
        this.setTrack(i);
      });
      card.addEventListener('click', () => {
        if (this.trackIndex === i && this.trackRow === 0) this.start();
        else {
          this.trackRow = 0;
          this.setTrack(i, true);
        }
      });
      trackGrid.appendChild(card);
      this.trackCards.push(card);
    });
    const trFoot = el('footer', 'select-footer glass', undefined, tr);
    const rulesWrap = el('div', 'race-rules', undefined, trFoot);
    const diffWrap = el('div', 'difficulty', undefined, rulesWrap);
    el('div', 'difficulty-label', 'DIFFICULTY', diffWrap);
    const seg = el('div', 'segmented', undefined, diffWrap);
    DIFFICULTIES.forEach((d, i) => {
      const b = el('button', 'seg', DIFFICULTY_LABEL[d], seg);
      b.type = 'button';
      b.addEventListener('pointerenter', () => {
        this.trackRow = 1;
        this.refreshTrackFocus();
      });
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.trackRow = 1;
        this.setDifficulty(i, true);
      });
      this.diffButtons.push(b);
    });
    this.diffBlurb = new TextField(el('div', 'difficulty-blurb', '', diffWrap));

    // Laps: a race setting, not a per-track fixed value - it carries over
    // between circuits so picking a new track never quietly resets it.
    this.lapsWrap = el('div', 'difficulty laps-picker', undefined, rulesWrap);
    el('div', 'difficulty-label', 'LAPS', this.lapsWrap);
    const lapsRow = el('div', 'step-row', undefined, this.lapsWrap);
    lapsRow.appendChild(button('−', 'tiny', () => this.bumpLaps(-1)));
    this.lapsLabel = new TextField(el('b', 'step-value', String(this.lapsCount), lapsRow));
    lapsRow.appendChild(button('+', 'tiny', () => this.bumpLaps(1)));
    this.lapsWrap.addEventListener('pointerenter', () => {
      this.trackRow = 2;
      this.refreshTrackFocus();
    });

    const trActions = el('div', 'actions', undefined, trFoot);
    trActions.appendChild(button('← BACK', 'ghost', () => this.goTo('characterSelect', true)));
    this.startButton = button('START RACE', 'primary start', () => this.start());
    this.startButton.addEventListener('pointerenter', () => {
      this.trackRow = 3;
      this.refreshTrackFocus();
    });
    trActions.appendChild(this.startButton);

    this.panels = { title, characterSelect: chars, trackSelect: tr };
    this.setCharacter(0);
    this.setTrack(0);
    this.setDifficulty(1);
    this.applyPanel();
  }

  // ------------------------------------------------------------------ public

  get currentPanel(): MenuPanel {
    return this.panel;
  }

  get highlightedCharacter(): CharacterDef {
    return this.characters[this.charIndex];
  }

  show(panel: MenuPanel = 'title'): void {
    this.rootNode.classList.remove('hidden');
    this.visible = true;
    this.goTo(panel, false);
    this.onHighlight?.(this.highlightedCharacter.id);
  }

  hide(): void {
    this.rootNode.classList.add('hidden');
    this.visible = false;
  }

  dispose(): void {
    this.rootNode.remove();
  }

  /** Drive navigation from the InputState edges (keyboard / gamepad). */
  handleInput(input: InputState): void {
    if (!this.visible) return;
    switch (this.panel) {
      case 'title':
        if (input.confirm) this.goTo('characterSelect', true);
        break;
      case 'characterSelect': {
        const n = this.characters.length;
        const cols = columnsOf(this.charCards[0]?.parentElement ?? null, CHAR_COLUMNS);
        if (input.menuLeft) this.setCharacter((this.charIndex - 1 + n) % n, true);
        else if (input.menuRight) this.setCharacter((this.charIndex + 1) % n, true);
        else if (input.menuUp) this.setCharacter((this.charIndex - cols + n * cols) % n, true);
        else if (input.menuDown) this.setCharacter((this.charIndex + cols) % n, true);
        if (input.confirm) this.goTo('trackSelect', true);
        else if (input.back) this.goTo('title', true);
        break;
      }
      case 'trackSelect': {
        const rows = 4;
        if (input.menuUp) {
          this.trackRow = (this.trackRow + rows - 1) % rows;
          this.refreshTrackFocus();
          events.emit('ui:move', {});
        } else if (input.menuDown) {
          this.trackRow = (this.trackRow + 1) % rows;
          this.refreshTrackFocus();
          events.emit('ui:move', {});
        } else if (input.menuLeft || input.menuRight) {
          const dir = input.menuRight ? 1 : -1;
          if (this.trackRow === 0) {
            const n = this.tracks.length;
            this.setTrack((this.trackIndex + dir + n) % n, true);
          } else if (this.trackRow === 1) {
            this.setDifficulty((this.difficultyIndex + dir + 3) % 3, true);
          } else if (this.trackRow === 2) {
            this.bumpLaps(dir);
          } else {
            events.emit('ui:move', {});
          }
        }
        if (input.confirm) this.start();
        else if (input.back) this.goTo('characterSelect', true);
        break;
      }
    }
  }

  // ----------------------------------------------------------------- private

  private goTo(panel: MenuPanel, sound: boolean): void {
    if (sound) {
      const forward =
        (this.panel === 'title' && panel !== 'title') || (this.panel === 'characterSelect' && panel === 'trackSelect');
      events.emit(forward ? 'ui:select' : 'ui:back', {});
    }
    const changed = panel !== this.panel;
    this.panel = panel;
    this.applyPanel();
    if (changed) this.onPanelChange?.(panel);
  }

  private applyPanel(): void {
    for (const key of Object.keys(this.panels) as MenuPanel[]) {
      const node = this.panels[key];
      const active = key === this.panel;
      node.classList.toggle('active', active);
      if (active) {
        node.classList.remove('panel-in');
        void node.offsetWidth;
        node.classList.add('panel-in');
      }
    }
    if (this.panel === 'trackSelect') {
      this.trackRow = 0;
      this.refreshTrackFocus();
    }
  }

  private setCharacter(i: number, sound = false): void {
    if (i < 0 || i >= this.characters.length) return;
    const changed = i !== this.charIndex;
    this.charIndex = i;
    this.charCards.forEach((c, k) => {
      c.classList.toggle('selected', k === i);
      c.classList.toggle('focused', k === i);
    });
    const def = this.characters[i];
    this.charName.set(def.name.toUpperCase());
    this.charTagline.set(def.tagline);
    if (changed) {
      if (sound) events.emit('ui:move', {});
      // Keyboard/gamepad can move focus outside the scrolled viewport of a
      // grid that no longer fits on screen; a click never needs this (the
      // card was already visible to be clicked).
      if (sound) this.charCards[i]?.scrollIntoView({ block: 'nearest' });
      this.onHighlight?.(def.id);
    }
  }

  private setTrack(i: number, sound = false): void {
    if (i < 0 || i >= this.tracks.length) return;
    const changed = i !== this.trackIndex;
    this.trackIndex = i;
    this.trackCards.forEach((c, k) => c.classList.toggle('selected', k === i));
    this.refreshTrackFocus();
    if (changed && sound) {
      events.emit('ui:move', {});
      this.trackCards[i]?.scrollIntoView({ block: 'nearest' });
    }
  }

  private setDifficulty(i: number, sound = false): void {
    const changed = i !== this.difficultyIndex;
    this.difficultyIndex = i;
    this.diffButtons.forEach((b, k) => b.classList.toggle('selected', k === i));
    this.diffBlurb.set(DIFFICULTY_BLURB[DIFFICULTIES[i]]);
    this.refreshTrackFocus();
    if (changed && sound) events.emit('ui:move', {});
  }

  private refreshTrackFocus(): void {
    this.trackCards.forEach((c, k) => c.classList.toggle('focused', this.trackRow === 0 && k === this.trackIndex));
    this.diffButtons.forEach((b, k) =>
      b.classList.toggle('focused', this.trackRow === 1 && k === this.difficultyIndex),
    );
    this.lapsWrap.classList.toggle('focused', this.trackRow === 2);
    this.startButton.classList.toggle('focused', this.trackRow === 3);
  }

  private bumpLaps(delta: number): void {
    const next = Math.max(MIN_LAPS, Math.min(MAX_LAPS, this.lapsCount + delta));
    if (next === this.lapsCount) return;
    this.lapsCount = next;
    this.lapsLabel.set(String(next));
    events.emit('ui:move', {});
  }

  private start(): void {
    const track = this.tracks[this.trackIndex];
    const character = this.characters[this.charIndex];
    if (!track || !character) return;
    events.emit('ui:select', {});
    this.onStart?.({
      characterId: character.id,
      trackId: track.id,
      difficulty: DIFFICULTIES[this.difficultyIndex],
      laps: this.lapsCount,
    });
  }

  private buildCharacterCard(c: CharacterDef): HTMLElement {
    const card = el('div', 'card char-card glass');
    card.tabIndex = -1;
    card.style.setProperty('--card-accent', cssHex(c.color));
    card.style.setProperty('--card-accent-2', cssHex(c.accent));
    card.style.setProperty('--card-glow', cssRgba(c.color, 0.55));
    const swatch = el('div', 'char-swatch', undefined, card);
    swatch.style.background = `linear-gradient(145deg, ${cssHex(c.color)} 0%, ${cssHex(c.accent)} 100%)`;
    const helmet = el('div', 'char-helmet', undefined, swatch);
    helmet.style.background = `radial-gradient(circle at 35% 35%, #fff 0%, ${cssHex(c.driverColor)} 45%, ${cssHex(
      c.accent,
    )} 100%)`;
    el('div', 'char-wheel char-wheel-l', undefined, swatch);
    el('div', 'char-wheel char-wheel-r', undefined, swatch);
    el('div', 'card-name', c.name.toUpperCase(), card);
    el('div', 'card-tag', c.tagline, card);
    const pill = el('div', `pill weight-${c.weightClass}`, c.weightClass.toUpperCase(), card);
    pill.title = 'Weight class';
    const stats = el('div', 'stats', undefined, card);
    for (const s of STAT_KEYS) {
      const row = el('div', 'stat', undefined, stats);
      el('span', 'stat-label', s.label, row);
      const bar = el('div', 'stat-bar', undefined, row);
      const fill = el('div', 'stat-fill', undefined, bar);
      const v = Math.max(0, Math.min(1, c.stats[s.key]));
      fill.style.width = `${Math.round(v * 100)}%`;
    }
    return card;
  }

  private buildTrackCard(t: TrackDefinition): HTMLElement {
    const card = el('div', 'card track-card glass');
    card.tabIndex = -1;
    const env = t.environment;
    card.style.setProperty('--card-accent', cssHex(env.skyHorizon));
    card.style.setProperty('--card-glow', cssRgba(env.skyHorizon, 0.5));
    const art = el('div', 'track-art', undefined, card);
    art.style.background = cssHex(env.skyHorizon);
    // Painted scene for this circuit with its real centerline projected into it.
    art.appendChild(trackPoster(t, 520, 220));
    el('div', 'track-theme-pill pill', t.theme.toUpperCase(), art);
    const body = el('div', 'track-body', undefined, card);
    const nameRow = el('div', 'track-name-row', undefined, body);
    el('div', 'card-name', t.name.toUpperCase(), nameRow);
    const stars = el('div', 'stars', undefined, nameRow);
    for (let i = 0; i < 3; i++) el('span', i < t.difficulty ? 'star on' : 'star', '★', stars);
    el('div', 'card-tag', t.description, body);
    const meta = el('div', 'track-meta', undefined, body);
    el('span', 'pill', `${t.laps} LAPS`, meta);
    el('span', 'pill', `${['ROOKIE', 'PRO', 'EXPERT'][t.difficulty - 1] ?? 'PRO'}`, meta);
    return card;
  }
}
