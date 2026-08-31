// Everything except `src/routes.ts` is optional — this app proves it by leaving all of it out: no
// server.ts, no public/, no rshono.config, no notFound page, no error page, and the bare-array
// `defineRoutes` shorthand. The rest of the suite runs against one richly-configured testbed, which
// is exactly the app that would never catch "the framework assumes X exists".
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildApp, MINIMAL_APP_DIR, runCli, startApp, stopServer } from './helpers.mjs';

buildApp(MINIMAL_APP_DIR);
const { base, child, port } = await startApp(MINIMAL_APP_DIR, 'start');
after(() => stopServer(child));

test('an app with only src/routes.ts builds and serves', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /data-page="home"/);
  assert.match(html, /__FLIGHT_DATA/, 'the page still hydrates without any optional file present');
});

test('the ctx page prop works with no config, no server.ts and no imports', async () => {
  const html = await (await fetch(`${base}/`, { headers: { cookie: 'probe=seen' } })).text();
  assert.match(html, /data-ctx-cookie="seen"/, 'ctx.cookies should be readable from the page prop');
  assert.match(html, /data-ctx-method="GET"/);
});

test('the url page prop is a real URL — pathname and query read off it', async () => {
  const html = await (await fetch(`${base}/?q=hello`)).text();
  assert.match(html, new RegExp(`data-url="http://localhost:${port}/\\?q=hello"`), 'url is the absolute browser-facing URL');
  assert.match(html, /data-pathname="\/"/);
  assert.match(html, /data-query="hello"/, 'url.searchParams should be the request query, not an empty set');
});

test('a hand-written "use server-entry" works when the thunk is not inline', async () => {
  const res = await fetch(`${base}/manual`);
  assert.equal(res.status, 200, 'the manual directive must attach client assets on its own');
  const html = await res.text();
  assert.match(html, /data-page="manual"/);
  assert.match(html, /\/_static\/chunks\/main\.[0-9a-f]+\.js/, 'without the directive there would be no bootstrap script');
});

test('a wildcard route matches and sees the full path', async () => {
  const html = await (await fetch(`${base}/files/deep/nested/path`)).text();
  assert.match(html, /data-page="wildcard"/);
  assert.match(html, /data-path="\/files\/deep\/nested\/path"/);
});

test('with no notFound page, an unmatched path is a plain 404', async () => {
  const res = await fetch(`${base}/nothing-here`, { headers: { Accept: 'text/html' } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.match(res.headers.get('vary'), /\bRSC\b/, 'the same URL answers differently per the RSC header');
  // A 404 is heuristically cacheable, and this one is `text/plain` — so it misses the default the framework
  // applies to page content types, and has to carry it itself. A rendered HTML 404 is `private, no-cache`;
  // the same answer to the same request must not promise something else because of who asked.
  assert.equal(res.headers.get('cache-control'), 'private, no-cache');
});

test('with no error page, a thrown page falls back to the framework 500 without leaking the message', async () => {
  const res = await fetch(`${base}/boom`, { headers: { Accept: 'text/html' } });
  assert.equal(res.headers.get('cache-control'), 'private, no-cache', 'the framework’s own answers agree about caching');
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.match(body, /Internal Server Error/);
  assert.doesNotMatch(body, /blew up on purpose/, 'the real message must stay server-side in production');
});

test('the security and caching defaults apply with no config file at all', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('cache-control'), 'private, no-cache');
  assert.match(res.headers.get('vary'), /RSC/);
});

test('with no server.ts there is no CSRF check — that is `csrf()` from hono, and this app has none', async () => {
  // The framework used to run an origin check of its own, configured by `checkOrigin` in
  // rshono.config.ts. It is Hono's `csrf()` now, registered in src/server.ts, which this app does not
  // have — so a cross-origin POST reaches the route rather than being refused. `create-rshono`
  // scaffolds that middleware into every new app; an app hand-written down to routes.ts opts in.
  //
  // No `Sec-Fetch-Site`, so this is a non-browser client: nothing labelled it cross-site, and nothing
  // that cannot be a CSRF victim is refused on an origin header alone.
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'x=1',
  });
  assert.notEqual(res.status, 403, 'nothing in the framework rejects this any more');
});

test('a browser-shaped form post from another origin cannot reach a server action, even with no server.ts', async () => {
  // The one place the framework does refuse: a form post is the only action shape a browser can be made to
  // send from another site — the client-initiated one carries `x-rsc-action`, which needs a preflight it will
  // not get. So this is not a CSRF policy stepping on `csrf()`'s toes; it is the framework declining to run
  // its own action mechanism for a request that mechanism cannot produce. An app *with* src/server.ts has
  // `csrf()` in front of this, which rejects the same request first and for better reasons.
  const post = (headers) =>
    fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: 'x=1',
    });

  const crossSite = await post({ origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);

  // `same-site` is the label a *sibling subdomain* gets — a user-content host, a stale CNAME, a subdomain
  // takeover. It used to be left to `csrf()` on the grounds that a subdomain policy is `csrf()`'s to
  // express, which for an app that has no `csrf()` meant any `'use server'` export could be driven from
  // next door with any arguments.
  const subdomain = await post({ origin: 'https://user-content.evil.test', 'sec-fetch-site': 'same-site' });
  assert.equal(subdomain.status, 403, 'a sibling subdomain is another origin');

  // And the pair a browser never sends — a not-from-here label with the app's own origin — is left alone, or
  // a proxy that sets the label by hand would break every legitimate form post behind it.
  for (const site of ['cross-site', 'same-site']) {
    const sameOrigin = await post({ origin: base, 'sec-fetch-site': site });
    assert.notEqual(sameOrigin.status, 403, `${site} labelled, but posted from the app itself`);
  }

  // Neither the label with no `Origin` at all nor `Origin: null` — a sandboxed iframe, a `data:` URL,
  // `Referrer-Policy: no-referrer` — proves this came from here. A browser attaches an `Origin` to every
  // non-GET request, so neither is a shape one produces; the guard says "proven local" rather than "not
  // proven foreign" so that stays true of it the day something does.
  const noOrigin = await post({ 'sec-fetch-site': 'cross-site' });
  assert.equal(noOrigin.status, 403, 'a cross-site label with no Origin proves nothing');
  const opaque = await post({ origin: 'null', 'sec-fetch-site': 'cross-site' });
  assert.equal(opaque.status, 403, 'an opaque origin is not the app');

  // `same-origin` is the browser's own statement that this came from the app's own pages, and it is
  // unforgeable by page script — so it settles the question whatever `Origin` says. That short-circuit is
  // what keeps a proxy that rewrites `Host` from breaking every legitimate post behind it.
  const genuine = await post({ origin: 'https://rewritten-by-proxy.test', 'sec-fetch-site': 'same-origin' });
  assert.notEqual(genuine.status, 403, 'the browser said this came from the app itself');
});

// What the framework *refuses*, which for this app is the other half of the same claim: `src/routes.ts`
// and `src/server.ts` are the two modules it cannot type-check, so both are validated at load. Each of
// these used to be either a `TypeError` from inside a minified bundle, naming neither rshono nor the file
// the developer has to open, or — for the duplicate path — a clean exit 0 with the second entry dead.
const throwaway = [];
after(() => {
  for (const dir of throwaway) {
    // The link, not what it points at: `node_modules` is the fixture's, borrowed rather than copied.
    unlinkSync(join(dir, 'node_modules'));
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The minimal app somewhere disposable, with `src/routes.ts` replaced — a build that must fail, run safely. */
function appWithRoutes(routesSource) {
  const dir = mkdtempSync(join(tmpdir(), 'rshono-invalid-'));
  throwaway.push(dir);
  symlinkSync(join(MINIMAL_APP_DIR, 'node_modules'), join(dir, 'node_modules'), 'junction');
  cpSync(join(MINIMAL_APP_DIR, 'package.json'), join(dir, 'package.json'));
  cpSync(join(MINIMAL_APP_DIR, 'src', 'pages'), join(dir, 'src', 'pages'), { recursive: true });
  writeFileSync(join(dir, 'src', 'routes.ts'), routesSource);
  return dir;
}

const HOME_AND = (second) =>
  `import { defineRoutes } from '@rshono/core';\nexport const routes = defineRoutes([\n  { path: '/', component: () => import('./pages/home') },\n${second}]);\n`;

test('a second route claiming a path the table already answers fails the build, naming both entries', () => {
  const dir = appWithRoutes(HOME_AND("  { path: '/', component: () => import('./pages/manual') },\n"));
  const { status, output } = runCli(dir, ['build']);
  assert.equal(status, 1, `the build must not exit 0:\n${output}`);
  assert.match(output, /\[rshono\] src\/routes\.ts: routes\[1\] \("\/"\) would never run — routes\[0\] \("\/"\) already answers GET, POST \//);
  assert.doesNotMatch(output, /is not iterable|Cannot read properties/, 'and not by handing over a TypeError from a minified bundle');
});

test('a src/server.ts that does not default-export a Hono app fails the build, naming the file', () => {
  const dir = appWithRoutes(HOME_AND(''));
  writeFileSync(join(dir, 'src', 'server.ts'), 'export default { notAHono: true };\n');
  const { status, output } = runCli(dir, ['build']);
  assert.equal(status, 1, `the build must not exit 0:\n${output}`);
  assert.match(output, /\[rshono\] src\/server\.ts must `export default` a Hono app/);
  assert.doesNotMatch(output, /Cannot read properties of undefined/, "Hono's own failure names nothing the developer wrote");
});
