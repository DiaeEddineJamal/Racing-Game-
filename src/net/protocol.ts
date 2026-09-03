/**
 * Wire format shared by the client and server/index.js.
 *
 * Keys are short because kart snapshots go out ~20 times a second per kart. The
 * shapes here are the whole contract: if you change one, change server/index.js
 * in the same commit.
 */

/** A player sitting in a room, before or during a race. */
export interface RoomPlayer {
  id: string;
  name: string;
  characterId: string;
  ready: boolean;
  /** Assigned when the race starts; -1 in the lobby. */
  kartId: number;
  host: boolean;
}

/** A CPU racer the host fills the grid with. */
export interface RoomCpu {
  kartId: number;
  characterId: string;
}

export interface RoomSettings {
  trackId: string;
  laps: number;
  difficulty: 'easy' | 'normal' | 'hard';
  /** How many CPU racers pad the grid out to a full field. */
  cpuCount: number;
}

export interface RoomState {
  code: string;
  hostId: string;
  players: RoomPlayer[];
  settings: RoomSettings;
  racing: boolean;
}

/** Sent to everyone when the host starts the race. */
export interface RaceBegin {
  settings: RoomSettings;
  players: RoomPlayer[];
  cpus: RoomCpu[];
  /** Shared seed so every client lays the grid out identically. */
  seed: number;
}

/**
 * One kart's state on the wire. Sent by whichever client simulates that kart:
 * every player sends their own, and the host also sends the CPU field.
 */
export interface KartSnapshot {
  /** Kart id (grid slot), not the socket id. */
  i: number;
  /** Position. */
  x: number;
  y: number;
  z: number;
  /** Heading in radians. */
  h: number;
  /** Forward speed, m/s. */
  s: number;
  /** Steering input, -1..1. */
  st: number;
  /** Throttle 0..1. */
  th: number;
  /** Brake 0..1. */
  br: number;
  /** Drift direction: -1, 0 or 1. */
  d: number;
  /** Drift stage 0..3. */
  dg: number;
  /** Lap number. */
  l: number;
  /** Race progress (laps + fraction), used for ordering. */
  p: number;
  /** Held item, as an index into ALL_ITEM_TYPES (-1 = none). */
  it: number;
  /** Remaining uses of the held item. */
  ic: number;
  /**
   * Status bits: 1 boosting, 2 spinning, 4 invincible, 8 shrunk, 16 squished,
   * 32 airborne, 64 finished, 128 item roulette spinning.
   */
  f: number;
}

export const STATUS_BOOST = 1;
export const STATUS_SPIN = 2;
export const STATUS_STAR = 4;
export const STATUS_SHRUNK = 8;
export const STATUS_SQUISH = 16;
export const STATUS_AIR = 32;
export const STATUS_FINISHED = 64;
export const STATUS_ROULETTE = 128;

/** One-off things that must reach every client exactly once. */
export type NetEvent =
  | { t: 'use'; i: number; item: number; back: boolean }
  | { t: 'kill'; owner: number; kind: number; x: number; z: number }
  | { t: 'lap'; i: number; lap: number }
  | { t: 'respawn'; i: number };

export interface FinishReport {
  kartId: number;
  /** Total race time in seconds; also what the leaderboard records. */
  time: number;
}

/** Server-arbitrated finishing order, broadcast as each racer crosses the line. */
export interface FinishOrder {
  kartId: number;
  place: number;
  time: number;
}

export interface LeaderboardRow {
  name: string;
  characterId: string;
  time: number;
  at: number;
}

/** Room codes are typed by humans, so the alphabet drops look-alike glyphs. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const MAX_PLAYERS = 8;
/**
 * Kart snapshots per second, per owning client. The server merges everything it
 * receives and relays the room at the same rate, so this is also roughly how
 * often a remote kart's authoritative pose refreshes.
 */
export const SNAPSHOT_HZ = 30;

/**
 * The host also simulates the CPU field. Those karts send every Nth tick: they
 * are never the kart a player is fighting for position, and halving their rate
 * is most of the host's upstream saved.
 */
export const CPU_SNAPSHOT_DIVISOR = 2;

/** How often the client re-measures round-trip time (seconds). */
export const PING_INTERVAL_SECONDS = 3;
