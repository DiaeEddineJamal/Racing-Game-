/**
 * Socket.IO wrapper for the lobby and the in-race relay.
 *
 * Nothing here knows about karts or rendering: it moves messages, tracks the
 * room, and hands raw payloads to whoever registered a callback. NetRace does
 * the game-side work.
 */
import { io, type Socket } from 'socket.io-client';
import { PING_INTERVAL_SECONDS } from './protocol';
import type {
  FinishOrder,
  FinishReport,
  KartSnapshot,
  LeaderboardRow,
  NetEvent,
  RaceBegin,
  RoomSettings,
  RoomState,
} from './protocol';

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error';

export class NetClient {
  private socket: Socket | null = null;
  private _room: RoomState | null = null;
  private _selfId = '';
  private _status: NetStatus = 'offline';
  private _pingMs = 0;
  private pingTimer = 0;

  onStatus: ((status: NetStatus, detail?: string) => void) | null = null;
  onRoom: ((room: RoomState | null) => void) | null = null;
  onBegin: ((begin: RaceBegin) => void) | null = null;
  onAbandon: (() => void) | null = null;
  onStates: ((snapshots: KartSnapshot[]) => void) | null = null;
  onEvent: ((event: NetEvent) => void) | null = null;
  onOrder: ((order: FinishOrder) => void) | null = null;

  get status(): NetStatus {
    return this._status;
  }

  /**
   * Smoothed round-trip time in milliseconds. NetRace extrapolates remote karts
   * by half of this, and the HUD shows it so players can see a bad line for
   * what it is instead of blaming the game.
   */
  get pingMs(): number {
    return this._pingMs;
  }

  get room(): RoomState | null {
    return this._room;
  }

  get selfId(): string {
    return this._selfId;
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** True when this client is the room host, and so also drives the CPU field. */
  get isHost(): boolean {
    return !!this._room && this._room.hostId === this._selfId;
  }

  /** Opens the socket if it is not open already. Safe to call repeatedly. */
  connect(): void {
    if (this.socket) {
      if (!this.socket.connected) this.socket.connect();
      return;
    }
    this.setStatus('connecting');
    // Same origin: the game server serves the client, so no URL is needed.
    const socket = io({ transports: ['websocket', 'polling'], reconnectionAttempts: 6, timeout: 8000 });
    this.socket = socket;

    socket.on('connect', () => {
      this._selfId = socket.id ?? '';
      this.setStatus('online');
    });
    socket.on('connect_error', (err: Error) => {
      // socket.io's own message here is transport jargon ("xhr poll error"),
      // which tells a player nothing. Keep it in the console and say what is
      // actually wrong - in dev, that is almost always a server that is not up.
      console.warn('[net] connect failed:', err.message);
      this.setStatus(
        'error',
        import.meta.env.DEV
          ? 'Could not reach the game server. Start it with `npm run server`, or restart `npm run dev`.'
          : 'Could not reach the game server. Check your connection and try again.',
      );
    });
    socket.on('disconnect', (reason: string) => {
      this._pingMs = 0;
      this._room = null;
      this.onRoom?.(null);
      this.setStatus('offline', reason);
    });
    socket.on('room:update', (room: RoomState) => {
      this._room = room;
      this.onRoom?.(room);
    });
    socket.on('race:begin', (begin: RaceBegin) => this.onBegin?.(begin));
    socket.on('race:abandon', () => this.onAbandon?.());
    socket.on('net:states', (snapshots: KartSnapshot[]) => this.onStates?.(snapshots));
    socket.on('net:event', (event: NetEvent) => this.onEvent?.(event));
    socket.on('race:order', (order: FinishOrder) => this.onOrder?.(order));
  }

  disconnect(): void {
    this._room = null;
    this.socket?.disconnect();
    this.socket = null;
    this.setStatus('offline');
  }

  // --- lobby ---------------------------------------------------------------

  createRoom(name: string, characterId: string): Promise<{ error?: string }> {
    return this.request('room:create', { name, characterId });
  }

  joinRoom(code: string, name: string, characterId: string): Promise<{ error?: string }> {
    return this.request('room:join', { code, name, characterId });
  }

  leaveRoom(): void {
    this.socket?.emit('room:leave');
    this._room = null;
    this.onRoom?.(null);
  }

  setCharacter(characterId: string): void {
    this.socket?.emit('room:setCharacter', { characterId });
  }

  setReady(ready: boolean): void {
    this.socket?.emit('room:setReady', { ready });
  }

  setSettings(settings: Partial<RoomSettings>): void {
    this.socket?.emit('room:setSettings', settings);
  }

  startRace(): void {
    this.socket?.emit('room:start');
  }

  abandonRace(): void {
    this.socket?.emit('room:abandon');
  }

  // --- in race -------------------------------------------------------------

  /**
   * Positions go out volatile: they are worthless once superseded, so a socket
   * that is momentarily backed up should drop this frame rather than deliver it
   * late behind a queue. Events (`sendEvent`) are the opposite and stay reliable.
   */
  sendStates(snapshots: KartSnapshot[]): void {
    if (snapshots.length > 0) this.socket?.volatile.emit('net:states', snapshots);
  }

  /** Call once per frame while online; re-measures RTT on its own schedule. */
  updatePing(dt: number): void {
    const socket = this.socket;
    if (!socket?.connected) {
      this.pingTimer = 0;
      return;
    }
    this.pingTimer -= dt;
    if (this.pingTimer > 0) return;
    this.pingTimer = PING_INTERVAL_SECONDS;
    const sent = performance.now();
    socket.emit('net:ping', 0, () => {
      const rtt = performance.now() - sent;
      // First sample lands as-is; later ones ease in, so one bad packet does not
      // yank the extrapolation window around.
      this._pingMs = this._pingMs === 0 ? rtt : this._pingMs + (rtt - this._pingMs) * 0.3;
    });
  }

  sendEvent(event: NetEvent): void {
    this.socket?.emit('net:event', event);
  }

  sendFinish(report: FinishReport): void {
    this.socket?.emit('race:finished', report);
  }

  leaderboard(trackId: string): Promise<LeaderboardRow[]> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve([]);
        return;
      }
      const timer = window.setTimeout(() => resolve([]), 4000);
      this.socket.emit('leaderboard:get', { trackId }, (res: { rows?: LeaderboardRow[] }) => {
        window.clearTimeout(timer);
        resolve(res?.rows ?? []);
      });
    });
  }

  // --- internals -----------------------------------------------------------

  private setStatus(status: NetStatus, detail?: string): void {
    if (status === this._status && !detail) return;
    this._status = status;
    this.onStatus?.(status, detail);
  }

  /** Emit with an ack, resolving to an error object rather than throwing. */
  private request(event: string, payload: unknown): Promise<{ error?: string }> {
    return new Promise((resolve) => {
      const socket = this.socket;
      if (!socket) {
        resolve({ error: 'Not connected to the game server.' });
        return;
      }
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ error: 'The game server did not answer.' });
      }, 8000);
      socket.emit(event, payload, (res: { error?: string; room?: RoomState; you?: string }) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (res?.room) {
          this._room = res.room;
          if (res.you) this._selfId = res.you;
          this.onRoom?.(res.room);
        }
        resolve(res ?? {});
      });
    });
  }
}
