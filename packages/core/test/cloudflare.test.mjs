// The Workers build, driven the way `workerd` would drive it: the bundle's default export called as
// `fetch(request, env, ctx)`, with an ASSETS binding backed by the assets directory the build
// assembled. That covers everything the platform differs on — the handoff, asset serving, prerendered
// reads through a binding, and compression being the edge's job — without needing wrangler installed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { APP_ENV, buildApp, TESTBED_DIR, TESTBED_DIST, importServerBundle } from './helpers.mjs';

/**
 * Every specifier the bundle imports *statically*, whether or not it was minified.
 *
 * The production server bundle is minified, so there is no whitespace to anchor on: `import` is followed
 * directly by `{`, `*` or a quote. The `from` clause is optional (a bare `import "x"` has none) and the
 * leading `^|[;}]` keeps `import(` — a dynamic import, which is bundled rather than external — and the
 * word `import` inside a string from matching.
 */
const STATIC_IMPORTS = /(?:^|[;}])\s*import\s*(?:[^'"]*?\bfrom\s*)?['"]([^'"]+)['"]/g;

const ASSETS_ROOT = join(TESTBED_DIST, 'cloudflare', 'assets');
const WRANGLER_CONFIG = join(TESTBED_DIR, 'wrangler.jsonc');
const ORIGIN = 'https://rshono.example';

/** Whether the project had a Wrangler config before the build, so the test only removes its own. */
let hadWranglerConfig = false;

/**
 * A stand-in for the Workers Assets binding: serves the assembled directory, with a strong `ETag` and
 * conditional-request handling, which is the part of the real contract the framework leans on.
 */
const ASSETS = {
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const file = resolve(ASSETS_ROOT, `.${path}`);
    if (!file.startsWith(ASSETS_ROOT)) return new Response('not found', { status: 404 });
    try {
      if (statSync(file).isDirectory()) return new Response('not found', { status: 404 });
      const body = readFileSync(file);
      const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.rsc') ? 'text/x-component' : 'application/octet-stream';
      return new Response(body, { status: 200, headers: { 'content-type': type, etag } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  },
};

let worker;
let bundle;

/** One request through the worker, the way the platform invokes it. */
function fetchWorker(path, init) {
  const env = { ASSETS, ...APP_ENV };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
}

before(async () => {
  hadWranglerConfig = existsSync(WRANGLER_CONFIG);
  buildApp(TESTBED_DIR, { args: ['--deploy', 'cloudflare'] });
  bundle = await importServerBundle('cloudflare');
  worker = bundle.default;
});

after(() => {
  // The build scaffolds this for a project that has none; a test must not leave one behind.
  if (!hadWranglerConfig) rmSync(WRANGLER_CONFIG, { force: true });
});

describe('the Workers build output', () => {
  test('is a single module — Wrangler cannot follow the computed specifier a split bundle imports by', () => {
    assert.equal(existsSync(join(TESTBED_DIST, 'server', 'chunks')), false, 'async chunks must be inlined for this target');
  });

  test('leaves nothing external that workerd does not provide', () => {
    const source = readFileSync(join(TESTBED_DIST, 'server', 'main.mjs'), 'utf8');
    const imported = [...source.matchAll(STATIC_IMPORTS)].map((m) => m[1]);
    // Both assertions below are satisfied by an empty list, so a scan that matched nothing would report
    // a clean bundle instead of a broken scan. It has done exactly that once: the pattern required
    // whitespace after `import`, which a minified bundle does not emit.
    assert.ok(imported.length > 0, 'the import scan found nothing — the bundle format changed, not the bundle');
    const foreign = imported.filter((request) => !/^(?:\.|node:|cloudflare:)/.test(request));
    assert.deepEqual(foreign, [], 'a Worker resolves no node_modules at runtime, so everything else must be bundled');
    // node: imports are fine, but only the ones `nodejs_compat` actually covers — and the scaffolded
    // config enables it precisely because the request context needs AsyncLocalStorage.
    assert.deepEqual([...new Set(imported.filter((r) => r.startsWith('node:')))], ['node:async_hooks']);
  });

  test('assembles one assets directory: the hashed bundle, public/ at the root, and the prerender tree', () => {
    assert.ok(existsSync(join(ASSETS_ROOT, '_static', 'chunks')), '/_static/* is served straight from the CDN');
    assert.ok(existsSync(join(ASSETS_ROOT, 'robots.txt')), 'public/ files keep their web-root paths');
    assert.ok(existsSync(join(ASSETS_ROOT, '__ssg', 'docs', 'getting-started', 'index.html')), 'prerendered document');
    assert.ok(existsSync(join(ASSETS_ROOT, '__ssg', 'docs', 'getting-started', 'index.rsc')), 'prerendered flight payload');
  });

  test('writes the caching and crawler rules the CDN cannot infer', () => {
    const headers = readFileSync(join(ASSETS_ROOT, '_headers'), 'utf8');
    assert.match(headers, /\/_static\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
    assert.match(headers, /\/__ssg\/\*\n\s+X-Robots-Tag: noindex/, 'the second copy of a page must not be indexed');
  });

  test('scaffolds a wrangler config, nodejs_compat and assets binding included', () => {
    const config = JSON.parse(readFileSync(WRANGLER_CONFIG, 'utf8'));
    assert.equal(config.main, 'dist/server/main.mjs');
    assert.deepEqual(config.compatibility_flags, ['nodejs_compat']);
    assert.equal(config.assets.directory, 'dist/cloudflare/assets');
    assert.equal(config.assets.binding, 'ASSETS', 'the worker reads public/ and prerendered pages through it');
  });

  /*
   * The generated config used to be dated the day the build ran, which made every fresh project's
   * `wrangler dev` fail: wrangler ships the workerd binary it was released with, and that binary refuses a
   * compatibility date newer than its own — "requires compatibility date X, but the newest date supported
   * by this server binary is Y", and it never starts. `wrangler deploy` hid it, because Cloudflare's own
   * runtime is current.
   *
   * So the date has to be a constant behind the released wranglers, and this is what says so. The bound is
   * the build date rather than a literal, since a literal here would just be the constant twice.
   */
  test('dates the config behind the wrangler that has to run it', () => {
    const { compatibility_date: date } = JSON.parse(readFileSync(WRANGLER_CONFIG, 'utf8'));
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, 'a compatibility date is a plain ISO day');
    assert.ok(date < new Date().toISOString().slice(0, 10), `${date} is not behind today — wrangler dev will refuse to start`);
  });

  test('hands the platform a fetch handler, and still exports the app and routes the prerender pass imports', () => {
    assert.equal(typeof worker.fetch, 'function');
    assert.equal(typeof bundle.app?.fetch, 'function');
    assert.ok(Array.isArray(bundle.routes));
  });
});

describe('serving from a Worker', () => {
  test('renders a dynamic page, with the framework baseline headers intact', async () => {
    const res = await fetchWorker('/');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(body.startsWith('<!DOCTYPE html>'), 'a full SSR document');
    assert.equal(res.headers.get('cache-control'), 'private, no-cache');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('serves a prerendered document out of the assets binding', async () => {
    const res = await fetchWorker('/docs/getting-started');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(body.startsWith('<!DOCTYPE html>'));
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.ok(res.headers.get('vary')?.includes('RSC'), 'one URL, two representations');
    assert.match(res.headers.get('etag') ?? '', /^W\//, 'weak: something in front may re-encode the bytes without changing the representation');
  });

  test('serves a percent-encoded slug out of the store the filesystem targets read by name', async () => {
    // One build, one on-disk name, every target: the store is addressed by URL here and by file name
    // elsewhere, and the two used to resolve a non-ASCII slug differently — a hit on Workers and a
    // permanent miss on node, vercel and aws-lambda, from the same `dist/`.
    const res = await fetchWorker('/docs/caf%C3%A9');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300', 'served from the build, not re-rendered');
    assert.match(body, /Café/);
  });

  test('answers the same URL with the prerendered flight payload when asked for one', async () => {
    const res = await fetchWorker('/docs/getting-started', { headers: { RSC: '1' } });
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/x-component/);
    assert.ok(!body.startsWith('<!DOCTYPE'), 'not the document');
  });

  test('revalidates a prerendered page with a 304', async () => {
    const first = await fetchWorker('/docs/getting-started');
    const etag = first.headers.get('etag');
    await first.text();

    const second = await fetchWorker('/docs/getting-started', { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');
  });

  test('does not ask the store for a page the build never prerendered', async () => {
    // Every miss here is a subrequest, and misses are deliberately not cached — so a static route the
    // build wrote nothing for would spend one on every request, forever. The build's manifest is what
    // answers instead; it is fetched once per isolate, which is why it is allowed in the list below.
    const asked = [];
    const counting = { fetch: (request) => (asked.push(new URL(request.url).pathname), ASSETS.fetch(request)) };
    const res = await worker.fetch(new Request(`${ORIGIN}/docs/never-prerendered`), { ASSETS: counting, ...APP_ENV }, {
      waitUntil() {},
      passThroughOnException() {},
    });
    await res.text();

    assert.equal(res.status, 200, 'the route still renders per request');
    assert.equal(res.headers.get('cache-control'), 'private, no-cache', 'rendered, not served from the store');
    const pageReads = asked.filter((p) => p.startsWith('/__ssg/') && !p.endsWith('/manifest.json'));
    assert.deepEqual(pageReads, [], 'the index already says there is no page under that path');
  });

  test('serves a public/ file through the binding', async () => {
    const res = await fetchWorker('/robots.txt');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /User-agent/i);
  });

  test('never serves the prerender tree at its own prefix', async () => {
    const res = await fetchWorker('/__ssg/docs/getting-started/index.html');
    await res.text();
    assert.equal(res.status, 404, 'a page has one URL; the store prefix is not it');
  });

  test('falls back to rendering a static route when there is no binding to read it from', async () => {
    // A deployment that serves its assets some other way must still work: `readPrerendered` finds no
    // binding, reports a miss, and the route renders per request.
    //
    // A second module instance, because the prerender cache lives for the life of one — which models
    // an isolate, where the binding never changes underneath it.
    const isolate = (await importServerBundle('no-binding')).default;
    const res = await isolate.fetch(new Request(`${ORIGIN}/docs/getting-started`), {}, { waitUntil() {} });
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(body.startsWith('<!DOCTYPE html>'));
    assert.equal(res.headers.get('cache-control'), 'private, no-cache', 'rendered, not served from the prerender');
  });
});
