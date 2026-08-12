/**
 * Process spawn → first successful response, measured `--trials` times with a fresh process each time. It
 * tracks server-bundle size closely enough that the two belong next to each other in the report.
 *
 * Not a real serverless cold start — no container, no network, no platform overhead. It isolates the part the
 * framework controls: how much JavaScript is parsed and executed before the first byte can be answered.
 */
import { resolveTargets, flagValue } from './lib/targets.mjs';
import { startServer } from './lib/proc.mjs';
import { fileSize } from './lib/sizes.mjs';
import { median, rsd, ms, bytes } from './lib/stats.mjs';
import { merge } from './lib/results.mjs';
import path from 'node:path';

const targets = resolveTargets();
const trials = Number(flagValue('trials', '5'));

const out = {};

for (const target of targets) {
  console.log(`\n=== ${target.label} ===`);
  const samples = [];
  let error = null;

  for (let trial = 0; trial < trials; trial += 1) {
    let server;
    try {
      server = await startServer(target, { readyPath: '/api/health' });
    } catch (e) {
      error = e.message;
      break;
    }
    samples.push(server.readyMs);
    console.log(`  #${trial + 1}  ${ms(server.readyMs)}`);
    await server.stop();
  }

  const serverBundleBytes = target.serverBundle ? await fileSize(path.join(target.dir, target.serverBundle)) : null;
  out[target.id] = {
    label: target.label,
    error,
    trials,
    readyMs: { median: median(samples), rsdPct: rsd(samples), samples },
    serverBundleBytes,
  };
  if (error) console.log(`  ✗ ${error.split('\n')[0]}`);
  else console.log(`  median ${ms(median(samples))}${serverBundleBytes ? `  server bundle ${bytes(serverBundleBytes)}` : ''}`);
}

await merge('coldstart', out);
console.log('\nwrote results/latest.json → sections.coldstart');
