// Everything except `src/routes.ts` is optional — this app proves it by leaving all of it out: no
// server.ts, no public/, no rshono.config, no notFound page, no error page, and the bare-array
// `defineRoutes` shorthand. The rest of the suite runs against one richly-configured testbed, which
// is exactly the app that would never catch "the framework assumes X exists".
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp, MINIMAL_APP_DIR, startApp, stopServer } from './helpers.mjs';

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
});

test('with no error page, a thrown page falls back to the framework 500 without leaking the message', async () => {
  const res = await fetch(`${base}/boom`, { headers: { Accept: 'text/html' } });
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

test('a browser-shaped cross-site form post cannot reach a server action, even with no server.ts', async () => {
  // The one place the framework does refuse: a form post is the only action shape a browser can be made to
  // send from another site — the client-initiated one carries `x-rsc-action`, which needs a preflight it will
  // not get. So this is not a CSRF policy stepping on `csrf()`'s toes; it is the framework declining to run
  // its own action mechanism for a request that mechanism cannot produce. An app *with* src/server.ts has
  // `csrf()` in front of this, which rejects the same request first and for better reasons.
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'x=1',
  });
  assert.equal(res.status, 403);

  // And the pair a browser never sends — cross-site label, the app's own origin — is left alone, or a proxy
  // that sets the label by hand would break every legitimate form post behind it.
  const sameOrigin = await fetch(`${base}/`, {
    method: 'POST',
    headers: { origin: base, 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'x=1',
  });
  assert.notEqual(sameOrigin.status, 403);
});
