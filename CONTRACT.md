# Turbo Kart Rush — Architecture Contract

AAA-quality Mario Kart style arcade racer. Three.js + TypeScript + Vite. **100% procedural: no external
assets** (no image/audio/model files). Everything is generated in code (geometry, textures via
CanvasTexture/DataTexture, audio via Web Audio API synthesis).

This document is the contract between five parallel workstreams. `src/core/**` is **frozen**: read it,
implement against it, never edit it (you may *add* optional fields to interfaces only if unavoidable, and
you must then note it at the bottom of this file under "Contract additions").

## Ownership (each owner has exclusive write access to their folders)

| Workstream | Folders | Public exports (exact paths & names) |
|---|---|---|
| **A — Game core + UI** | `src/main.ts`, `src/style.css`, `src/game/**`, `src/ui/**` | `src/game/Game.ts` → `class Game`; `src/game/RaceManager.ts` → `class RaceManager`; `src/game/FollowCamera.ts` → `class FollowCamera`; `src/ui/HUD.ts` → `class HUD`; `src/ui/MainMenu.ts` → `class MainMenu`; `src/ui/ResultsScreen.ts` → `class ResultsScreen`; `src/ui/PauseMenu.ts` → `class PauseMenu`; `src/ui/Minimap.ts` → `class Minimap`; `src/ui/LoadingScreen.ts` → `class LoadingScreen` |
| **B — Kart physics, model, input, roster** | `src/kart/**` | `src/kart/Kart.ts` → `class Kart implements IKart` with `constructor(id: number, character: CharacterDef, isPlayer: boolean)`; `src/kart/InputManager.ts` → `class InputManager`; `src/kart/roster.ts` → `export const CHARACTERS: CharacterDef[]` (exactly 8) and `getCharacter(id: string): CharacterDef`; `src/kart/KartModel.ts` → `buildKartModel(character: CharacterDef): KartModelParts` |
| **C — Track system + environment** | `src/track/**` | `src/track/Track.ts` → `class Track implements ITrack` with `constructor(def: TrackDefinition)`; `src/track/tracks/index.ts` → `export const TRACKS: TrackDefinition[]` (exactly 4) and `getTrackDef(id: string): TrackDefinition` |
| **D — Items + AI** | `src/items/**`, `src/ai/**` | `src/items/ItemManager.ts` → `class ItemManager implements IItemManager` with `constructor(particles: IParticleSystem \| null)`; `src/ai/AIDriver.ts` → `class AIDriver implements IAIDriver` with `constructor(kart: IKart, difficulty: Difficulty, personalitySeed: number)`; `src/items/itemVisuals.ts` → `buildItemIcon(item: ItemType): HTMLCanvasElement` (64x64 icon for HUD roulette) |
| **E — Audio + FX** | `src/audio/**`, `src/fx/**` | `src/audio/AudioEngine.ts` → `class AudioEngine implements IAudioEngine` (no-arg constructor); `src/fx/ParticleSystem.ts` → `class ParticleSystem implements IParticleSystem` (no-arg constructor); `src/fx/PostFX.ts` → `class PostFX implements IPostFX` (no-arg constructor) |

All cross-module communication is via:
1. The interfaces in `src/core/types.ts`.
2. The typed event bus in `src/core/events.ts` (`events.emit / events.on`).
3. Constants in `src/core/constants.ts`, helpers in `src/core/math.ts`.

Never import another workstream's concrete class except from `Game.ts` (workstream A wires everything).

## World conventions

- Units are metres, +Y up, right-handed. Kart forward is its local **-Z** (Three.js convention:
  `object.getWorldDirection` gives -Z). **forward = `new Vector3(0,0,-1).applyQuaternion(quaternion)`**,
  and `KartState.heading` is the Y rotation used to build that quaternion
  (`quaternion.setFromEuler(new Euler(0, heading, 0))`, so forward = `(-sin(heading), 0, -cos(heading))`).
  Track `tangent` follows the driving direction; the grid faces along the tangent at t≈0.
- Track parameter `t` in `[0,1)` wraps; `t = 0` is the finish line. Karts drive in the +t direction.
- Track is a closed CatmullRom loop; the **road is flat across its width** and the centerline may have
  gentle elevation (hills, small jumps). `ITrack.query` returns the ground height for any XZ; karts snap
  to `groundY` when not airborne.
- Speeds: medium kart top speed ≈ `BASE_TOP_SPEED` = 22 m/s (light ≈ 20.5, heavy ≈ 23.5). Mushroom boost
  ≈ +55% for 1.5s; drift mini-turbo stage 1/2/3 ≈ 0.7s / 1.2s / 1.8s at +40%. Boost pads ≈ +45% for 1.3s.
- Time: `Game` runs a fixed-step accumulator (`FIXED_DT`) for `Kart.update`, `ItemManager.update`,
  `AIDriver.update`, `RaceManager.update`; render-rate calls for `updateVisuals`, camera, particles, audio, HUD.
- Kart count is `KART_COUNT` = 8, ids `0..7`; the player is always id `0`.
- `KartState.raceProgress = lap + trackT` (RaceManager keeps this monotonic and uses it for `place`).
- Kart-kart collisions are resolved inside `Kart.update(dt, track, others)` (sphere-sphere, weight-based).
- Wall collisions: if `|lateral| > wallHalfWidth` push back along `binormal`, damp lateral velocity,
  emit `kart:collision` with `otherId: null`.
- Off-road (`surface === 'offroad'`): top speed ×0.55 unless boosting/star. `'boost'` surface (boost pad)
  → `applyBoost(0.45, 1.3, 'pad')` (once per pad crossing). `'void'` → fall; below `VOID_Y` respawn at last
  checkpoint (RaceManager calls `kart.resetTo` and emits `kart:respawn`).

## Player/AI input flow

```
InputManager.update()  → InputState (player) → kart0.setInput()
AIDriver.update(...)   → InputState (ai)     → kartN.setInput()
Kart.update(dt, track, others)               → physics
if (input.useItem) itemManager.requestUse(kart, input.brake > 0.5 || input.lookBack)
```

`InputManager` (workstream B) handles keyboard + gamepad and produces **edge-triggered** booleans
(`useItem`, `pause`, `confirm`, `back`, `menuUp/Down/Left/Right`) that are true for exactly one call of
`update()`. Default keys: W/↑ throttle, S/↓ brake, A/D or ←/→ steer, Space or Shift = hop/drift,
E / Ctrl / Enter = item, Q = look back, Esc or P = pause; Enter/Space confirm, Esc back. Gamepad: RT
throttle, LT brake, left stick steer, A/RB drift, X/LB item, B back, Start pause.

## Game flow (workstream A)

`boot → title → characterSelect → trackSelect → loading → countdown → racing → finished → results → title`

- `Game` owns `WebGLRenderer` (antialias, `ACESFilmicToneMapping`, `SRGBColorSpace`, shadows PCFSoft),
  `Scene`, `PerspectiveCamera`, lights (from `track.def.environment`), resize handling, the fixed-step loop,
  and constructs: `InputManager`, `AudioEngine`, `ParticleSystem`, `PostFX`, `Track`, 8 × `Kart`,
  7 × `AIDriver`, `ItemManager`, `RaceManager`, `FollowCamera`, `HUD`, menus.
- `RaceManager` owns countdown (3-2-1-GO with `race:countdown` / `race:start`), checkpoint/lap logic,
  positions, finish detection, results, respawns, wrong-way detection, and after the player finishes it
  keeps simulating AI until all finish or 12s pass (auto-drive the player kart with an AIDriver).
- `FollowCamera`: chase cam behind kart (distance ~6.5, height ~2.6), FOV widens with speed/boost
  (70° → 82°), slight lag on yaw, drift lean, look-back flips 180°, shake on hits.
- `HUD` is DOM (absolute-positioned divs over the canvas) — place numeral, lap counter, item slot with
  roulette (uses `buildItemIcon` from workstream D), speedometer, race timer, minimap (canvas), countdown,
  "FINAL LAP" banner, wrong-way warning, position-change flash, finish banner.
- Menus are DOM too, styled premium (glassmorphism, animated gradients, big condensed display typography via
  CSS system fonts — no webfont downloads). Behind the title menu render a slowly orbiting 3D kart on a
  podium with bloom.

## Track (workstream C)

`new Track(def)` builds everything synchronously: centerline `CatmullRomCurve3(points, closed=true,
'centripetal')`, lookup table of ~2000 samples for `closestT`, road ribbon geometry (with UV along length),
striped curbs, painted start/finish line + checkered pattern, side barriers/walls (themed), terrain
(large `PlaneGeometry` displaced by `fbm2`, flattened near the road), sky dome (gradient shader),
themed decorations (trees, cacti, rocks, snowmen, palms, lava rocks, neon pylons — instanced),
grandstands + cheering crowd near the start, boost pads (glowing chevrons on `'boost'` surface),
item box rows (positions only — visuals are workstream D), start grid slots (4 rows × 2, staggered,
behind the finish line), checkpoints, minimap data. Four tracks: **Sunny Circuit** (grassland, easy),
**Dune Drift** (desert, medium), **Frostbite Falls** (snow, medium-hard, with a void section over ice),
**Neon Nexus** (neon night city, hard). Each 900–1400 m long with hills, at least one jump crest, hairpins,
sweeping S-bends and a long straight.

## Items (workstream D)

Item boxes: translucent rainbow-refracting rotating cubes with a "?" inside, bob + spin, burst on pickup,
respawn after `ITEM_BOX_RESPAWN_SECONDS`. Roulette: `ITEM_ROULETTE_SECONDS`, emit `item:rouletteTick`
~10 times, then `item:rouletteEnd`; probabilities weighted by `place` (leader → bananas/greens; last →
star/lightning/blue/golden). Items: banana (dropped behind / thrown forward with aimBack=false + throttle),
green shell (straight, bounces off walls up to 6 times), red shell (homes on next kart ahead via track t),
blue shell (flies to leader, explodes), mushroom / triple / golden (boost via `kart.applyBoost`), star
(`applyStar(8)`), lightning (`applyShrink(6)` + `applyHit('lightning')` on all non-star karts, emit
`item:lightning`), bob-omb (thrown, 2.5s fuse or contact, explosion radius 4 → `applyHit('explosion')`).
Triple items orbit the kart. Hitting a shell/banana with star destroys it. Items collide with karts using
`KART_RADIUS`. Emit particles via the `IParticleSystem` passed in the constructor (may be null).

## AI (workstream D)

Follow a racing line = centerline + personality lateral offset, look-ahead ~ speed × 0.9 s, steer with a
PD controller, drift on corners with curvature above threshold and release at stage 2–3, hop over small
things, avoid `getHazards()` by lateral dodge, steer toward `getActiveBoxPositions()` when no item,
use items sensibly (red/green when a kart is ahead within 40 m, banana when a kart is behind within 15 m,
mushroom on straights or to recover, star/lightning immediately-ish, blue shell when not first),
rubber-band: scale top speed ±8% based on distance to player (hard: less help). Recover from wrong-way /
being stuck (reverse for 0.8 s then turn).

## Audio (workstream E)

Web Audio API only. Engine: per-kart oscillator stack (saw + square + sub, lowpass, pitch from speed,
gain from throttle; positional via `PannerNode` for non-player karts, player kart louder/centred).
SFX: drift skid loop (filtered noise), mini-turbo charge tick + release whoosh, boost whoosh, hop, land
thud, wall bump, kart bump, item box pickup ding, roulette ticks, item use (throw), shell hit crash, banana
slip, explosion, star jingle loop (overrides music while player has star), lightning crack, lap bell,
final-lap fanfare, countdown beeps + GO, finish fanfare, UI move/select/back, crowd ambience near start.
Music: procedural chiptune-ish sequencer with chord progressions, bass, arps, drums (noise hats, synth kick)
for `menu` (chill), `race` (upbeat 150 bpm), `finalLap` (same but +10% tempo, +1 semitone),
`results` (fanfare then loop). Smooth crossfade between tracks.

## FX (workstream E)

`ParticleSystem`: GPU-friendly single `Points`/instanced quads pool (≥ 6000 particles) with per-particle
life, velocity, gravity, size over life, colour over life, additive + alpha blending groups. Continuous
emitters from kart state: drift sparks at rear wheels coloured by `driftStage` (blue/orange/purple),
boost flames from exhausts, tyre smoke while drifting, dust on off-road, star sparkle, shrink puff,
speed streaks. `emit()` presets per `ParticlePreset`.
`PostFX`: `EffectComposer` (`three/examples/jsm/postprocessing/*`) with `RenderPass`, selective-ish
`UnrealBloomPass` (strength ~0.5, threshold ~0.85), custom `ShaderPass` for speed lines + radial blur +
chromatic aberration + vignette + hit tint + flash, `OutputPass`. Must gracefully fall back to plain
`renderer.render` if disabled.

## Quality bar

- 60 fps on a 2020 laptop at 1080p: instancing for decorations, merged geometries, ≤ ~400 draw calls,
  shadow map 2048, single shadow-casting light, frustum culling on.
- No console errors, no TypeScript errors (`npm run typecheck` clean), `npm run build` clean.
- Everything disposable (`dispose()`) so returning to the menu and starting a new race doesn't leak.

## Contract additions

(None yet. If you must add an optional member to a core type, list it here with your workstream letter.)
