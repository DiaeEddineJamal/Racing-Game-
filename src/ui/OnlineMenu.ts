/**
 * Online lobby UI: pick a name, create or join a room by code, choose a racer,
 * and - if you are the host - pick the circuit, lap count and CPU field, then
 * start. Also shows the server leaderboard for the selected circuit.
 *
 * This owns two panels ('connect' and 'lobby'); MainMenu keeps the offline ones.
 */
import type { CharacterDef, Difficulty, GridEntry, OnlineSetup, TrackDefinition } from '../core/types';
import type { NetClient } from '../net/NetClient';
import type { RoomState } from '../net/protocol';
import { events } from '../core/events';
import { formatRaceTime } from '../core/math';
import { button, cssHex, el, TextField } from './dom';
import { showToast } from './toast';

const NAME_KEY = 'lmongolyan-kart:name';
const MAX_NAME = 16;
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];
const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'EASY', normal: 'NORMAL', hard: 'HARD' };

export type OnlinePanel = 'connect' | 'lobby';

export class OnlineMenu {
  /** Called when the server says the race is starting. */
  onStart: ((setup: OnlineSetup, trackId: string, laps: number, difficulty: 'easy' | 'normal' | 'hard') => void) | null =
    null;
  /** Called when the player backs out of online play entirely. */
  onExit: (() => void) | null = null;
  /** Mirrors the highlighted racer to the 3D showroom behind the menu. */
  onHighlight: ((characterId: string) => void) | null = null;

  private readonly rootNode: HTMLElement;
  private readonly panels: Record<OnlinePanel, HTMLElement>;
  private panel: OnlinePanel = 'connect';
  private visible = false;

  // connect panel
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly statusLine: TextField;

  // lobby panel
  private readonly codeLabel: TextField;
  private readonly playerList: HTMLElement;
  private readonly racerStrip: HTMLElement;
  private readonly trackStrip: HTMLElement;
  private readonly hostControls: HTMLElement;
  private readonly lapsLabel: TextField;
  private readonly cpuLabel: TextField;
  private readonly diffButtons: HTMLButtonElement[] = [];
  private readonly readyButton: HTMLButtonElement;
  private readonly startButton: HTMLButtonElement;
  private readonly boardBody: HTMLElement;
  private readonly hintLine: TextField;

  private characterId: string;
  private lastBoardTrack = '';

  constructor(
    root: HTMLElement,
    private readonly net: NetClient,
    private readonly characters: readonly CharacterDef[],
    private readonly tracks: readonly TrackDefinition[],
  ) {
    this.characterId = characters[0]?.id ?? 'diae';
    this.rootNode = el('div', 'screen menu online-menu hidden', undefined, root);

    // ------------------------------------------------------------- connect
    const connect = el('section', 'panel-select panel-online', undefined, this.rootNode);
    const head = el('header', 'select-header', undefined, connect);
    el('div', 'panel-kicker', 'MULTIPLAYER', head);
    el('h2', 'panel-title', 'RACE YOUR FRIENDS', head);

    const box = el('div', 'glass online-box', undefined, connect);
    const nameRow = el('div', 'field-row', undefined, box);
    el('label', 'field-label', 'YOUR NAME', nameRow);
    this.nameInput = el('input', 'field-input', undefined, nameRow);
    this.nameInput.type = 'text';
    this.nameInput.maxLength = MAX_NAME;
    this.nameInput.placeholder = 'Racer';
    this.nameInput.value = readStoredName();
    this.nameInput.addEventListener('change', () => storeName(this.nameInput.value));

    const actions = el('div', 'online-actions', undefined, box);
    actions.appendChild(button('CREATE ROOM', 'primary', () => void this.create()));

    const joinRow = el('div', 'field-row join-row', undefined, box);
    el('label', 'field-label', 'ROOM CODE', joinRow);
    this.codeInput = el('input', 'field-input code-input', undefined, joinRow);
    this.codeInput.type = 'text';
    this.codeInput.maxLength = 4;
    this.codeInput.placeholder = 'ABCD';
    this.codeInput.autocapitalize = 'characters';
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    this.codeInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void this.join();
    });
    joinRow.appendChild(button('JOIN', '', () => void this.join()));

    this.statusLine = new TextField(el('div', 'online-status', '', box));
    const connectActions = el('div', 'actions', undefined, connect);
    connectActions.appendChild(button('← BACK', 'ghost', () => this.exit()));

    // --------------------------------------------------------------- lobby
    const lobby = el('section', 'panel-select panel-lobby', undefined, this.rootNode);
    const lobbyHead = el('header', 'select-header', undefined, lobby);
    el('div', 'panel-kicker', 'ROOM', lobbyHead);
    this.codeLabel = new TextField(el('h2', 'panel-title lobby-code', '----', lobbyHead));

    const cols = el('div', 'lobby-cols', undefined, lobby);

    const left = el('div', 'glass lobby-col', undefined, cols);
    el('div', 'lobby-col-title', 'ON THE GRID', left);
    this.playerList = el('div', 'player-list', undefined, left);

    const mid = el('div', 'glass lobby-col', undefined, cols);
    el('div', 'lobby-col-title', 'YOUR RACER', mid);
    this.racerStrip = el('div', 'chip-strip', undefined, mid);
    for (const c of characters) {
      const chip = el('button', 'chip', c.name, this.racerStrip);
      chip.type = 'button';
      chip.dataset.id = c.id;
      chip.style.setProperty('--chip-accent', cssHex(c.color));
      chip.addEventListener('click', () => this.pickCharacter(c.id));
    }
    this.hostControls = el('div', 'host-controls', undefined, mid);
    el('div', 'lobby-col-title', 'CIRCUIT', this.hostControls);
    this.trackStrip = el('div', 'chip-strip', undefined, this.hostControls);
    for (const t of tracks) {
      const chip = el('button', 'chip', t.name, this.trackStrip);
      chip.type = 'button';
      chip.dataset.id = t.id;
      chip.style.setProperty('--chip-accent', cssHex(t.environment.skyHorizon));
      chip.addEventListener('click', () => this.net.setSettings({ trackId: t.id }));
    }
    el('div', 'lobby-col-title', 'RULES', this.hostControls);
    const diffSeg = el('div', 'segmented online-diff', undefined, this.hostControls);
    DIFFICULTIES.forEach((d) => {
      const b = el('button', 'seg', DIFFICULTY_LABEL[d], diffSeg);
      b.type = 'button';
      b.addEventListener('click', () => this.net.setSettings({ difficulty: d }));
      this.diffButtons.push(b);
    });
    const stepRow = el('div', 'step-rows', undefined, this.hostControls);
    const laps = el('div', 'step-row', undefined, stepRow);
    el('span', 'field-label', 'LAPS', laps);
    laps.appendChild(button('−', 'tiny', () => this.bumpLaps(-1)));
    this.lapsLabel = new TextField(el('b', 'step-value', '3', laps));
    laps.appendChild(button('+', 'tiny', () => this.bumpLaps(1)));
    const cpus = el('div', 'step-row', undefined, stepRow);
    el('span', 'field-label', 'CPU RACERS', cpus);
    cpus.appendChild(button('−', 'tiny', () => this.bumpCpus(-1)));
    this.cpuLabel = new TextField(el('b', 'step-value', '7', cpus));
    cpus.appendChild(button('+', 'tiny', () => this.bumpCpus(1)));

    const right = el('div', 'glass lobby-col', undefined, cols);
    el('div', 'lobby-col-title', 'BEST TIMES', right);
    this.boardBody = el('div', 'board', undefined, right);

    const lobbyFoot = el('footer', 'select-footer glass', undefined, lobby);
    this.hintLine = new TextField(el('div', 'select-info-tagline', '', lobbyFoot));
    const lobbyActions = el('div', 'actions', undefined, lobbyFoot);
    lobbyActions.appendChild(button('LEAVE', 'ghost', () => this.leave()));
    this.readyButton = button('READY', '', () => this.toggleReady());
    lobbyActions.appendChild(this.readyButton);
    this.startButton = button('START RACE', 'primary start', () => this.net.startRace());
    lobbyActions.appendChild(this.startButton);

    this.panels = { connect, lobby };

    // ------------------------------------------------------------ net wiring
    this.net.onStatus = (status, detail) => {
      if (status === 'connecting') this.statusLine.set('Connecting to the game server…');
      else if (status === 'online') this.statusLine.set('Connected. Create a room or join one with a code.');
      else if (status === 'error') this.statusLine.set(detail ?? 'Could not reach the game server.');
      else this.statusLine.set('Disconnected from the game server.');
    };
    this.net.onRoom = (room) => this.renderRoom(room);
    this.net.onBegin = (begin) => {
      const grid: GridEntry[] = [];
      for (const p of begin.players) {
        grid.push({ kartId: p.kartId, characterId: p.characterId, name: p.name, human: true });
      }
      for (const c of begin.cpus) {
        const def = this.characters.find((x) => x.id === c.characterId) ?? this.characters[0];
        grid.push({ kartId: c.kartId, characterId: def.id, name: def.name, human: false });
      }
      grid.sort((a, b) => a.kartId - b.kartId);
      const me = begin.players.find((p) => p.id === this.net.selfId);
      if (!me) {
        showToast('The race started without you. Back to the lobby.', 'error');
        return;
      }
      const setup: OnlineSetup = {
        localKartId: me.kartId,
        grid,
        host: this.net.isHost,
        seed: begin.seed,
      };
      this.hide();
      this.onStart?.(setup, begin.settings.trackId, begin.settings.laps, begin.settings.difficulty);
    };
    this.net.onAbandon = () => {
      showToast('The host ended the race.', 'info');
      this.show('lobby');
    };

    this.renderRoom(null);
  }

  // ------------------------------------------------------------------ public

  get currentPanel(): OnlinePanel {
    return this.panel;
  }

  /** The racer this player has selected, so the showroom can mirror it. */
  get highlightedCharacterId(): string {
    return this.characterId;
  }

  show(panel: OnlinePanel = 'connect'): void {
    this.rootNode.classList.remove('hidden');
    this.visible = true;
    this.net.connect();
    this.setPanel(this.net.room ? 'lobby' : panel);
    this.onHighlight?.(this.characterId);
  }

  hide(): void {
    this.rootNode.classList.add('hidden');
    this.visible = false;
  }

  /** Esc backs out one level; everything else is pointer / text driven. */
  handleBack(): boolean {
    if (!this.visible) return false;
    if (this.panel === 'lobby') this.leave();
    else this.exit();
    return true;
  }

  dispose(): void {
    this.rootNode.remove();
  }

  // ----------------------------------------------------------------- private

  private setPanel(panel: OnlinePanel): void {
    this.panel = panel;
    for (const key of Object.keys(this.panels) as OnlinePanel[]) {
      const node = this.panels[key];
      const active = key === panel;
      node.classList.toggle('active', active);
      if (active) {
        node.classList.remove('panel-in');
        void node.offsetWidth;
        node.classList.add('panel-in');
      }
    }
  }

  private playerName(): string {
    const name = this.nameInput.value.trim().slice(0, MAX_NAME);
    return name || 'Racer';
  }

  private async create(): Promise<void> {
    events.emit('ui:select', {});
    storeName(this.nameInput.value);
    this.statusLine.set('Creating a room…');
    const res = await this.net.createRoom(this.playerName(), this.characterId);
    if (res.error) {
      this.statusLine.set(res.error);
      showToast(res.error, 'error');
      return;
    }
    // Leave the connect panel truthful for whenever the player comes back to it.
    this.statusLine.set('Connected. Create a room or join one with a code.');
    this.setPanel('lobby');
  }

  private async join(): Promise<void> {
    const code = this.codeInput.value.trim().toUpperCase();
    if (code.length < 4) {
      this.statusLine.set('A room code is four characters.');
      return;
    }
    events.emit('ui:select', {});
    storeName(this.nameInput.value);
    this.statusLine.set(`Joining ${code}…`);
    const res = await this.net.joinRoom(code, this.playerName(), this.characterId);
    if (res.error) {
      this.statusLine.set(res.error);
      showToast(res.error, 'error');
      return;
    }
    this.statusLine.set('Connected. Create a room or join one with a code.');
    this.setPanel('lobby');
  }

  private leave(): void {
    events.emit('ui:back', {});
    this.net.leaveRoom();
    this.setPanel('connect');
    this.statusLine.set('Left the room.');
  }

  private exit(): void {
    events.emit('ui:back', {});
    this.net.leaveRoom();
    this.net.disconnect();
    this.hide();
    this.onExit?.();
  }

  private pickCharacter(id: string): void {
    if (id === this.characterId) return;
    this.characterId = id;
    events.emit('ui:move', {});
    this.net.setCharacter(id);
    this.onHighlight?.(id);
    this.renderRoom(this.net.room);
  }

  private toggleReady(): void {
    const me = this.net.room?.players.find((p) => p.id === this.net.selfId);
    this.net.setReady(!me?.ready);
    events.emit('ui:move', {});
  }

  private bumpLaps(delta: number): void {
    const room = this.net.room;
    if (!room) return;
    this.net.setSettings({ laps: Math.max(1, Math.min(7, room.settings.laps + delta)) });
  }

  private bumpCpus(delta: number): void {
    const room = this.net.room;
    if (!room) return;
    const max = Math.max(0, 8 - room.players.length);
    this.net.setSettings({ cpuCount: Math.max(0, Math.min(max, room.settings.cpuCount + delta)) });
  }

  private renderRoom(room: RoomState | null): void {
    const host = !!room && room.hostId === this.net.selfId;
    this.hostControls.classList.toggle('hidden', !host);
    this.startButton.classList.toggle('hidden', !host);
    this.readyButton.classList.toggle('hidden', host);

    if (!room) {
      this.codeLabel.set('----');
      this.playerList.replaceChildren();
      this.hintLine.set('');
      return;
    }
    this.codeLabel.set(room.code);
    this.lapsLabel.set(String(room.settings.laps));
    this.cpuLabel.set(String(room.settings.cpuCount));
    this.diffButtons.forEach((b, i) => b.classList.toggle('selected', DIFFICULTIES[i] === room.settings.difficulty));

    // Keep our own selection in step with what the server has for us.
    const me = room.players.find((p) => p.id === this.net.selfId);
    if (me && me.characterId !== this.characterId) {
      this.characterId = me.characterId;
      this.onHighlight?.(this.characterId);
    }
    for (const chip of this.racerStrip.children) {
      const el2 = chip as HTMLElement;
      const id = el2.dataset.id ?? '';
      el2.classList.toggle('on', id === this.characterId);
      // Two players cannot bring the same racer.
      const takenBySomeoneElse = room.players.some((p) => p.id !== this.net.selfId && p.characterId === id);
      el2.classList.toggle('taken', takenBySomeoneElse);
      (el2 as HTMLButtonElement).disabled = takenBySomeoneElse;
    }
    for (const chip of this.trackStrip.children) {
      (chip as HTMLElement).classList.toggle('on', (chip as HTMLElement).dataset.id === room.settings.trackId);
    }

    this.playerList.replaceChildren();
    for (const p of room.players) {
      const row = el('div', 'player-row', undefined, this.playerList);
      const def = this.characters.find((c) => c.id === p.characterId);
      const dot = el('i', 'player-dot', undefined, row);
      dot.style.background = cssHex(def?.color ?? 0x888888);
      el('span', 'player-name', p.name, row);
      el('span', 'player-char', def?.name ?? p.characterId, row);
      el('span', `player-flag${p.host ? ' host' : p.ready ? ' ready' : ''}`, p.host ? 'HOST' : p.ready ? 'READY' : 'WAITING', row);
    }

    const notReady = room.players.filter((p) => !p.ready && p.id !== room.hostId).length;
    this.readyButton.textContent = me?.ready ? 'NOT READY' : 'READY';
    this.hintLine.set(
      host
        ? notReady > 0
          ? `Waiting on ${notReady} racer${notReady === 1 ? '' : 's'}. You can start anyway.`
          : 'Everyone is ready. Share the code and start when you like.'
        : 'The host picks the circuit. Mark yourself ready when you are set.',
    );

    if (room.settings.trackId !== this.lastBoardTrack) {
      this.lastBoardTrack = room.settings.trackId;
      void this.loadBoard(room.settings.trackId);
    }
  }

  private async loadBoard(trackId: string): Promise<void> {
    const rows = await this.net.leaderboard(trackId);
    if (this.lastBoardTrack !== trackId) return;
    this.boardBody.replaceChildren();
    const track = this.tracks.find((t) => t.id === trackId);
    el('div', 'board-title', track?.name ?? trackId, this.boardBody);
    if (rows.length === 0) {
      el('div', 'board-empty', 'No times recorded yet. Set the first one.', this.boardBody);
      return;
    }
    rows.forEach((row, i) => {
      const line = el('div', 'board-row', undefined, this.boardBody);
      el('span', 'board-rank', String(i + 1), line);
      el('span', 'board-name', row.name, line);
      el('span', 'board-time', formatRaceTime(row.time), line);
    });
  }
}

function readStoredName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.trim().slice(0, MAX_NAME));
  } catch {
    // Private browsing: the name just will not be remembered.
  }
}
