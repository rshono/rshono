// The production build of the testbed, served by `rshono start` and driven over HTTP. Everything the
// framework does that a browser is not required to observe is asserted here; what only exists once
// the client runtime is running lives in test/browser, and the hardened permutations — a CSP, a CSRF
// allowlist, a small body cap, trustProxy — in prod-config.test.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { actionFormData, APP_ENV, buildTestbed, clientChunks, TESTBED_DIST, serverActionId, startTestbed, stopServer } from './helpers.mjs';

buildTestbed();
const { base, child, getOutput } = await startTestbed('start');
after(() => stopServer(child));

/**
 * The two answers one page URL gives: the HTML document a navigation gets, and the flight payload a soft
 * navigation asks for with the `RSC` header. Iterated wherever a behaviour has to hold for both, since a
 * fix that only reaches the document half is the bug prerendering and error pages both used to have.
 */
const REPRESENTATIONS = [
  { name: 'document', headers: {}, contentType: 'text/html' },
  { name: 'flight', headers: { RSC: '1' }, contentType: 'text/x-component' },
];

/** An action-shaped multipart POST body, for requests that are meant to be rejected before it is read. */
function signupBody() {
  const form = new FormData();
  form.set('name', 'evil');
  form.set('email', 'evil@evil.example');
  return form;
}

/**
 * A POST that *declares* an over-cap body without sending one, resolving with the status code.
 *
 * The cap is decided from `Content-Length` before a byte of the body is touched, so sending the body at
 * all is pointless — and actively harmful in a test. An earlier version streamed a real 2MB upload, which
 * meant the server answered 413 and tore the connection down while the write was still in flight: whether
 * that write drained first is a race between the socket buffer and the server, and losing it surfaced as
 * `write EPIPE` on the *client* side. That failure said nothing about the body cap, and it turned up on
 * exactly the runners with different buffer sizes (Linux/Node 24, Windows). Nothing large is sent now, so
 * there is no race to lose.
 *
 * Plain `fetch` cannot express this: it computes `Content-Length` from the body it is handed. Keep-alive
 * is off because this request is abandoned half-sent by design, and a socket in that state must not go
 * back into a pool for a later test to pick up.
 */
function postDeclaringBodyOf(path, declaredBytes) {
  return new Promise((resolve, reject) => {
    const req = request(
      `${base}${path}`,
      {
        method: 'POST',
        agent: new Agent({ keepAlive: false }),
        headers: { 'content-type': 'application/json', 'content-length': String(declaredBytes) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
        // The rest of the declared body is never coming; say so rather than holding the socket open.
        req.destroy();
      },
    );
    req.setTimeout(10_000, () => reject(new Error(`no response to the over-cap POST to ${path} within 10s`)));
    // Only ever reaches the caller before a response: the teardown that follows the 413 is the expected
    // end of this exchange, and the promise has settled by then.
    req.on('error', reject);
    // A token chunk, so the request is genuinely on the wire — the declared length is what is under test.
    req.write('{"name":"');
  });
}

test('home page renders a full SSR document with flight payload and hashed assets', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /rshono/);
  assert.match(html, /__FLIGHT_DATA/);
  assert.match(html, /\/_static\/chunks\/main\.[0-9a-f]+\.js/);
  assert.match(html, /<link rel="stylesheet" href="\/_static\/chunks\/[^"]+\.css"/);
});

test('async server components read the database directly, on a plain and a parameterised route', async () => {
  for (const path of ['/users', '/profile/1']) {
    assert.match(await (await fetch(`${base}${path}`)).text(), /Ada Lovelace/, `${path} did not render its data`);
  }
});

test('soft-navigation requests get a flight payload', async () => {
  const res = await fetch(`${base}/users`, { headers: { RSC: '1' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/x-component/);
  assert.match(await res.text(), /Ada Lovelace/);
});

test('getRequestContext() exposes url/pathname, headers, cookies and env in an async server component', async () => {
  const res = await fetch(`${base}/whoami`, {
    headers: { 'x-test': 'hello-ctx', cookie: 'visitor=ada-cookie' },
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /pathname:.*\/whoami/s, 'ctx.url.pathname was wrong');
  assert.match(html, /hello-ctx/, 'x-test header was not visible to the async server component');
  assert.match(html, /ada-cookie/, 'visitor cookie was not visible to the async server component');
  assert.ok(html.includes(APP_ENV.PUBLIC_API_ENDPOINT), 'ctx.env did not expose the PUBLIC_ variable');
});

// The request context is one of the four boundaries SECURITY.md owns, and every other test of it is
// sequential — so nothing proved that two in-flight requests do not see each other's. `/whoami` is the
// page for it: it awaits before reading the context, so the `AsyncLocalStorage` store has to survive a
// real suspension, and it echoes a request header back into the document.
test('two concurrent requests keep separate request contexts', async () => {
  const marks = Array.from({ length: 8 }, (_, index) => `concurrent-${index}`);
  const documents = await Promise.all(
    marks.map(async (mark) => {
      const res = await fetch(`${base}/whoami`, { headers: { 'x-test': mark, cookie: `visitor=${mark}-cookie` } });
      assert.equal(res.status, 200);
      return { mark, html: await res.text() };
    }),
  );

  for (const { mark, html } of documents) {
    assert.match(html, new RegExp(mark), `${mark}: the response must carry its own header value`);
    assert.match(html, new RegExp(`${mark}-cookie`), `${mark}: …and its own cookie`);
    for (const other of marks.filter((m) => m !== mark)) {
      assert.doesNotMatch(html, new RegExp(`\\b${other}\\b`), `${mark}: another request's context leaked into it (${other})`);
    }
  }
});

test('the ctx page prop is the request context, without importing getRequestContext()', async () => {
  const res = await fetch(`${base}/`, { headers: { cookie: 'visitor=Ada%20Lovelace' } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-ctx="method">(?:<!--[^]*?-->)?GET</, 'ctx.method was not readable from the page prop');
  assert.match(html, /data-ctx="visitor">(?:<!--[^]*?-->)?Ada Lovelace</, 'ctx.cookies was not readable from the page prop');
});

test("a server component's props never reach the browser, so ctx cannot leak through them", async () => {
  // Production React serializes a server component's *output*, not its props — and `ctx` is
  // non-enumerable besides, which is what keeps React's dev-only debug serialization off it too
  // (see `pageProps` in entry.rsc.tsx). Either way the Hono Context must not be on the wire.
  const flight = await (await fetch(`${base}/`, { headers: { RSC: '1', cookie: 'visitor=Ada' } })).text();
  assert.match(flight, /"data-ctx":"visitor","children":"Ada"/, 'the page should have rendered its ctx-derived markup');
  // As a JSON key — the page renders the literal word "ctx" as prose, which is not a leak.
  assert.doesNotMatch(flight, /"ctx":/, 'the ctx prop itself must never be serialized into the payload');
  assert.doesNotMatch(flight, /"props":/, 'production serializes a server component output, never its props');
  assert.doesNotMatch(flight, /newResponse|setRenderer/, 'a serialized Hono Context would carry its own method names');
});

test('redirect() in a server component: an HTTP 3xx on hard navigation, a digest on soft', async () => {
  const hard = await fetch(`${base}/dashboard`, { redirect: 'manual' });
  assert.equal(hard.status, 303);
  assert.match(hard.headers.get('location') ?? '', /\/login$/);

  const soft = await fetch(`${base}/dashboard`, { headers: { RSC: '1' } });
  assert.match(await soft.text(), /RSHONO_REDIRECT/, 'the client needs the digest to follow the redirect itself');
});

test('redirect() from a bare Suspense that settles just before the shell is ready is still a real 3xx', async () => {
  // `/dashboard` above redirects from the page component, so the signal arrives before there is anything to
  // abandon at all. This is the narrow window after that: a bare `<Suspense>` has no `CatchBoundary` to
  // re-throw the signal, so React SSR renders the fallback and the shell resolves — but the section awaits
  // only `Promise.resolve()`, so the signal is recorded before `renderHTML` hands its stream back and the
  // response head is still the framework's to write. It drops the half-built response by aborting the render,
  // cancelling the stream it will not serve, and re-throwing.
  //
  // The window *past* this one — a boundary that resolves later — cannot answer 3xx at all; that is
  // `/late-signal` below.
  const hard = await fetch(`${base}/suspense-redirect`, { redirect: 'manual' });
  assert.equal(hard.status, 303, 'a hard load must still get a real redirect, not a half-rendered document');
  assert.match(hard.headers.get('location') ?? '', /\/login$/);
  assert.doesNotMatch(await hard.text(), /Loading…/, 'and not the Suspense fallback the abandoned render had started');

  const soft = await fetch(`${base}/suspense-redirect`, { headers: { RSC: '1' } });
  assert.equal(soft.status, 200, 'a flight fetch never reaches the SSR half, so the signal rides the payload');
  assert.match(await soft.text(), /RSHONO_REDIRECT/);
});

// The documented limitation, and the two things the framework still owes a request that hits it: the digest
// has to survive, because it is the client's only way back, and the render nobody will read has to stop.
// `/late-signal` waits 50ms before signalling — long past shell-ready — beside a second boundary that takes
// 2s, which is what makes "the render was wound down" observable from outside.
for (const { signal, digest, name } of [
  { signal: null, digest: /RSHONO_REDIRECT;303;%2Flogin/, name: 'redirect()' },
  { signal: 'notfound', digest: /RSHONO_NOT_FOUND/, name: 'notFound()' },
]) {
  test(`${name} from a boundary that resolves after the shell degrades to a 200 carrying the digest`, async () => {
    const logsBefore = getOutput().length;
    const started = Date.now();
    const res = await fetch(`${base}/late-signal${signal ? `?signal=${signal}` : ''}`, { redirect: 'manual' });
    const html = await res.text();
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200, 'the head went out with the shell, and HTTP has no take-backs');
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(html, digest, 'the digest is the client’s only way back — aborting must not cut React off before it');
    assert.match(html, /\$RX/, 'the pending boundaries are client-render instructions, not a truncated document');
    assert.ok(html.trimEnd().endsWith('</body></html>'), 'and the document is closed properly');
    assert.match(html, /data-section="loading"/, 'a visitor without JavaScript is left on the fallback — the limitation, documented in the README');

    // The wind-down, from outside: the second boundary needs 2s, and neither its content nor that wait is here.
    assert.doesNotMatch(html, /the slow section rendered anyway/, 'the render for a page nobody will read must stop');
    assert.ok(elapsed < 1500, `the doomed render should be aborted, not waited out (took ${elapsed}ms)`);

    // The warning that goes with this is for whoever is writing the page, and dev is where they are. It is
    // asserted in dev.test.mjs; here the point is that production says nothing.
    await new Promise((resolve) => setTimeout(resolve, 200)); // the child's stderr reaches us asynchronously
    assert.doesNotMatch(getOutput().slice(logsBefore), /resolved after the page shell/);
  });
}

test('a client-initiated action that redirects answers with a flight payload the runtime navigates on', async () => {
  // The other redirect shape, and the only one that reaches the RSC branch of `respondToControlSignal`.
  // A signal thrown *during* the render rides the payload as an error digest (the test above); one
  // thrown by an action runs before the render begins, escapes to the route handler, and — because the
  // browser is holding a live tree and asked for `text/x-component` — has to come back as a payload
  // carrying `redirect` rather than as a 3xx the fetch would follow behind React's back.
  const res = await fetch(`${base}/dashboard`, {
    method: 'POST',
    headers: {
      Origin: base,
      'x-rsc-action': serverActionId('Logging out'),
      RSC: '1',
      'content-type': 'text/plain;charset=UTF-8',
      cookie: 'session=ada%40example.com',
    },
    body: '[]',
    redirect: 'manual',
  });

  assert.equal(res.status, 200, 'a soft redirect is a 200 carrying the destination, not an HTTP redirect');
  assert.match(res.headers.get('content-type'), /text\/x-component/);
  assert.match(await res.text(), /"redirect":"\/login"/, 'the payload is what tells the client runtime where to go');
  assert.ok(
    res.headers.getSetCookie().some((cookie) => /^session=;/.test(cookie)),
    'the response head is still the action’s to write on the way out, redirect or not',
  );
});

test('a cookie-gated server component renders once the session cookie is present', async () => {
  const res = await fetch(`${base}/dashboard`, { headers: { cookie: 'session=ada%40example.com' } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Signed in as/);
});

test('ctx.var carries a variable set by src/server.ts middleware through to the page', async () => {
  // The sub-app is mounted ahead of the page routes, which is what makes this reachable at all; the
  // page types it by handing its Hono Env to PageProps (see components/dashboard.tsx).
  const html = await (await fetch(`${base}/dashboard`, { headers: { cookie: 'session=ada%40example.com' } })).text();
  const requestId = html.match(/data-ctx="request-id">(?:<!--[^]*?-->)?([0-9a-f-]{36})</)?.[1];
  assert.ok(requestId, `ctx.var.requestId did not reach the page: ${html.match(/data-ctx="request-id"[^<]*</) ?? '(marker absent)'}`);
});

test('notFound() in a server component renders the 404 page', async () => {
  const res = await fetch(`${base}/profile/9999`, { headers: { Accept: 'text/html' } });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /404 — nothing here/);

  // A flight fetch is the other shape, and it is not a 404: `renderComponent` hands the payload stream back
  // before the render can throw, so a `notFound()` from inside a component rides that payload as a digest —
  // the response was committed the moment it was returned. The client runtime turns the digest into a real
  // load, which is the 404 above. Same signal, same page, two ways of getting there.
  const flight = await fetch(`${base}/profile/9999`, { headers: { RSC: '1' } });
  assert.equal(flight.status, 200);
  assert.match(await flight.text(), /RSHONO_NOT_FOUND/, 'the digest is what reaches the client, not a 404 payload');
});

test('an unmatched path renders the notFound page from routes.ts, as a document and as flight', async () => {
  const document = await fetch(`${base}/definitely-not-a-page`, { headers: { Accept: 'text/html' } });
  assert.equal(document.status, 404);
  const html = await document.text();
  assert.match(html, /404 — nothing here/);
  assert.match(html, /__FLIGHT_DATA/, 'the 404 page should hydrate like any page');

  const flight = await fetch(`${base}/definitely-not-a-page`, { headers: { RSC: '1' } });
  assert.equal(flight.status, 404);
  assert.match(flight.headers.get('content-type'), /text\/x-component/);
  const payload = await flight.text();
  assert.match(payload, /nothing here/, 'a soft navigation swaps the 404 page in instead of reloading');
  // The same page for the same status as the `notFound()` path below, so it has to say the same thing about
  // itself: a client cannot tell the 404 page from the page it asked for by looking at the tree.
  assert.match(payload, /"notFound":true/, 'the payload has to declare itself the not-found page');
});

// A `notFound` page that throws is the one failure with nowhere to escalate to: it renders from `onError`
// as well as from the page handler, and Hono calls `onError` inside its own catch — so a throw from there
// used to reject `app.fetch` and be answered by the host with a bodiless 500 that nothing logged.
// `?boom=` makes the testbed's 404 page fail on demand; see components/404.tsx.
test('a notFound page that throws notFound() answers a 404 with a body, and says so in the log', async () => {
  for (const path of ['/definitely-not-a-page', '/profile/9999']) {
    const logsBefore = getOutput().length;
    const res = await fetch(`${base}${path}?boom=notfound`, { headers: { Accept: 'text/html' } });

    assert.equal(res.status, 404, `${path}: still a 404, just without the app's page`);
    assert.equal(await res.text(), 'Not Found', `${path}: a body, not the host's empty 500`);

    await new Promise((resolve) => setTimeout(resolve, 200)); // the child's stderr reaches us asynchronously
    assert.match(getOutput().slice(logsBefore), /the notFound page failed to render/, `${path}: and it is reported`);
  }
});

test('a notFound page that redirects is honoured from both places a 404 is rendered', async () => {
  // Not a failure at all: nothing is committed when the signal arrives, and `app.notFound` has always
  // answered it this way — so the path through the page handler has to agree rather than degrade.
  for (const path of ['/definitely-not-a-page', '/profile/9999']) {
    const res = await fetch(`${base}${path}?boom=redirect`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
    assert.equal(res.status, 303, path);
    assert.match(res.headers.get('location') ?? '', /\/users$/, path);
  }
});

test('non-HTML clients get plain-text 404s, private like the rendered one', async () => {
  const res = await fetch(`${base}/api/definitely-not-an-endpoint`);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'Not Found');
  // `text/plain`, so the default the framework applies to page content types does not reach it — and a 404
  // is heuristically cacheable, so a shared cache is free to store one that says nothing.
  assert.equal(res.headers.get('cache-control'), 'private, no-cache');

  const rendered = await fetch(`${base}/definitely-not-a-page`, { headers: { Accept: 'text/html' } });
  await rendered.text();
  assert.equal(rendered.headers.get('cache-control'), res.headers.get('cache-control'), 'the two 404s must agree');
});

test('useNavigation() gives a client island server-computed pathname/params/searchParams during SSR (no flicker)', async () => {
  const html = await (await fetch(`${base}/profile/1?tab=settings`)).text();
  assert.match(html, /data-nav="pathname">(?:<!--[^]*?-->)?\/profile\/1</, 'useNavigation().pathname was wrong at SSR time');
  assert.match(html, /data-nav="param-id">(?:<!--[^]*?-->)?1</, 'useNavigation().params.id was wrong at SSR time');
  assert.match(html, /data-nav="query-tab">(?:<!--[^]*?-->)?settings</, 'useNavigation().searchParams was wrong at SSR time');
  assert.match(html, /data-nav="pending">(?:<!--[^]*?-->)?no</, 'nothing is navigating during SSR, so pending must be false');
});

test('the navigation URL rides the flight payload so soft navigation stays in sync', async () => {
  const flight = await (await fetch(`${base}/profile/1?tab=settings`, { headers: { RSC: '1' } })).text();
  assert.match(flight, /profile\/1\?tab=settings/, 'the flight payload should carry the URL for the client router');
});

test('the client runtime ships whole, with its dev-only detail compiled out', () => {
  // What the runtime *does* — soft navigation, data-native links, the fatal overlay — is covered in
  // test/browser, where it actually runs. This is the build-level claim underneath it: the pieces reached
  // the bundle, and the dev-only branches did not. `sourceElement` is the Navigation API feature test the
  // whole router is gated on, so its absence would mean a bundle that never soft-navigates at all.
  const sources = clientChunks();
  for (const marker of ['useNavigation() must be called', 'data-native', 'sourceElement', 'data-rshono-fatal']) {
    assert.ok(
      sources.some((source) => source.includes(marker)),
      `the client bundle is missing "${marker}"`,
    );
  }
  assert.ok(
    sources.some((source) => source.includes('the client runtime failed to start')),
    'a bootstrap failure must be reported rather than becoming a silent unhandled rejection',
  );
  assert.ok(
    sources.every((source) => !source.includes('Component stack:')),
    'the dev-only stack rendering must be compiled out of the production bundle',
  );
});

test('a server action can redirect (POST-redirect-GET) and set a cookie without JavaScript', async () => {
  const html = await (await fetch(`${base}/login`)).text();
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { Origin: base },
    body: actionFormData(html, { email: 'ada@example.com' }),
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location') ?? '', /\/dashboard$/);
  assert.ok(
    res.headers.getSetCookie().some((cookie) => /session=/.test(cookie)),
    'the action set a session cookie that should survive the redirect',
  );
});

test('progressive-enhancement form action works without JavaScript', async () => {
  const html = await (await fetch(`${base}/signup`)).text();
  const res = await fetch(`${base}/signup`, {
    method: 'POST',
    headers: { Origin: base },
    body: actionFormData(html, { name: 'NoScript Nancy', email: 'nancy@example.com' }),
  });
  assert.equal(res.status, 200);
  assert.ok(
    res.headers.getSetCookie().some((cookie) => /welcomed=/.test(cookie)),
    'server action cookie (getRequestContext + setCookie) did not reach the response',
  );
  assert.match(await res.text(), /Welcome aboard, NoScript Nancy/);
});

test('client-initiated server action mutates and re-renders', async () => {
  const res = await fetch(`${base}/users`, {
    method: 'POST',
    headers: {
      Origin: base,
      'x-rsc-action': serverActionId('Add user'),
      RSC: '1',
      'content-type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify([{ name: 'Wire Wanda', email: 'wanda@example.com' }]),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/x-component/);
  const payload = await res.text();
  assert.match(payload, /"ok":true/);
  assert.match(payload, /Wire Wanda/);
});

test('endpoint route and Hono sub-app respond with JSON', async () => {
  const health = await (await fetch(`${base}/api/quick-health`)).json();
  assert.equal(health.ok, true);
  const users = await (await fetch(`${base}/api/users`)).json();
  assert.ok(Array.isArray(users.users) && users.users.length >= 3);
});

// The documented choice, pinned so it stays one: a page answers GET, POST and the HEAD that rides the GET,
// and every other method is the notFound page rather than a 405 with an `Allow` header. An endpoint route is
// how an app answers those — see the README's "Requirements & limitations".
test('a method a page route does not answer is a 404, not a 405', async () => {
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    // With the app's own Origin: the testbed registers `csrf()`, which refuses an unsafe method with a
    // foreign one long before the router is reached — a 403 that would say nothing about routing.
    const res = await fetch(`${base}/`, { method, headers: { Accept: 'text/html', Origin: base } });
    await res.text();
    assert.equal(res.status, 404, `${method} on a page`);
    assert.equal(res.headers.get('allow'), null, 'no Allow header is promised, because no 405 is');
  }

  // The way out, and the reason 404 is defensible: an endpoint route answers whatever it registers, and
  // `method` defaults to `all`. `/api/boom` throws by design, so its 500 *is* the proof that it ran.
  const options = await fetch(`${base}/api/boom`, { method: 'OPTIONS', headers: { Origin: base } });
  await options.text();
  assert.equal(options.status, 500, 'an endpoint route with no method of its own answers every one of them');

  // And it can name that method rather than taking every one: `method: 'options'` is how an app answers
  // the CORS preflight a cross-origin action needs, which no page route ever will.
  const preflight = await fetch(`${base}/api/preflight`, { method: 'OPTIONS', headers: { Origin: 'https://admin.example' } });
  await preflight.text();
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://admin.example');

  // …and only that method: the same path asked for as a page is the notFound page.
  const asPage = await fetch(`${base}/api/preflight`, { headers: { Accept: 'text/html' } });
  await asPage.text();
  assert.equal(asPage.status, 404, 'an endpoint that names one method answers only that one');
});

// A HEAD promises the headers its GET would send, so it takes the same path — including the prerendered
// bytes, which is the difference between reading a file and rendering a page it then throws away.
test('a HEAD on a page route answers with the GET head and no body', async () => {
  for (const path of ['/', '/docs/getting-started']) {
    const head = await fetch(`${base}${path}`, { method: 'HEAD' });
    const get = await fetch(`${base}${path}`);
    const body = await get.text();

    assert.equal(head.status, get.status, path);
    assert.equal(await head.text(), '', `${path}: a HEAD carries no body`);
    for (const header of ['content-type', 'cache-control', 'vary', 'etag', 'content-length']) {
      assert.equal(head.headers.get(header), get.headers.get(header), `${path}: ${header} must be what the GET would send`);
    }
    assert.ok(body.length > 0, `${path}: the GET this mirrors is not empty`);
  }
});

// The prerendered half of the same rule, asserted on its own because it is the one that used to render:
// a static route answering a HEAD by rendering it carries no ETag, so a conditional HEAD could never 304.
test('a HEAD on a prerendered route is served from the store, ETag and all', async () => {
  const head = await fetch(`${base}/docs/getting-started`, { method: 'HEAD' });
  assert.match(head.headers.get('cache-control'), /public, max-age=/, 'the prerendered cache policy, not the rendered one');
  const etag = head.headers.get('etag');
  assert.ok(etag, 'a prerendered answer carries its validator');

  const revalidated = await fetch(`${base}/docs/getting-started`, { method: 'HEAD', headers: { 'if-none-match': etag } });
  assert.equal(revalidated.status, 304, 'and that validator has to work');
});

test('an endpoint route answers every method it lists, and nothing else', async () => {
  // `Origin`, because the testbed registers `csrf()`: it refuses an unsafe method with a foreign origin
  // long before the router is reached, and a 403 would say nothing about routing.
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(`${base}/api/session`, { method, headers: { Origin: base } });
    assert.equal(res.status, 200, `${method} is listed, so it must reach the handler`);
    assert.deepEqual(await res.json(), { method }, 'one handler answers both');
  }
  for (const method of ['POST', 'PUT']) {
    const res = await fetch(`${base}/api/session`, { method, headers: { Accept: 'text/html', Origin: base } });
    await res.text();
    assert.equal(res.status, 404, `${method} is not listed, so it must not reach the handler`);
  }
});

test("a HEAD on a method: 'get' endpoint is answered by that handler, bodiless", async () => {
  // Why `HTTPMethod` has no `'head'`: Hono dispatches a HEAD as a GET and strips the body, so `'get'`
  // answers both — and a route registered for HEAD alone answers neither, not even the GET.
  const res = await fetch(`${base}/api/quick-health`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(await res.text(), '', 'a HEAD carries the headers and no body');

  // The framework's own mounts have to hold the same way, now that they register `GET` alone.
  const html = await (await fetch(`${base}/`)).text();
  const chunk = html.match(/src="(\/_static\/chunks\/main\.[0-9a-f]+\.js)"/)[1];
  for (const path of ['/robots.txt', chunk]) {
    const asset = await fetch(`${base}${path}`, { method: 'HEAD' });
    assert.equal(asset.status, 200, `${path} must answer a HEAD`);
    assert.equal(await asset.text(), '', `${path}: a HEAD carries no body`);
  }
});

test('a thrown endpoint renders the error page from routes.ts, redacted, in both representations', async () => {
  for (const { name, headers, contentType } of REPRESENTATIONS) {
    const res = await fetch(`${base}/api/boom`, { headers: { Accept: 'text/html', ...headers } });
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type'), new RegExp(contentType), `${name}: the client must get something it can swap in`);
    const body = await res.text();
    assert.match(body, /Something went wrong/, `${name}: the error page component should render`);
    assert.match(body, /Internal Server Error/, `${name}: the error page shows the generic message`);
    assert.doesNotMatch(body, /Intentional endpoint failure/, `${name}: real error detail must be redacted in prod`);
  }
});

test('a render failure answers with a visible error document, not a blank page', async () => {
  // SSR fails before any of the shell is sent, so the app's `error` page can't be reached — this is
  // the framework's own last-resort 500. It used to put its message inside <noscript>, which meant a
  // normal browser showed nothing at all.
  const res = await fetch(`${base}/crash?render=1`);
  assert.equal(res.status, 500);
  const html = await res.text();
  assert.match(html, /500 — Internal Server Error/, 'the failure document must carry a visible message');
  assert.doesNotMatch(html, /<noscript>/, 'the message must be visible without disabling JavaScript');
  assert.doesNotMatch(
    html,
    /<script[^>]+src=/,
    'the failed render must not attach the client runtime: hydrating a payload from the same failed render would tear the document down and blank the message',
  );
  assert.doesNotMatch(html, /Intentional render failure/, 'prod must not leak the real error into the page');
});

test('a no-JS (progressive-enhancement) action that throws renders the error page', async () => {
  const logsBefore = getOutput().length;
  const html = await (await fetch(`${base}/crash`)).text();
  const res = await fetch(`${base}/crash`, {
    method: 'POST',
    headers: { Accept: 'text/html', Origin: base },
    body: actionFormData(html),
    redirect: 'manual',
  });
  assert.equal(res.status, 500, 'a thrown PE action must not swallow into a blank/redirect response');
  const body = await res.text();
  assert.match(body, /Something went wrong/, 'the error page component must render for a thrown PE action');
  assert.match(body, /Internal Server Error/, 'prod error page shows the generic redacted message');
  assert.doesNotMatch(body, /Intentional server-action failure/, 'the real error detail must be redacted in prod');

  await new Promise((resolve) => setTimeout(resolve, 200)); // the child's stdout reaches us asynchronously
  const logged = getOutput().slice(logsBefore);
  // The two action paths have to agree about what happened. This one is re-thrown so the error page can
  // render, which also carries it into the top-level handler — where, without the reporter de-duplicating,
  // the same fault would arrive a second time as a `request`.
  assert.match(logged, /\[error-reporter\] action \/crash #[^:]+: Intentional server-action failure/, 'a thrown PE action is an action');
  assert.doesNotMatch(logged, /\[error-reporter\] request \/crash/, 'and one fault is reported once, whatever stages it crosses');
});

test('a thrown server action is redacted in the payload, but logged in full server-side', async () => {
  const logsBefore = getOutput().length;
  const res = await fetch(`${base}/users`, {
    method: 'POST',
    headers: { Origin: base, 'x-rsc-action': serverActionId('Add user'), RSC: '1', 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify([{ name: '', email: 'invalid' }]),
  });
  assert.equal(res.status, 500);
  assert.doesNotMatch(await res.text(), /A name and a valid email are required/, 'the client must not be told why');

  await new Promise((resolve) => setTimeout(resolve, 200)); // the child's stderr reaches us asynchronously
  const logged = getOutput().slice(logsBefore);
  assert.match(logged, /server action error/, 'a thrown action must be logged');
  assert.match(logged, /A name and a valid email are required/, 'the real error message must reach the server log — it is the only signal left');
});

// An action and the page it answers with are one response, so a render that fails *after* the action ran
// takes the action's reply with it unless the result is carried across. `/unloadable` is a page whose module
// throws as it evaluates — a chunk that went missing between deploys, from the runtime's side.
test('an action whose page then fails to load still gets its result back', async () => {
  const res = await fetch(`${base}/unloadable`, {
    method: 'POST',
    headers: { Origin: base, 'x-rsc-action': serverActionId('Add user'), RSC: '1', 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify([{ name: 'Drift Dana', email: 'dana@example.com' }]),
  });

  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /text\/x-component/, 'the client is holding a live tree, so the reply is still a payload');
  const payload = await res.text();
  assert.match(payload, /"returnValue":\{"ok":true/, 'the action ran and its result is the caller’s, error page or not');
  assert.match(payload, /Drift Dana/, 'including the value it returned');
  assert.match(payload, /Something went wrong/, 'and the page it comes with is the app’s error page');
});

test('an action request that fails before the action runs answers with a payload carrying no result', async () => {
  // The other half: nothing ran, so there is nothing to carry. What matters is that the reply is still a
  // payload the client can decode — it is what lets the runtime say so, instead of reading `.ok` off it.
  const res = await fetch(`${base}/users`, {
    method: 'POST',
    headers: { Origin: base, 'x-rsc-action': serverActionId('Add user'), RSC: '1', 'content-type': 'text/plain;charset=UTF-8' },
    body: 'not-a-flight-reply',
  });

  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /text\/x-component/);
  const payload = await res.text();
  assert.doesNotMatch(payload, /"returnValue":\{/, 'the action never ran, so no result may be invented for it');
  assert.match(payload, /Something went wrong/);
});

test('onServerError sees the errors the framework catches, tagged by source, without replacing the log', async () => {
  const logsBefore = getOutput().length;

  // A thrown endpoint (reaches the top-level handler) and a thrown server component (fails the
  // render) take completely different paths out of the framework; both must be reported.
  await fetch(`${base}/api/boom`, { headers: { Accept: 'text/html' } });
  await fetch(`${base}/crash?render=1`);
  await new Promise((resolve) => setTimeout(resolve, 200)); // the child's stdout reaches us asynchronously

  const logged = getOutput().slice(logsBefore);
  assert.match(logged, /\[error-reporter\] request \/api\/boom #[^:]+: Intentional endpoint failure/, 'a thrown endpoint must be reported');
  assert.match(logged, /\[error-reporter\] (?:render|ssr) \/crash/, 'a failed render must be reported');
  assert.match(logged, /\[rshono\] request error:/, 'stderr stays the fallback signal even with a reporter wired up');
  // The handler logs from inside `waitUntil` and reads `hono.var.requestId`, so both assertions above also
  // prove the two reach a handler at all — and the `request` one proves it for the source reported outside
  // the ambient context, where `getRequestContext()` throws. That was the whole gap: reporting is what this
  // hook exists for, and on a serverless target a report with nothing holding the invocation open is cut off.
  assert.doesNotMatch(logged, /#undefined/, 'the Hono context must carry the middleware variables, not an empty one');
});

test('<AsyncBoundary> renders its children on the happy path', async () => {
  const res = await fetch(`${base}/boundary`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /data-section="ok"/, 'the async section should resolve and render through the boundary');
});

test('<AsyncBoundary> contains a thrown error locally instead of failing the whole page', async () => {
  const logsBefore = getOutput().length;
  for (const { name, headers, contentType } of REPRESENTATIONS) {
    const res = await fetch(`${base}/boundary?fail=1`, { headers });
    assert.equal(res.status, 200, `${name}: the error is caught by the boundary, not escalated to a 500`);
    assert.match(res.headers.get('content-type'), new RegExp(contentType), `${name}: the client gets a payload it can swap in, not a reload`);
    const body = await res.text();
    assert.match(body, /This section failed to load/, `${name}: the boundary error fallback is delivered to the client`);
    assert.doesNotMatch(body, /Something went wrong/, 'the global error page must NOT be used — the failure stayed local');
  }

  // The server-side account of a contained failure: the real error, once, and nothing else. React
  // reads its own redacted copy of it back out of the flight payload during SSR and — unless the
  // framework installs an `onError` — logs that copy too, which reads like an unhandled crash on a
  // request that went fine, with none of the detail needed to act on it.
  await new Promise((resolve) => setTimeout(resolve, 200)); // the child's stderr reaches us asynchronously
  const logged = getOutput().slice(logsBefore);
  assert.match(logged, /\[rshono\] render error: Error: the section blew up on purpose/, 'a contained failure must still be reported, in full');
  assert.doesNotMatch(logged, /An error occurred in the Server Components render/, "React's redacted duplicate must not be logged as well");
});

test('the build writes both representations of a static route', () => {
  const dir = join(TESTBED_DIST, 'ssg', 'docs', 'getting-started');
  assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /pre-rendered at build time/);
  assert.match(readFileSync(join(dir, 'index.rsc'), 'utf8'), /Getting Started/);
});

test('a slug that has to be percent-encoded is written where the request for it resolves', async () => {
  // The half that used to be missing. The build interpolated the value with `encodeURIComponent` and wrote
  // `docs/caf%C3%A9/`, while Hono hands the handler a `c.req.path` it has already run `decodeURI` over — so
  // the page was reported as prerendered and every request for it silently fell back to SSR, forever.
  const dir = join(TESTBED_DIST, 'ssg', 'docs', 'café');
  assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /pre-rendered at build time/, 'stored under the decoded name');

  for (const { name, headers } of REPRESENTATIONS) {
    const res = await fetch(`${base}/docs/caf%C3%A9`, { headers });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('etag'), `${name}: served from the build, not re-rendered per request`);
    assert.match(res.headers.get('cache-control') ?? '', /public/, `${name}: a prerendered page is publicly cacheable`);
    assert.match(await res.text(), /Café/);
  }
});

test('a prerendered route is served from disk in both representations, publicly cacheable and revalidatable', async () => {
  // Prerendering used to pay off only for cold loads and crawlers: a flight request skipped the built
  // file and re-rendered the page the build had already produced.
  const etags = {};
  for (const { name, headers, contentType } of REPRESENTATIONS) {
    const res = await fetch(`${base}/docs/getting-started`, { headers });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), new RegExp(contentType));
    assert.match(res.headers.get('cache-control') ?? '', /public/, `${name}: a request-independent page should be publicly cacheable`);
    assert.match(await res.text(), /Getting Started/);
    etags[name] = res.headers.get('etag');
    assert.ok(etags[name], `${name}: served from disk, so it can carry a validator`);

    const revalidated = await fetch(`${base}/docs/getting-started`, { headers: { ...headers, 'if-none-match': etags[name] } });
    assert.equal(revalidated.status, 304, `${name}: the client already holds this exact page`);
    assert.equal(await revalidated.text(), '', 'the whole point is not to resend the body');
    assert.match(revalidated.headers.get('cache-control') ?? '', /public/, 'a 304 must repeat the freshness directives');

    const stale = await fetch(`${base}/docs/getting-started`, { headers: { ...headers, 'if-none-match': '"not-the-one"' } });
    assert.equal(stale.status, 200, `${name}: a stale validator must get the current page`);
    await stale.text();
  }
  assert.notEqual(etags.document, etags.flight, 'two representations must not share one validator');
});

test('prerendered pages build absolute URLs from siteUrl; a dynamic page uses the request it got', async () => {
  // A prerendered file is handed to everyone, so its absolute URLs are decided at build time.
  // Without siteUrl they would say http://localhost — in the canonical tag, in og:url, everywhere.
  const html = await (await fetch(`${base}/docs/getting-started`)).text();
  assert.match(html, /<link rel="canonical" href="https:\/\/rshono\.example\/docs\/getting-started"\/?>/);
  assert.doesNotMatch(html, /http:\/\/localhost/, 'the build-time origin must not survive into a shipped page');

  const flight = await (await fetch(`${base}/docs/getting-started`, { headers: { RSC: '1' } })).text();
  assert.match(flight, /https:\/\/rshono\.example\/docs\/getting-started/, 'useNavigation() reads the URL from this payload');
  assert.doesNotMatch(flight, /http:\/\/localhost/);

  const dynamic = await (await fetch(`${base}/whoami`)).text();
  assert.doesNotMatch(dynamic, /rshono\.example/, 'siteUrl is a build-time concern only');
  assert.match(dynamic, /localhost/, 'a dynamic page reflects the request it actually received');
});

test('dynamic pages are never stored by a shared cache, and vary on RSC', async () => {
  // Same URL, two representations: a shared cache keyed on the URL alone would otherwise be free to
  // hand an HTML document to a soft navigation asking for flight — or one user's page to another.
  //
  // `RSC` rather than `Accept`, which this used to vary on: browsers send long `Accept` strings that differ
  // by vendor and version, so a CDN keyed on one stores a copy per variant of identical bytes. This header
  // has two states, which is what makes the prerendered page's `public, max-age=300` mean anything.
  for (const { name, headers } of REPRESENTATIONS) {
    const res = await fetch(`${base}/whoami`, { headers: { ...headers, cookie: 'visitor=someone' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-cache', `${name}: a personalised page must not be publicly cacheable`);
    assert.match(res.headers.get('vary'), /\bRSC\b/, `${name}: the negotiated header must be declared`);
    assert.doesNotMatch(res.headers.get('vary'), /\bAccept\b/, `${name}: and not the high-cardinality one it replaced`);
  }
});

test('a route that sets its own cache-control keeps it', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.headers.get('cache-control'), null, 'endpoint routes are raw Hono — the page default must not bleed into them');
});

test('responses are not compressed — that is a proxy or CDN’s job now', async () => {
  const res = await fetch(`${base}/users`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.headers.get('content-encoding'), null, 'the framework ships no compressor');
  assert.match(await res.text(), /Ada Lovelace/);
});

test('conventional root files in public/ are served at the web root', async () => {
  assert.match(
    readFileSync(join(TESTBED_DIST, 'public', 'robots.txt'), 'utf8'),
    /User-agent/,
    'public/ is copied into dist, so the build is self-contained',
  );

  const robots = await fetch(`${base}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  assert.match(await robots.text(), /User-agent: \*/);
  assert.equal(robots.headers.get('cache-control'), 'public, max-age=300', 'public files are short-lived, not immutable');

  const favicon = await fetch(`${base}/favicon.svg`);
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await (await fetch(`${base}/`)).text(), /<link rel="icon" href="\/favicon\.svg"/, 'and the layout links one');
});

test('unknown root paths fall through to a 404 — the public fallback never shadows routing', async () => {
  const res = await fetch(`${base}/does-not-exist.txt`);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'Not Found');
});

test('hashed static assets are served immutable, and a miss under /_static is not cacheable at all', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const src = html.match(/src="(\/_static\/chunks\/main\.[0-9a-f]+\.js)"/)[1];
  const res = await fetch(base + src);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  // The asset that is *not* there, which is the one a rolling deploy produces: an old instance 404s a chunk
  // the new one has. A 404 is heuristically cacheable under RFC 9111, so with no header of its own a shared
  // cache may store that answer against a content-hashed URL that is about to become valid — and then serve
  // it to everyone. The same reasoning is why the framework's own plain 404 carries one.
  const miss = await fetch(`${base}/_static/chunks/main.deadbeefdeadbeef.js`);
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get('cache-control'), 'private, no-cache', 'a 404 for a hashed URL must not be stored');
});

test('baseline security headers are set on every response', async () => {
  for (const path of ['/', '/api/health', '/favicon.ico']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${path} is missing nosniff`);
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', `${path} is missing referrer-policy`);
    // CSP is opt-in, so without this there is no framing protection at all by default.
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', `${path} is missing x-frame-options`);
  }
});

test('secrets never reach the browser — not in the HTML, the flight payload, or a client chunk', async () => {
  const html = await (await fetch(`${base}/`)).text();
  // `leak-helper.ts` reaches the env three ways and never once by the dotted spelling the shadow used to be
  // gated on — `process?.env`, `process['env']` and an alias. Each of them rendered the real value here while
  // the browser bundle saw the `PUBLIC_`-only view; the loader unit tests hold the whole table.
  assert.match(html, /Using leak helper:\s*(?:<!--\s*-->)?\(no secret\)/, 'no-directive helper leaked a real secret into SSR HTML');
  assert.ok(!html.includes(APP_ENV.DATABASE_URL), 'DATABASE_URL value must not appear in SSR HTML');
  assert.ok(html.includes(APP_ENV.PUBLIC_API_ENDPOINT), 'the PUBLIC_ variable should be inlined');

  // The same guarantee for a `'use client'` component that came out of `node_modules` rather than `src/`.
  // Worth its own assertion because it used to fail here and nowhere else: on the `node` target a third-party
  // dependency stays external, so the module was loaded raw at request time and read the *real* `process.env`
  // while the browser bundle saw the `PUBLIC_`-only view — a secret in the HTML stream, and a hydration
  // mismatch on anything else the host sets.
  assert.match(html, /external secret: \(no secret\)/, 'a node_modules client component must be SSR-rendered against the shadowed env');
  assert.match(html, /external public: public dummy url/, 'while PUBLIC_ values still reach it');

  const flight = await (await fetch(`${base}/`, { headers: { RSC: '1' } })).text();
  assert.ok(!flight.includes(APP_ENV.DATABASE_URL), 'DATABASE_URL value must not appear in the flight payload');

  const sources = clientChunks();
  assert.ok(
    sources.every((source) => !source.includes(APP_ENV.DATABASE_URL)),
    'DATABASE_URL value leaked into a client asset',
  );
  assert.ok(
    sources.every((source) => !source.includes('listDocs')),
    'db module code leaked into a client asset',
  );
  assert.ok(
    sources.some((source) => source.includes(APP_ENV.PUBLIC_API_ENDPOINT)),
    'PUBLIC_API_ENDPOINT was not inlined',
  );
});

test('no unguarded reference to process survives into the client bundle', () => {
  // The env substitution replaces the exact expression `process.env` and nothing else, so any *other* member
  // read off `process` compiles to a live reference — and in a browser there is no `process`, so the component
  // throws `ReferenceError: process is not defined` the moment it renders.
  //
  // This is a hole the rest of the suite cannot see. Every other env assertion is made against SSR output,
  // where `process` is real and the same code works fine; only a browser notices, and the Playwright suite is
  // the one part of this project that cannot run everywhere. It is checked here instead, on the minified
  // production chunks — minified because comments are gone by then, so a mention of `process.env` in prose
  // cannot be mistaken for a read.
  //
  // React's `reportError` fallback is the one legitimate hit: it reaches `process.emit`, but only behind
  // `typeof process === 'object'`, which is safe for an undeclared identifier. Anything new here is either a
  // bug of this shape or a second guarded case — decide which, then add it.
  const allowed = new Set(['emit']);
  const found = new Map();
  for (const source of clientChunks()) {
    for (const [, member] of source.matchAll(/process\.([A-Za-z_$][\w$]*)/g)) {
      if (!allowed.has(member)) found.set(member, (found.get(member) ?? 0) + 1);
    }
  }
  assert.deepEqual(
    [...found.keys()],
    [],
    `process.${[...found.keys()].join(', process.')} reaches the browser, where \`process\` does not exist — ` + 'only `process.env` is substituted',
  );
});

test('the server bundle ships a source map and the client bundle does not', () => {
  // The asymmetry is the whole decision. A server map never leaves the server and is what turns the
  // `onServerError` funnel — the error-tracker integration — from minified frames into real ones. A client map
  // is served from `/_static` like everything beside it, and would publish the original source of the app's
  // own modules to anyone who asked.
  const bundle = readFileSync(join(TESTBED_DIST, 'server', 'main.mjs'), 'utf8');
  assert.match(bundle, /\/\/# sourceMappingURL=main\.mjs\.map\s*$/, 'the minified bundle has to point at its map');
  assert.ok(readFileSync(join(TESTBED_DIST, 'server', 'main.mjs.map'), 'utf8').length > 0, 'and the map has to be emitted beside it');

  const clientMaps = readdirSync(join(TESTBED_DIST, 'static', 'chunks')).filter((file) => file.endsWith('.map'));
  assert.deepEqual(clientMaps, [], 'a client source map would publish the app’s own source');
});

test('a production stack trace maps to the original TypeScript with no Node flag passed', async () => {
  // Started the way a serverless host starts it — `node dist/server/main.mjs`, no CLI and no
  // `--enable-source-maps` — because that is the case the flag cannot cover: Vercel and Lambda spawn the
  // process themselves and pass nothing of ours. What makes it work is the runtime calling
  // `process.setSourceMapsEnabled(true)` as it loads. Without both halves this reports minified frames to
  // whatever `onServerError` forwards them to, which is the reason anyone wires it up.
  const child = spawn(process.execPath, [join(TESTBED_DIST, 'server', 'main.mjs')], {
    env: { ...process.env, ...APP_ENV, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the bundle did not start:\n${output}`)), 30_000);
      const check = () => {
        const match = output.match(/serving on http:\/\/[^:]+:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      child.stdout.on('data', check);
      child.stderr.on('data', check);
      child.on('exit', (code) => reject(new Error(`the bundle exited early (${code}):\n${output}`)));
    });

    await (await fetch(`http://localhost:${port}/api/boom`, { headers: { Accept: 'text/html' } })).text();
    // The child's stderr reaches us asynchronously.
    for (let waited = 0; waited < 3000 && !/boom\.ts/.test(output); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(output, /src[\\/]boom\.ts:\d+:\d+/, 'the frame must name the TypeScript source, not main.mjs');
  } finally {
    await stopServer(child);
  }
});

// `csrf()` from hono, registered in the testbed's src/server.ts. The framework has no origin check
// of its own any more; what is asserted here is that Hono's covers the shapes a server action
// actually arrives in — `text/plain` for a client-initiated call, `multipart/form-data` for a no-JS
// form post — since it deliberately ignores content types a browser cannot send cross-origin.
test('an action POST that cannot be shown to be same-origin is rejected (CSRF)', async () => {
  const cases = [
    { name: 'a form POST from another origin', path: '/signup', headers: { Origin: 'https://evil.example' }, body: signupBody() },
    {
      name: 'a client action call from another origin',
      path: '/users',
      headers: { Origin: 'https://evil.example', 'x-rsc-action': 'whatever', 'content-type': 'text/plain' },
      body: '[]',
    },
    { name: 'no Origin at all, but a cross-site Sec-Fetch-Site', path: '/signup', headers: { 'sec-fetch-site': 'cross-site' }, body: signupBody() },
    {
      // The forwarded host used to be one of the values Origin was compared against, so sending both
      // made a cross-site POST look same-origin. Without `trustProxy` the header is ignored outright.
      name: 'a forged X-Forwarded-Host',
      path: '/signup',
      headers: { Origin: 'https://evil.example', 'x-forwarded-host': 'evil.example', 'sec-fetch-site': 'cross-site' },
      body: signupBody(),
    },
  ];

  for (const { name, path, headers, body } of cases) {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers, body });
    await res.text();
    assert.equal(res.status, 403, `${name} should have been rejected`);
  }
});

test('X-Forwarded-Host cannot poison the public request URL without trustProxy', async () => {
  const flight = await (
    await fetch(`${base}/whoami`, {
      headers: { RSC: '1', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
    })
  ).text();
  assert.doesNotMatch(flight, /evil\.example/, 'a client-supplied forwarded host reached the URL the app builds');
  assert.match(flight, new RegExp(base.replace('http://', '')), 'the real request host should be used instead');
});

test('a browser-asserted same-origin Sec-Fetch-Site is trusted without a host comparison', async () => {
  // Sec-Fetch-Site is set by the browser and unforgeable by page script, so it settles the question
  // on its own. That short-circuit is what stops the check 403ing legitimate actions behind a proxy
  // that rewrites Host — modelled here by an Origin that deliberately doesn't match.
  const res = await fetch(`${base}/users`, {
    method: 'POST',
    headers: {
      Origin: 'https://rewritten-by-proxy.example',
      'sec-fetch-site': 'same-origin',
      'x-rsc-action': 'not-a-real-action-id',
      'content-type': 'text/plain',
    },
    body: '[]',
  });
  assert.equal(res.status, 400, 'should clear the CSRF gate and fail on the unknown action id instead');
});

test('an action id the app does not export is a 400, not a fault or a prototype lookup', async () => {
  const logsBefore = getOutput().length;
  for (const id of ['not-a-real-action-id', '__proto__']) {
    const res = await fetch(`${base}/users`, {
      method: 'POST',
      headers: { Origin: base, 'x-rsc-action': id, 'content-type': 'text/plain' },
      body: '[]',
    });
    await res.text();
    assert.equal(res.status, 400, `"${id}" must be rejected as a bad request`);
  }
  assert.doesNotMatch(getOutput().slice(logsBefore), /TypeError/, 'an unknown action id must not fault into a stack trace');
});

test('the body-size cap covers endpoint routes and the server sub-app, not just actions', async () => {
  // What is under test is the *coverage* — that a plain Hono route in src/server.ts sits behind the same
  // `bodyLimit()` as a server action, because it is registered as middleware ahead of both. Its two
  // mechanisms (a declared length, and the streaming counter for a chunked body) are asserted against a
  // small cap in prod-config.test.mjs.
  const status = await postDeclaringBodyOf('/api/users', 2 * 1024 * 1024);
  assert.equal(status, 413, 'a 2MB body declared to a sub-app route should be refused by the 1MiB default cap');
});
