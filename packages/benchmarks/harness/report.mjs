/**
 * Renders results/latest.json as markdown. Reads whatever sections are present, so it is useful
 * after a single runner as well as after a full `run.mjs`.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from './lib/results.mjs';
import { RESULTS_DIR, ROUTES, TARGETS } from './lib/targets.mjs';
import { ms, bytes, num } from './lib/stats.mjs';

const results = await load();
const md = render(results);
const outFile = path.join(RESULTS_DIR, 'latest.md');
await writeFile(outFile, md);
process.stdout.write(md);
console.error(`\n(wrote ${path.relative(process.cwd(), outFile)})`);

function render(r) {
  const ids = TARGETS.map((t) => t.id).filter((id) => Object.values(r.sections).some((s) => sectionHas(s, id)));
  const labels = ids.map((id) => TARGETS.find((t) => t.id === id).label);
  const lines = [];

  lines.push('# Benchmark results', '');
  lines.push(`Generated ${r.env.at} — see [../README.md](../README.md) for what each number means and what it does not.`, '');

  lines.push('## Environment', '');
  lines.push(
    table(
      ['Property', 'Value'],
      [
        ['Machine', `${r.env.cpu} · ${r.env.cores} cores · ${r.env.totalMemGB} GB`],
        ['Platform', r.env.platform],
        ['Node', r.env.node],
        ['CI', r.env.ci ? 'yes' : 'no — laptop numbers, treat spreads under ~10% as noise'],
      ],
    ),
  );
  lines.push('');

  lines.push('### Versions', '');
  lines.push(
    'React version skew across the three is unavoidable — Next vendors its own copy — so it is reported rather than hidden. A render-path difference of a few percent is more likely this than the framework.',
    '',
  );
  const allPkgs = [...new Set(ids.flatMap((id) => Object.keys(r.env.versions[id] ?? {}).filter((k) => k !== 'installed')))];
  lines.push(
    table(
      ['Package', ...labels],
      allPkgs.map((pkg) => [`\`${pkg}\``, ...ids.map((id) => r.env.versions[id]?.[pkg] ?? '—')]),
    ),
  );
  lines.push('');

  if (r.sections.payload) lines.push(...payloadSection(r.sections.payload, ids, labels));
  if (r.sections.build) lines.push(...buildSection(r.sections.build, ids, labels));
  if (r.sections.coldstart) lines.push(...coldstartSection(r.sections.coldstart, ids, labels));
  if (r.sections.load) lines.push(...loadSection(r.sections.load, ids, labels));
  if (r.sections.devstart) lines.push(...devstartSection(r.sections.devstart, ids, labels));
  if (r.sections.footprint) lines.push(...footprintSection(r.sections.footprint, ids, labels));

  return `${lines.join('\n')}\n`;
}

function payloadSection(section, ids, labels) {
  const lines = ['## Initial-load payload', ''];
  lines.push(
    'Brotli-compressed bytes the browser is committed to fetching before the route is interactive: the document, the inline flight payload, and every statically referenced script and stylesheet. Compression is applied by the harness, identically for all three.',
    '',
  );

  for (const route of ROUTES) {
    lines.push(`### \`${route.path}\` — ${route.kind}`, '');
    const rows = [
      ['Document (br)', (t) => bytes(t?.document?.brotli)],
      ['Inline script (raw)', (t) => bytes(t?.inlineScriptBytes)],
      ['External JS (br)', (t) => (t?.js ? `${bytes(t.js.brotli)} · ${t.js.count} file${t.js.count === 1 ? '' : 's'}` : '—')],
      ['CSS (br)', (t) => (t?.css ? `${bytes(t.css.brotli)} · ${t.css.count}` : '—')],
      ['**Total (br)**', (t) => `**${bytes(t?.total?.brotli)}**`],
      ['Total (raw)', (t) => bytes(t?.total?.raw)],
      ['Requests', (t) => num(t?.requests)],
      ['Spec checks', (t) => checkMark(t)],
    ];
    lines.push(
      table(
        ['Metric', ...labels],
        rows.map(([name, get]) => [name, ...ids.map((id) => cell(section[id], route.id, get))]),
      ),
    );
    lines.push('');
  }
  return lines;
}

function cell(target, routeId, get) {
  if (!target) return '—';
  if (target.error) return '✗ failed';
  const route = target.routes?.[routeId];
  if (!route) return '—';
  if (route.error) return `✗ ${route.error}`;
  return get(route);
}

function checkMark(route) {
  if (!route?.checks) return '—';
  const failed = route.checks.filter((c) => !c.found);
  return failed.length ? `⚠ missing ${failed.map((c) => `\`${c.text}\``).join(', ')}` : '✓';
}

function buildSection(section, ids, labels) {
  const lines = ['## Build', ''];
  lines.push(
    `Median of ${section[ids[0]]?.trials ?? '?'} trials. Cold clears the framework's cache directory first; warm keeps it and touches one source file the interactive route imports.`,
    '',
  );
  lines.push(
    table(
      ['Metric', ...labels],
      [
        ['Cold build', ...ids.map((id) => withSpread(section[id]?.coldMs))],
        ['Warm rebuild', ...ids.map((id) => withSpread(section[id]?.warmMs))],
        ['Build output', ...ids.map((id) => bytes(section[id]?.artifacts?.totalBytes))],
        ['Output files', ...ids.map((id) => num(section[id]?.artifacts?.files))],
        ['Server bundle', ...ids.map((id) => bytes(section[id]?.artifacts?.serverBundleBytes))],
      ],
    ),
  );
  lines.push('');
  return lines;
}

function withSpread(entry) {
  if (!entry || entry.median === null) return '—';
  const spread = entry.rsdPct === null ? '' : ` ±${entry.rsdPct.toFixed(0)}%`;
  return `${ms(entry.median)}${spread}`;
}

function coldstartSection(section, ids, labels) {
  const lines = ['## Cold start', ''];
  lines.push(
    'Process spawn to first answered request, fresh process each trial. Not a real serverless cold start — no container, no network — it isolates the JavaScript the framework has to parse and run before it can respond.',
    '',
  );
  lines.push(
    table(
      ['Metric', ...labels],
      [
        ['Spawn → first response', ...ids.map((id) => withSpread(section[id]?.readyMs))],
        ['Server bundle', ...ids.map((id) => bytes(section[id]?.serverBundleBytes))],
      ],
    ),
  );
  lines.push('');
  return lines;
}

function loadSection(section, ids, labels) {
  const s = section.settings ?? {};
  const lines = ['## Throughput', ''];
  lines.push(
    `${s.connections} connections, ${(s.durationMs ?? 0) / 1000}s per route after a ${(s.warmupMs ?? 0) / 1000}s warmup, driven by the harness's own Node load generator.`,
    '',
    '**Read this as a floor check, not a headline.** All three render through the same React and stream through the same react-dom, so a large gap would mean an HTTP layer is pathological rather than that one framework renders faster. The in-process driver is identically handicapping for all three, and its absolute rps is a lower bound. `/api/health` is the informative row: no React on the path, so it is router and response construction alone.',
    '',
    'All three put React server components on the request path for `/ssr` and `/interactive` (APP_SPEC.md rule 8), so those two rows compare implementations of one architecture. They are not a perfect match: rshono and Next encode and decode the whole document, TanStack Start only the route body its RSC helpers wrap — its shell and nav stay on the cheaper non-RSC path. The flight round trip dominates both rows; on `/ssr` it is roughly 85% of the request.',
    '',
  );

  for (const route of ROUTES) {
    /*
     * A route that answered with errors has no throughput to report, so it reports none: the error path skips the
     * render, so its rps is not a slow version of the real number but a different measurement — and a higher one.
     * A `/ssr` returning 500 to all 22,675 requests once published at 2,828 rps beside two working frameworks at
     * ~270, and was read as a 10× win.
     */
    const measured = (get) => (x) => (x?.ok === false ? '—' : get(x));
    const rows = [
      ['Requests/sec', measured((x) => num(x?.rps))],
      ['p50', measured((x) => ms(x?.latencyMs?.p50))],
      ['p99', measured((x) => ms(x?.latencyMs?.p99))],
      ['Errors', (x) => (x?.ok === false ? `⚠ ${x.problem}` : '0')],
    ];
    lines.push(`### \`${route.path}\``, '');
    lines.push(
      table(
        ['Metric', ...labels],
        rows.map(([name, get]) => [
          name,
          ...ids.map((id) => (section.targets?.[id]?.error ? '✗ failed' : get(section.targets?.[id]?.routes?.[route.id]))),
        ]),
      ),
    );
    // Named, so the empty cells are attributable without cross-reading the Errors row.
    const broken = ids.filter((id) => section.targets?.[id]?.routes?.[route.id]?.ok === false);
    if (broken.length) {
      lines.push(
        '',
        `> ⚠ **Not measured** for ${broken.map((id) => labels[ids.indexOf(id)]).join(', ')} — the route did not serve 2xx, and an error ` +
          'response skips the render, so its rps would read higher than a working server rather than lower. Fix the route and re-run; ' +
          'do not quote this row.',
      );
    }
    const warning = section.targets?._warnings?.[route.id];
    if (warning) lines.push('', `> ⚠ ${warning}`);
    lines.push('');
  }

  lines.push('### Memory', '');
  lines.push(
    'Resident memory of the whole process tree, and of the single largest process in it — which is the server itself in all three. The tree total carries whatever `npm run start` left running and double-counts pages the processes share, so the **server** row is the one to compare.',
    '',
    '**None of these are retained-memory figures.** RSS is a high-water mark that includes garbage V8 has not collected yet, and V8 sizes the old generation against the *allocation rate* — so under a fixed-duration load the fastest server churns the most and grows the largest heap. On this app a forced GC returned 362 MB of the 472 MB an uncapped `/api/health` run reported. All three are therefore given the same old-space budget' +
      (heapMb(section) ? ` (\`--max-old-space-size=${heapMb(section)}\`)` : '') +
      ', which is what makes the rows comparable; the per-route sequence is there so a plateau is distinguishable from a climb. Retention per request measured on the rshono app, after a full GC, was under 20 B — a leak is not what these numbers show.',
    '',
  );
  lines.push(
    table(
      ['Metric', ...labels],
      [
        ['RSS idle — tree', ...ids.map((id) => rssCell(section.targets?.[id]?.rssIdle))],
        ['RSS idle — server', ...ids.map((id) => rssCell(section.targets?.[id]?.rssIdle, true))],
        ['RSS after load — tree', ...ids.map((id) => rssCell(section.targets?.[id]?.rssLoaded))],
        ['RSS after load — server', ...ids.map((id) => rssCell(section.targets?.[id]?.rssLoaded, true))],
        // Flat across the last routes means the server had levelled off; a straight climb means the
        // single after-load figure above is just wherever the run happened to stop.
        ['RSS per route — server', ...ids.map((id) => rssTrajectory(section.targets?.[id]))],
        ['Requests served', ...ids.map((id) => requestsServed(section.targets?.[id]))],
        // Per unit of work, because the load runs for a fixed *time*: a server that answers five times
        // as many requests in those eight seconds allocates five times as much, and the raw after-load
        // figure would read that as five times worse. "Churn", not "growth" — almost none of it is
        // retained, and calling it growth invited reading the row as a leak.
        ['Churn per 1k requests', ...ids.map((id) => churnPerThousand(section.targets?.[id]))],
      ],
    ),
  );
  lines.push('');
  return lines;
}

/** The old-space cap the load ran under, or 0 when `--heap=0` opted out of one. */
function heapMb(section) {
  return section?.settings?.heapMb ?? 0;
}

/** Server RSS after each route in turn, so the shape of the curve survives into the report. */
function rssTrajectory(target) {
  const after = target?.rssAfter;
  if (!after) return '—';
  const trail = ROUTES.filter((r) => after[r.id]?.largest).map((r) => bytes(after[r.id].largest));
  return trail.length ? trail.join(' → ') : '—';
}

function rssCell(rss, serverOnly = false) {
  if (!rss) return '—';
  if (serverOnly) return rss.largest ? bytes(rss.largest) : '—';
  return `${bytes(rss.bytes)}${rss.processes > 1 ? ` (${rss.processes} procs)` : ''}`;
}

function totalRequests(target) {
  const routes = target?.routes;
  return routes ? Object.values(routes).reduce((sum, r) => sum + (r?.requests ?? 0), 0) : 0;
}

function requestsServed(target) {
  const n = totalRequests(target);
  return n ? num(n) : '—';
}

/**
 * RSS the server picked up per 1,000 requests served. Read as allocation churn, not retention — a full GC gives
 * nearly all of it back — but still the only row the fixed-duration load does not bias toward whichever server
 * answered fewest requests.
 */
function churnPerThousand(target) {
  const n = totalRequests(target);
  const idle = target?.rssIdle?.largest;
  const loaded = target?.rssLoaded?.largest;
  if (!n || !idle || !loaded) return '—';
  return `${bytes(Math.max(0, ((loaded - idle) / n) * 1000))}`;
}

function devstartSection(section, ids, labels) {
  const lines = ['## Dev server startup', ''];
  lines.push(
    '`dev` command to a served `/interactive` — which every one of these compiles lazily, so it includes compiling a route with three client components rather than just binding a socket. Cold clears the dev cache first.',
    '',
    'HMR round-trip is the other number worth having here and is not measured: it needs a browser driving the page to assert the patch arrived.',
    '',
  );
  lines.push(
    table(
      ['Metric', ...labels],
      [
        ['Cold dev start', ...ids.map((id) => withSpread(section[id]?.coldMs))],
        ['Warm dev start', ...ids.map((id) => withSpread(section[id]?.warmMs))],
      ],
    ),
  );
  lines.push('');
  return lines;
}

function footprintSection(section, ids, labels) {
  const lines = ['## Footprint', ''];
  lines.push('A production-only install (`--omit=dev`) into a throwaway directory, and the application code the spec took to express.', '');
  lines.push(
    table(
      ['Metric', ...labels],
      [
        ['Prod install size', ...ids.map((id) => bytes(section[id]?.install?.bytes))],
        ['Packages installed', ...ids.map((id) => num(section[id]?.install?.packages))],
        ['Direct dependencies', ...ids.map((id) => num(section[id]?.install?.dependencies))],
        ['App source files', ...ids.map((id) => num(section[id]?.source?.files))],
        ['App source lines', ...ids.map((id) => num(section[id]?.source?.lines))],
      ],
    ),
  );
  lines.push('');
  return lines;
}

function sectionHas(section, id) {
  return Boolean(section?.[id] ?? section?.targets?.[id]);
}

function table(header, rows) {
  const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map((row) => String(row[i] ?? '').length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ')} |`;
  return [line(header), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(line)].join('\n');
}
