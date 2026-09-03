/**
 * Illustrated poster art for the track-select cards.
 *
 * Each circuit gets a painted scene that matches where it is set - dunes and a
 * kasbah for Merzouga, sea and palms for Agadir, a lava field for Jbel - and the
 * real centerline of that circuit projected into it at a low angle, so the card
 * shows the actual shape of the loop rather than a generic squiggle.
 */
import * as THREE from 'three';
import type { TrackDefinition } from '../core/types';
import { seededRandom } from '../core/math';

const css = (hex: number): string => '#' + (hex >>> 0).toString(16).padStart(6, '0');

interface Scene {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  /** Y of the horizon line; the ground fills everything below it. */
  horizon: number;
  rng: () => number;
  def: TrackDefinition;
}

/** Draws the poster for one circuit into a fresh canvas sized in CSS pixels. */
export function trackPoster(def: TrackDefinition, cssW: number, cssH: number): HTMLCanvasElement {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);

  const s: Scene = {
    ctx,
    w: cssW,
    h: cssH,
    horizon: cssH * 0.52,
    rng: seededRandom(hashId(def.id)),
    def,
  };

  drawSky(s);
  switch (def.theme) {
    case 'desert':
      drawDesert(s);
      break;
    case 'beach':
      drawBeach(s);
      break;
    case 'snow':
      drawSnow(s);
      break;
    case 'volcano':
      drawVolcano(s);
      break;
    case 'neon':
      drawNeon(s);
      break;
    case 'grassland':
    default:
      drawGrassland(s);
      break;
  }
  drawCircuit(s);
  drawVignette(s);
  return canvas;
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Shared scenery
// ---------------------------------------------------------------------------

function drawSky(s: Scene): void {
  const { ctx, w, h, def } = s;
  const env = def.environment;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, css(env.skyTop));
  g.addColorStop(0.62, css(env.skyHorizon));
  g.addColorStop(1, css(env.skyBottom));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** Soft glowing disc, used for the sun on day circuits and the moon at night. */
function drawSun(s: Scene, x: number, y: number, r: number, core: string, glow: string): void {
  const { ctx } = s;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
  g.addColorStop(0, glow);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** A ridge line across the poster; `jag` picks between rolling hills and peaks. */
function drawRidge(s: Scene, baseY: number, amp: number, fill: string, jag: number, seedShift: number): void {
  const { ctx, w } = s;
  const rng = seededRandom(hashId(s.def.id) + seedShift);
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * w;
    const t = i / steps;
    const peak = Math.sin(t * Math.PI * 2.4 + seedShift) * 0.5 + 0.5;
    const y = baseY - amp * (0.35 + peak * 0.65) * (1 - jag * 0.4 + rng() * jag);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, baseY + 40);
  ctx.lineTo(0, baseY + 40);
  ctx.closePath();
  ctx.fill();
}

function drawGround(s: Scene, top: string, bottom: string): void {
  const { ctx, w, h, horizon } = s;
  const g = ctx.createLinearGradient(0, horizon, 0, h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, horizon, w, h - horizon);
}

function drawPalm(s: Scene, x: number, baseY: number, height: number, trunk: string, frond: string): void {
  const { ctx } = s;
  ctx.strokeStyle = trunk;
  ctx.lineWidth = Math.max(1.4, height * 0.07);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.quadraticCurveTo(x + height * 0.12, baseY - height * 0.6, x + height * 0.06, baseY - height);
  ctx.stroke();
  ctx.strokeStyle = frond;
  ctx.lineWidth = Math.max(1.2, height * 0.055);
  const tipX = x + height * 0.06;
  const tipY = baseY - height;
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI * 0.9 + (i / 5) * Math.PI * 0.8;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.quadraticCurveTo(
      tipX + Math.cos(a) * height * 0.28,
      tipY + Math.sin(a) * height * 0.24,
      tipX + Math.cos(a) * height * 0.46,
      tipY + Math.sin(a) * height * 0.2 + height * 0.1,
    );
    ctx.stroke();
  }
}

function drawPine(s: Scene, x: number, baseY: number, height: number, fill: string): void {
  const { ctx } = s;
  ctx.fillStyle = fill;
  for (let tier = 0; tier < 3; tier++) {
    const t = tier / 3;
    const wHalf = height * 0.3 * (1 - t * 0.45);
    const yTop = baseY - height * (0.42 + t * 0.29);
    const yBot = baseY - height * (t * 0.29) - height * 0.05;
    ctx.beginPath();
    ctx.moveTo(x, yTop);
    ctx.lineTo(x + wHalf, yBot);
    ctx.lineTo(x - wHalf, yBot);
    ctx.closePath();
    ctx.fill();
  }
}

function drawVignette(s: Scene): void {
  const { ctx, w, h } = s;
  const g = ctx.createLinearGradient(0, h * 0.55, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// ---------------------------------------------------------------------------
// Per-theme scenes
// ---------------------------------------------------------------------------

function drawGrassland(s: Scene): void {
  const { ctx, w, h, horizon } = s;
  drawSun(s, w * 0.78, horizon * 0.42, h * 0.055, 'rgba(255,250,225,0.95)', 'rgba(255,240,190,0.5)');
  drawRidge(s, horizon + 2, h * 0.16, 'rgba(96,126,160,0.55)', 0.5, 11);
  drawRidge(s, horizon + 6, h * 0.1, 'rgba(74,112,72,0.85)', 0.3, 27);
  drawGround(s, '#5d9a3a', '#376f24');
  // The Menara pavilion, a low block with a pyramid roof, sitting by the water.
  const px = w * 0.16;
  const py = horizon + h * 0.1;
  ctx.fillStyle = '#c8a86e';
  ctx.fillRect(px - w * 0.045, py - h * 0.11, w * 0.09, h * 0.11);
  ctx.fillStyle = '#7d5236';
  ctx.beginPath();
  ctx.moveTo(px - w * 0.06, py - h * 0.11);
  ctx.lineTo(px, py - h * 0.2);
  ctx.lineTo(px + w * 0.06, py - h * 0.11);
  ctx.closePath();
  ctx.fill();
  for (let i = 0; i < 7; i++) {
    const x = w * (0.32 + i * 0.1);
    drawPalm(s, x, horizon + h * (0.06 + (i % 3) * 0.02), h * 0.2, '#6b4a2a', '#2f6f2c');
  }
}

function drawDesert(s: Scene): void {
  const { ctx, w, h, horizon } = s;
  drawSun(s, w * 0.7, horizon * 0.55, h * 0.075, 'rgba(255,214,150,0.98)', 'rgba(255,150,60,0.55)');
  drawRidge(s, horizon + 2, h * 0.13, 'rgba(150,88,48,0.55)', 0.55, 5);
  drawGround(s, '#d9a05c', '#9c6330');
  // Overlapping dune crests.
  const crests = [
    { y: horizon + h * 0.08, fill: 'rgba(232,184,119,0.95)' },
    { y: horizon + h * 0.2, fill: 'rgba(200,140,80,0.95)' },
  ];
  for (let c = 0; c < crests.length; c++) {
    ctx.fillStyle = crests[c].fill;
    ctx.beginPath();
    ctx.moveTo(0, crests[c].y + h * 0.1);
    for (let i = 0; i <= 10; i++) {
      const x = (i / 10) * w;
      ctx.lineTo(x, crests[c].y - Math.sin(i * 0.9 + c * 2.1) * h * 0.045);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
  }
  // Kasbah on the left: a wall with two crenellated towers.
  const kx = w * 0.13;
  const ky = horizon + h * 0.05;
  ctx.fillStyle = '#8a5a33';
  ctx.fillRect(kx - w * 0.07, ky - h * 0.1, w * 0.14, h * 0.1);
  for (const dx of [-w * 0.07, w * 0.045]) {
    ctx.fillRect(kx + dx, ky - h * 0.17, w * 0.025, h * 0.17);
  }
  ctx.fillStyle = '#6b4425';
  for (let i = 0; i < 6; i++) ctx.fillRect(kx - w * 0.07 + i * w * 0.024, ky - h * 0.115, w * 0.012, h * 0.02);
}

function drawBeach(s: Scene): void {
  const { ctx, w, h, horizon } = s;
  drawSun(s, w * 0.72, horizon * 0.5, h * 0.06, 'rgba(255,252,235,0.98)', 'rgba(255,225,170,0.5)');
  // Sea from the horizon down to the shoreline, with a sun path on it.
  const shore = horizon + h * 0.17;
  const sea = ctx.createLinearGradient(0, horizon, 0, shore);
  sea.addColorStop(0, '#1a7fb8');
  sea.addColorStop(1, '#2ba7cf');
  ctx.fillStyle = sea;
  ctx.fillRect(0, horizon, w, shore - horizon);
  ctx.fillStyle = 'rgba(255,240,200,0.28)';
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const y = horizon + t * (shore - horizon);
    const half = w * (0.02 + t * 0.06);
    ctx.fillRect(w * 0.72 - half, y, half * 2, Math.max(1, h * 0.012));
  }
  // Sand.
  const sand = ctx.createLinearGradient(0, shore, 0, h);
  sand.addColorStop(0, '#f0dcae');
  sand.addColorStop(1, '#c9a870');
  ctx.fillStyle = sand;
  ctx.beginPath();
  ctx.moveTo(0, shore + h * 0.02);
  for (let i = 0; i <= 8; i++) ctx.lineTo((i / 8) * w, shore + Math.sin(i * 1.3) * h * 0.015);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  for (let i = 0; i < 5; i++) {
    drawPalm(s, w * (0.08 + i * 0.21), shore + h * 0.06, h * 0.24, '#8a6236', '#1f7a4a');
  }
}

function drawSnow(s: Scene): void {
  const { ctx, w, h, horizon } = s;
  drawSun(s, w * 0.24, horizon * 0.4, h * 0.05, 'rgba(255,255,255,0.95)', 'rgba(210,232,255,0.5)');
  drawRidge(s, horizon + 4, h * 0.24, 'rgba(120,146,178,0.75)', 0.85, 13);
  drawRidge(s, horizon + 10, h * 0.15, 'rgba(214,232,248,0.95)', 0.8, 31);
  drawGround(s, '#e8f2fb', '#b9d2e6');
  // The frozen lake the causeway crosses.
  ctx.fillStyle = 'rgba(58,120,164,0.55)';
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.88, w * 0.42, h * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 8; i++) {
    drawPine(s, w * (0.05 + i * 0.135), horizon + h * (0.1 + (i % 2) * 0.05), h * 0.2, '#1f4a3a');
  }
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 40; i++) {
    ctx.fillRect(s.rng() * w, s.rng() * h * 0.75, 1.6, 1.6);
  }
}

function drawVolcano(s: Scene): void {
  const { ctx, w, h, horizon } = s;
  drawSun(s, w * 0.3, horizon * 0.34, h * 0.045, 'rgba(255,196,120,0.9)', 'rgba(255,90,20,0.45)');
  // Two cones, the taller one venting.
  const cones = [
    { x: w * 0.72, base: horizon + h * 0.06, height: h * 0.34, fill: '#3a2027' },
    { x: w * 0.34, base: horizon + h * 0.04, height: h * 0.24, fill: '#2c181e' },
  ];
  for (const c of cones) {
    ctx.fillStyle = c.fill;
    ctx.beginPath();
    ctx.moveTo(c.x - c.height * 0.85, c.base);
    ctx.lineTo(c.x - c.height * 0.16, c.base - c.height);
    ctx.lineTo(c.x + c.height * 0.16, c.base - c.height);
    ctx.lineTo(c.x + c.height * 0.85, c.base);
    ctx.closePath();
    ctx.fill();
    // Lava spilling out of the crater and down the flank.
    ctx.strokeStyle = 'rgba(255,110,26,0.9)';
    ctx.lineWidth = Math.max(1.4, c.height * 0.035);
    ctx.beginPath();
    ctx.moveTo(c.x, c.base - c.height);
    ctx.quadraticCurveTo(c.x + c.height * 0.25, c.base - c.height * 0.5, c.x + c.height * 0.42, c.base);
    ctx.stroke();
  }
  drawGround(s, '#4a2c22', '#241514');
  // Lava runs pooling across the ash field.
  ctx.strokeStyle = 'rgba(255,92,16,0.85)';
  ctx.lineWidth = Math.max(1.6, h * 0.014);
  for (let i = 0; i < 4; i++) {
    const y = horizon + h * (0.14 + i * 0.16);
    ctx.beginPath();
    ctx.moveTo(-10, y);
    for (let k = 0; k <= 6; k++) ctx.lineTo((k / 6) * w, y + Math.sin(k * 1.6 + i) * h * 0.02);
    ctx.stroke();
  }
  // Embers.
  ctx.fillStyle = 'rgba(255,180,90,0.9)';
  for (let i = 0; i < 34; i++) ctx.fillRect(s.rng() * w, s.rng() * h * 0.8, 1.8, 1.8);
}

function drawNeon(s: Scene): void {
  const { ctx, w, h, horizon } = s;
  drawSun(s, w * 0.2, horizon * 0.32, h * 0.04, 'rgba(230,236,255,0.9)', 'rgba(120,90,220,0.4)');
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  for (let i = 0; i < 46; i++) ctx.fillRect(s.rng() * w, s.rng() * horizon, 1.4, 1.4);
  // Skyline: blocks of varying height with lit windows.
  const colors = ['#1b1030', '#241542', '#150c26'];
  let x = -10;
  let i = 0;
  while (x < w + 10) {
    const bw = w * (0.06 + s.rng() * 0.07);
    const bh = h * (0.14 + s.rng() * 0.26);
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(x, horizon - bh, bw, bh + h * 0.1);
    ctx.fillStyle = i % 2 === 0 ? 'rgba(90,220,255,0.75)' : 'rgba(255,80,190,0.7)';
    for (let wy = 0; wy < Math.floor(bh / (h * 0.05)); wy++) {
      for (let wx = 0; wx < 3; wx++) {
        if (s.rng() < 0.45) continue;
        ctx.fillRect(x + bw * (0.16 + wx * 0.28), horizon - bh + h * 0.02 + wy * h * 0.05, bw * 0.14, h * 0.018);
      }
    }
    x += bw + w * 0.012;
    i++;
  }
  drawGround(s, '#120c1e', '#080610');
  // Street-level glow strips.
  for (const [y, c] of [
    [horizon + h * 0.1, 'rgba(90,220,255,0.5)'],
    [horizon + h * 0.24, 'rgba(255,80,190,0.45)'],
  ] as [number, string][]) {
    ctx.strokeStyle = c;
    ctx.lineWidth = Math.max(1.4, h * 0.012);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// The circuit itself
// ---------------------------------------------------------------------------

/**
 * Projects the real centerline into the lower half of the poster at a low angle,
 * so the card shows the layout you are about to drive.
 */
function drawCircuit(s: Scene): void {
  const { ctx, w, h, def } = s;
  const pts = def.controlPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  if (pts.length < 4) return;
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
  const N = 220;
  const samples: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) samples.push(curve.getPoint(i / N));

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of samples) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);

  // Squash Z to fake a low camera angle, then fit inside the lower band.
  const boxW = w * 0.74;
  const boxH = h * 0.36;
  const scale = Math.min(boxW / spanX, boxH / (spanZ * 0.42));
  const cx = w * 0.5;
  const cy = h * 0.72;
  const project = (p: THREE.Vector3): [number, number] => [
    cx + (p.x - (minX + maxX) / 2) * scale,
    cy + (p.z - (minZ + maxZ) / 2) * scale * 0.42 - p.y * scale * 0.5,
  ];

  const path = new Path2D();
  const [x0, y0] = project(samples[0]);
  path.moveTo(x0, y0);
  for (let i = 1; i < samples.length; i++) {
    const [x, y] = project(samples[i]);
    path.lineTo(x, y);
  }
  path.closePath();

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Drop shadow, tarmac, then the dashed centre line.
  ctx.strokeStyle = 'rgba(0,0,0,0.42)';
  ctx.lineWidth = Math.max(6, h * 0.1);
  ctx.stroke(path);
  ctx.strokeStyle = css(def.palette.road);
  ctx.lineWidth = Math.max(4.5, h * 0.075);
  ctx.stroke(path);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = Math.max(0.8, h * 0.009);
  ctx.setLineDash([Math.max(3, h * 0.035), Math.max(3, h * 0.035)]);
  ctx.stroke(path);
  ctx.setLineDash([]);

  // Start/finish marker on the line at t = 0.
  const [sx, sy] = project(samples[0]);
  const size = Math.max(4, h * 0.055);
  ctx.save();
  ctx.translate(sx, sy);
  const cell = size / 2;
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      ctx.fillStyle = (gx + gy) % 2 === 0 ? '#f6f6f6' : '#15151a';
      ctx.fillRect(-size / 2 + gx * cell, -cell / 2 + gy * cell * 0.5, cell, cell * 0.5);
    }
  }
  ctx.restore();
}
