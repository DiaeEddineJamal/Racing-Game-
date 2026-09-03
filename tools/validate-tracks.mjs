/**
 * Bundles the track definitions and runs the dev-time validator over them from
 * Node, so a new circuit can be checked without opening a browser.
 *
 *   node tools/validate-tracks.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const OUT = path.resolve('.tracks.mjs');
const rolldown = path.resolve('node_modules/rolldown/bin/cli.mjs');
execFileSync(
  process.execPath,
  [rolldown, 'src/track/tracks/index.ts', '--format', 'esm', '--file', OUT, '--external', 'three', '--platform', 'node'],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

const { TRACKS } = await import(new URL(`file://${OUT.replace(/\\/g, '/')}`).href);
fs.rmSync(OUT, { force: true });

let bad = 0;
for (const def of TRACKS) {
  const pts = def.controlPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
  curve.arcLengthDivisions = 1000;
  const length = curve.getLength();

  const N = 400;
  const samples = [];
  for (let i = 0; i < N; i++) samples.push(curve.getPointAt(i / N));
  const ds = length / N;
  const hw = def.halfWidth;
  const r = 1.75 * hw;
  let worst = Infinity;
  let worstInfo = '';
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      let k = j - i;
      if (k > N / 2) k = N - k;
      const arc = k * ds;
      if (arc < 2 * hw) continue;
      const d = Math.hypot(samples[i].x - samples[j].x, samples[i].z - samples[j].z);
      const need = 2 * r * Math.sin(Math.min(arc / (2 * r), Math.PI / 2));
      if (d / need < worst) {
        worst = d / need;
        worstInfo = `t=${(i / N).toFixed(3)}/${(j / N).toFixed(3)} ${d.toFixed(1)}m (need ${need.toFixed(1)}m)`;
      }
    }
  }

  let minR = Infinity;
  const step = Math.max(1, Math.round(4.5 / ds));
  for (let i = 0; i < N; i++) {
    const a = samples[(i - step + N) % N];
    const b = samples[i];
    const c = samples[(i + step) % N];
    const D = 2 * (a.x * (b.z - c.z) + b.x * (c.z - a.z) + c.x * (a.z - b.z));
    if (Math.abs(D) < 1e-6) continue;
    const a2 = a.x * a.x + a.z * a.z;
    const b2 = b.x * b.x + b.z * b.z;
    const c2 = c.x * c.x + c.z * c.z;
    const ux = (a2 * (b.z - c.z) + b2 * (c.z - a.z) + c2 * (a.z - b.z)) / D;
    const uz = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / D;
    minR = Math.min(minR, Math.hypot(a.x - ux, a.z - uz));
  }

  let ymin = Infinity;
  let ymax = -Infinity;
  for (const s of samples) {
    ymin = Math.min(ymin, s.y);
    ymax = Math.max(ymax, s.y);
  }

  const problems = [];
  if (def.controlPoints.length < 14 || def.controlPoints.length > 26) problems.push('control point count');
  if (def.halfWidths && def.halfWidths.length !== def.controlPoints.length) problems.push('halfWidths length');
  if (length < 850 || length > 1450) problems.push('length');
  if (worst < 0.95) problems.push(`clearance ${worstInfo}`);
  if (minR < 10) problems.push(`kink r=${minR.toFixed(1)}m`);
  if (ymax - ymin > 18) problems.push('elevation range');
  if (problems.length) bad++;

  console.log(
    `${problems.length ? 'FAIL' : ' ok '} ${def.id.padEnd(10)} ` +
      `len=${length.toFixed(0)}m  minR=${minR.toFixed(1)}m  clearance=${worst.toFixed(2)}  elev=${(ymax - ymin).toFixed(1)}m` +
      (problems.length ? `\n       ${problems.join('; ')}` : ''),
  );
}

process.exit(bad ? 1 : 0);
