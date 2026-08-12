/**
 * `dev` command to a page you can actually look at, measured cold (dev cache cleared) and warm — the
 * developer-facing counterpart to build.mjs.
 *
 * Every dev server here compiles routes lazily, so waiting on `/interactive` rather than `/api/health` is the
 * point: it includes compiling a real route with three client components, not just binding a socket.
 *
 * HMR round-trip time is the other number worth having, and needs a browser driving the page — a bigger harness.
 */
import { resolveTargets, flagValue, hasFlag } from './lib/targets.mjs';
import { startServer, run } from './lib/proc.mjs';
import { removeAll } from './lib/sizes.mjs';
import { median, rsd, ms } from './lib/stats.mjs';
import { merge } from './lib/results.mjs';

const targets = resolveTargets();
const trials = Number(flagValue('trials', '3'));

const out = {};

for (const target of targets) {
  console.log(`\n=== ${target.label} ===`);
  const cold = [];
  const warm = [];
  let error = null;

  for (let trial = 0; trial < trials && !error; trial += 1) {
    for (const mode of ['cold', 'warm']) {
      if (mode === 'cold') await removeAll(target.dir, target.cacheDirs);
      let server;
      try {
        // `startServer` defaults to NODE_ENV=production, which is right for every other section and
        // wrong for this one — these are dev servers. Next warns ("non-standard NODE_ENV value")
        // and each of the three is free to behave differently under an env its dev mode never sees.
        server = await startServer(
          { ...target, start: target.dev },
          { env: { NODE_ENV: 'development' }, readyPath: '/interactive', timeoutMs: 180_000 },
        );
      } catch (e) {
        error = e.message;
        break;
      }
      (mode === 'cold' ? cold : warm).push(server.readyMs);
      console.log(`  ${mode.padEnd(5)} #${trial + 1}  ${ms(server.readyMs)}`);
      await server.stop();
    }
  }

  out[target.id] = {
    label: target.label,
    error,
    trials,
    coldMs: { median: median(cold), rsdPct: rsd(cold), samples: cold },
    warmMs: { median: median(warm), rsdPct: rsd(warm), samples: warm },
  };
  if (error) console.log(`  ✗ ${error.split('\n')[0]}`);
}

await merge('devstart', out);
console.log('\nwrote results/latest.json → sections.devstart');

/**
 * A dev server writes into the same directory the production build uses, so leaving without rebuilding would put
 * an unminified dev bundle where `start` expects a production one — and every payload and throughput number
 * measured afterwards would be quietly wrong.
 */
if (!hasFlag('no-restore')) {
  console.log('\n› restoring production builds (dev clobbered them)');
  for (const target of targets) {
    const res = await run(...target.build, { cwd: target.dir, label: `${target.id} rebuild` });
    console.log(`  ${res.code === 0 ? '✓' : '✗'} ${target.id} ${ms(res.ms)}`);
  }
}
