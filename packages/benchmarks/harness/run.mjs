/**
 * Runs every section in order and snapshots the result. Order matters: build goes first because the other three
 * need artifacts on disk, and it is also the runner most sensitive to a busy machine.
 */
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from './lib/proc.mjs';
import { RESULTS_DIR, resolveTargets, hasFlag } from './lib/targets.mjs';
import { load, save } from './lib/results.mjs';
import { ms } from './lib/stats.mjs';

const HARNESS = fileURLToPath(new URL('.', import.meta.url));
const targets = resolveTargets();
const passthrough = process.argv.slice(2).filter((a) => a.startsWith('--'));

const stages = [
  ['build', 'build.mjs'],
  ['payload', 'payload.mjs'],
  ['coldstart', 'coldstart.mjs'],
  ['load', 'load.mjs'],
  ['devstart', 'devstart.mjs'],
  ...(hasFlag('footprint') ? [['footprint', 'footprint.mjs']] : []),
];

if (os.platform() === 'darwin' && !process.env.CI) {
  console.log(
    [
      '⚠ Running on macOS outside CI.',
      '  Thermal throttling and background indexing produce run-to-run swings larger than most of the',
      '  differences being measured. Payload and size numbers are exact anywhere; timings from a laptop',
      '  are indicative only. Quote timings from a fixed Linux runner.',
      '',
    ].join('\n'),
  );
}

const ids = targets.map((t) => t.id);
const failed = [];

for (const [name, script] of stages) {
  console.log(`\n${'─'.repeat(72)}\n▶ ${name}\n${'─'.repeat(72)}`);
  const res = await run('node', [path.join(HARNESS, script), ...ids, ...passthrough], { capture: false });
  if (res.code !== 0) failed.push(name);
  console.log(`\n◀ ${name} finished in ${ms(res.ms)}${res.code === 0 ? '' : ` (exit ${res.code})`}`);
}

// Snapshot alongside latest.json so a result is never silently overwritten by the next run.
const results = await load();
results.run = { stages: stages.map(([n]) => n), targets: ids, failed };
await save(results);

const stamp = results.env.at.replace(/[:.]/g, '-');
const snapshot = path.join(RESULTS_DIR, `${stamp}-${os.platform()}-${process.env.CI ? 'ci' : 'local'}.json`);
await copyFile(path.join(RESULTS_DIR, 'latest.json'), snapshot);
console.log(`\nsnapshot → ${path.relative(process.cwd(), snapshot)}`);

await run('node', [path.join(HARNESS, 'report.mjs')], { capture: false });

if (failed.length) {
  console.error(`\n✗ stages failed: ${failed.join(', ')}`);
  process.exit(1);
}
