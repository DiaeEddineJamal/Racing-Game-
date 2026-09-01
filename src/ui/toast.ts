/**
 * Non-blocking toast notifications (errors, hints). Lives at the very top of
 * the DOM so it works even before the game has created its UI layer.
 */
import { el } from './dom';

let host: HTMLElement | null = null;

function getHost(): HTMLElement {
  if (host && host.isConnected) return host;
  host = el('div', 'toast-host');
  document.body.appendChild(host);
  return host;
}

export function showToast(message: string, kind: 'info' | 'error' = 'info', durationMs = 4500): void {
  const h = getHost();
  // Keep the stack short so a flood of errors doesn't cover the screen.
  while (h.childElementCount >= 4 && h.firstElementChild) h.removeChild(h.firstElementChild);
  const t = el('div', `toast toast-${kind}`, message, h);
  requestAnimationFrame(() => t.classList.add('toast-in'));
  window.setTimeout(() => {
    t.classList.remove('toast-in');
    t.classList.add('toast-out');
    window.setTimeout(() => t.remove(), 400);
  }, durationMs);
}
