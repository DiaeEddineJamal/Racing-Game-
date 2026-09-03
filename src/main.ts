/**
 * Bootstrap: WebGL2 detection, global error handling, then hand over to Game.
 */
import { GAME_TITLE } from './core/constants';
import { Game } from './game/Game';
import { el } from './ui/dom';
import { showToast } from './ui/toast';
import { TRACKS } from './track/tracks';
import { validateAllTracks } from './track/tracks/validate';

function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    return gl instanceof WebGL2RenderingContext;
  } catch {
    return false;
  }
}

function showFatal(root: HTMLElement, title: string, body: string): void {
  root.replaceChildren();
  const wrap = el('div', 'fatal', undefined, root);
  const panel = el('div', 'glass panel fatal-panel', undefined, wrap);
  el('div', 'panel-kicker', GAME_TITLE, panel);
  el('h2', 'panel-title', title, panel);
  el('p', 'fatal-body', body, panel);
  const retry = el('button', 'btn primary', 'RELOAD', panel);
  retry.type = 'button';
  retry.addEventListener('click', () => window.location.reload());
}

function boot(): void {
  if (import.meta.env.DEV) validateAllTracks(TRACKS);

  const app = document.getElementById('app') ?? el('div', '', undefined, document.body);
  app.id = 'app';

  if (!hasWebGL2()) {
    showFatal(
      app,
      'WEBGL2 REQUIRED',
      'Lmongolyan Kart needs a browser with WebGL 2 and hardware acceleration enabled. ' +
        'Try the latest Chrome, Edge, Firefox or Safari, and make sure GPU acceleration is switched on.',
    );
    return;
  }

  let errorToasts = 0;
  const report = (message: string, err: unknown): void => {
    console.error(message, err);
    if (errorToasts < 3) {
      errorToasts++;
      showToast(message, 'error');
    }
  };
  window.addEventListener('error', (ev) => {
    report(`Runtime error: ${ev.message || 'unknown'}`, ev.error);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason instanceof Error ? ev.reason.message : String(ev.reason);
    report(`Unhandled promise rejection: ${reason}`, ev.reason);
  });

  try {
    const game = new Game(app);
    game.start();
    (window as unknown as { __lmongolyanKart?: Game }).__lmongolyanKart = game;
  } catch (err) {
    console.error('[main] failed to start game', err);
    showFatal(
      app,
      'FAILED TO START',
      'Something went wrong while starting the game. Open the developer console for details, then reload.',
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
