/**
 * FROZEN CONTRACT - typed global event bus.
 *
 * Subsystems communicate through these events instead of importing each other.
 * Emit with `events.emit('kart:boost', {...})`, subscribe with `events.on(...)`.
 * The payload types are the contract; do not change existing ones.
 */
import type * as THREE from 'three';
import type { BoostSource, GameState, ItemType, SurfaceType } from './types';

export interface GameEvents {
  // --- race flow ---------------------------------------------------------
  'race:countdown': { count: number }; // 3, 2, 1
  'race:start': { trackId: string };
  'race:lap': { kartId: number; lap: number; totalLaps: number; isPlayer: boolean; isFinalLap: boolean };
  'race:finish': { kartId: number; place: number; time: number; isPlayer: boolean };
  'race:allFinished': {};
  'race:positionChange': { kartId: number; from: number; to: number; isPlayer: boolean };
  'race:wrongWay': { kartId: number; wrongWay: boolean };

  // --- kart -------------------------------------------------------------
  'kart:driftStart': { kartId: number; direction: -1 | 1 };
  'kart:driftStage': { kartId: number; stage: 1 | 2 | 3 };
  'kart:driftEnd': { kartId: number; boostStage: 0 | 1 | 2 | 3 };
  'kart:boost': { kartId: number; strength: number; duration: number; source: BoostSource };
  'kart:hop': { kartId: number };
  'kart:land': { kartId: number; impact: number };
  /** otherId is null for wall hits. */
  'kart:collision': { kartId: number; otherId: number | null; impulse: number; position: THREE.Vector3 };
  'kart:spin': { kartId: number; cause: ItemType | 'collision' | 'explosion'; sourceKartId: number };
  'kart:squish': { kartId: number };
  'kart:starStart': { kartId: number };
  'kart:starEnd': { kartId: number };
  'kart:shrink': { kartId: number };
  'kart:unshrink': { kartId: number };
  'kart:surfaceChange': { kartId: number; from: SurfaceType; to: SurfaceType };
  'kart:respawn': { kartId: number; position: THREE.Vector3 };

  // --- items ------------------------------------------------------------
  'item:pickup': { kartId: number; position: THREE.Vector3; isPlayer: boolean };
  'item:rouletteTick': { kartId: number; isPlayer: boolean };
  'item:rouletteEnd': { kartId: number; item: ItemType; isPlayer: boolean };
  'item:use': { kartId: number; item: ItemType; position: THREE.Vector3; isPlayer: boolean };
  'item:hit': { kartId: number; item: ItemType; position: THREE.Vector3; sourceKartId: number; isPlayer: boolean };
  'item:destroyed': { item: ItemType; position: THREE.Vector3 };
  'item:shellBounce': { position: THREE.Vector3 };
  'item:explosion': { position: THREE.Vector3; radius: number };
  'item:lightning': { sourceKartId: number };
  'item:boxRespawn': { position: THREE.Vector3 };
  'item:blueShellLaunch': { targetKartId: number };

  // --- game / ui --------------------------------------------------------
  'game:stateChange': { from: GameState; to: GameState };
  'game:pause': {};
  'game:resume': {};
  'ui:move': {};
  'ui:select': {};
  'ui:back': {};
  'ui:error': {};
}

export type EventName = keyof GameEvents;
export type EventHandler<K extends EventName> = (payload: GameEvents[K]) => void;

class EventBus {
  private handlers = new Map<EventName, Set<(payload: unknown) => void>>();

  on<K extends EventName>(name: K, handler: EventHandler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (payload: unknown) => void);
    return () => this.off(name, handler);
  }

  once<K extends EventName>(name: K, handler: EventHandler<K>): () => void {
    const off = this.on(name, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends EventName>(name: K, handler: EventHandler<K>): void {
    this.handlers.get(name)?.delete(handler as (payload: unknown) => void);
  }

  emit<K extends EventName>(name: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of Array.from(set)) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[events] handler for ${name} threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** The single global event bus. */
export const events = new EventBus();
