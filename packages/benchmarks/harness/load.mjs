/**
 * Throughput and latency per route, plus resident memory under load.
 *
 * Read this as the floor check it is: all three render through the same React, so a large gap would mean
 * someone's HTTP layer is pathological, not that one framework renders React faster. `/api/health` is the
 * interesting row — it takes React out of the path and leaves the router and response construction.
 */
import { resolveTargets, ROUTES, flagValue, hasFlag } from './lib/targets.mjs';
import { indent, startServer, portFree } from './lib/proc.mjs';
import { drive, driverBoundWarning } from './lib/loadgen.mjs';
import { treeRss } from './lib/rss.mjs';
import { ms, num, bytes } from './lib/stats.mjs';
import { merge } from './lib/results.mjs';

const targets = resolveTargets();
const connections = Number(flagValue('connections', '32'));
const durationMs = Number(flagValue('duration', '8')) * 1000;
const warmupMs = Number(flagValue('warmup', '2')) * 1000;
const quick = hasFlag('quick');

/**
 * An equal old-space budget for all three, because without one the memory numbers compare nothing.
 *
 * V8 sizes the old generation against the *allocation rate* and only collects in earnest near the limit, so at
 * the default after-load RSS measures throughput rather than memory: the fastest server churns the most in the
 * fixed eight seconds and grows the largest heap. Measured on rshono, `/api/health` reached 472 MB RSS of which
 * a forced GC returned 362 MB; capped, the same route holds flat at 120 MB with throughput unchanged.
 *
 * So the cap does not restrain the servers, it stops the metric rewarding slowness. `--heap=0` opts out, and the
 * value is reported alongside the numbers.
 */
const heapMb = Number(flagValue('heap', '256'));

const settings = {
  connections,
  durationMs: quick ? 2000 : durationMs,
  warmupMs: quick ? 500 : warmupMs,
  heapMb,
};

/**
 * Inherited by whatever `npm run start` spawns, which is the point: Next and Vite both push the
 * server into a child, and a cap only on the launcher would bound nothing.
 */
const serverEnv = heapMb > 0 ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${heapMb}`.trim() } : undefined;

for (const target of targets) {
  if (!(await portFree(target.port))) {
    console.error(`✗ port ${target.port} is already answering — something is still running from a previous run.`);
    process.exit(1);
  }
}

const out = { settings, targets: {} };

for (const target of targets) {
  console.log(`\n=== ${target.label} ===`);
  let server;
  try {
    server = await startServer(target, { env: serverEnv });
  } catch (error) {
    out.targets[target.id] = { label: target.label, error: error.message };
    // Whole message — see the same call in payload.mjs. The reason a server did not start is in the
    // output `startServer` appends, not in the headline.
    console.log(indent(error.message));
    continue;
  }

  const routes = {};
  let rssIdle = null;
  let rssLoaded = null;
  // One sample per route rather than one at the end: a single after-load reading lands straight after
  // the highest-throughput route, catching each server at its churniest moment with no way to tell
  // whether it had levelled off. The sequence can — flat across the last few routes means a plateau.
  const rssAfter = {};
  try {
    rssIdle = await treeRss(server.pid);
    for (const route of ROUTES) {
      const result = await drive(server.base + route.path, settings);
      routes[route.id] = result;
      console.log(
        `  ${route.path.padEnd(14)} ${num(result.rps).padStart(8)} rps` +
          `  p50 ${ms(result.latencyMs.p50).padStart(8)}` +
          `  p99 ${ms(result.latencyMs.p99).padStart(8)}` +
          `  ${result.ok ? '' : `⚠ ${result.problem}`}`,
      );
      rssLoaded = await treeRss(server.pid);
      if (rssLoaded) rssAfter[route.id] = { bytes: rssLoaded.bytes, largest: rssLoaded.largest };
    }
  } finally {
    await server.stop();
  }

  out.targets[target.id] = { label: target.label, routes, rssIdle, rssLoaded, rssAfter, startupMs: server.readyMs };
  if (rssIdle) {
    const trail = ROUTES.filter((r) => rssAfter[r.id]).map((r) => bytes(rssAfter[r.id].largest));
    console.log(`  rss idle ${bytes(rssIdle.bytes)} (${rssIdle.processes} proc) → loaded ${bytes(rssLoaded?.bytes)}`);
    console.log(`  server rss per route: ${bytes(rssIdle.largest)} → ${trail.join(' → ')}`);
    // The tree total on its own invites the wrong conclusion — most of it is usually `npm` and a
    // shell sitting idle. Print who holds what so the number is attributable.
    for (const p of rssLoaded?.breakdown ?? []) console.log(`    ${bytes(p.bytes).padStart(10)}  ${p.comm} (pid ${p.pid})`);
  }
}

for (const route of ROUTES) {
  // Only routes that actually served 2xx. A failed one carries an rps that measures the error path,
  // which would both skew the spread and invite a comparison against numbers that mean something else.
  const byTarget = Object.fromEntries(Object.entries(out.targets).map(([id, t]) => [id, t.routes?.[route.id]?.ok ? t.routes[route.id].rps : null]));
  const warning = driverBoundWarning(byTarget);
  if (warning) {
    out.targets._warnings ??= {};
    out.targets._warnings[route.id] = warning;
    console.log(`\n⚠ ${route.path}: ${warning}`);
  }
}

await merge('load', out);
console.log('\nwrote results/latest.json → sections.load');

/*
 * Restated at the end because the per-route ⚠ scrolls past in a full run, and an error response skips the render
 * — so a broken route reports *higher* rps than a working one.
 */
const unmeasured = [];
for (const route of ROUTES) {
  for (const [id, target] of Object.entries(out.targets)) {
    if (id === '_warnings') continue;
    const result = target.routes?.[route.id];
    if (result && result.ok === false) unmeasured.push(`${target.label} ${route.path} — ${result.problem}`);
  }
}
if (unmeasured.length) {
  console.log(`\n⚠ ${unmeasured.length} route(s) served errors and were NOT measured:`);
  for (const line of unmeasured) console.log(`    ${line}`);
  console.log('  The report shows these as “—”. Fix the route and re-run before quoting the throughput section.');
}
