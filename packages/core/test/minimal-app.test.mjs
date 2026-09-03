// Everything except `src/routes.ts` is optional — this app proves it by leaving all of it out: no
// server.ts, no public/, no rshono.config, no notFound page, no error page, and the bare-array
// `defineRoutes` shorthand. The rest of the suite runs against one richly-configured testbed, which
// is exactly the app that would never catch "the framework assumes X exists".
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  // A *document*, not the plain-text line. This app has nothing else to be given — no `error` page —
  // so it is the whole of the "never a blank screen" promise, and a browser handed `text/plain` here
  // would show one bare line where an app with an error page shows a page. The testbed suite pins the
  // other half: an app that declares an `error` page gets it, even for a render failure.
  assert.match(res.headers.get('content-type'), /text\/html/, 'a client that asked for HTML gets a document');
  const body = await res.text();
  assert.match(body, /^<!DOCTYPE html>/);
  assert.match(body, /500 — Internal Server Error/, 'the failure document must carry a visible message');
  assert.doesNotMatch(body, /<noscript>/, 'the message must be visible without disabling JavaScript');
  assert.doesNotMatch(
    body,
    /<script[^>]+src=/,
    'the failed render must not attach the client runtime: there is no payload to hydrate from, and the one from the failed render would tear the document down and blank the message',
  );
  assert.doesNotMatch(body, /blew up on purpose/, 'the real message must stay server-side in production');
});

test('with no error page, a client that did not ask for HTML still gets the plain line', async () => {
  // `*/*` is a fetch, a probe or a health check — the document is for a browser, and this is the same
  // split the plain 404 above already makes.
  const res = await fetch(`${base}/boom`, { headers: { Accept: '*/*' } });
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.equal(res.headers.get('cache-control'), 'private, no-cache');
  assert.match(res.headers.get('vary'), /\bRSC\b/);
  assert.match(await res.text(), /^Internal Server Error$/);
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
  for (const dir of throwaway) rmSync(dir, { recursive: true, force: true });
});

/**
 * The minimal app with `src/routes.ts` replaced, somewhere disposable — a build that must fail, run safely.
 *
 * **Inside the fixture**, not in the OS temp directory, and with no `node_modules` of its own: these two
 * cases run a real Rspack build, and `@rshono/core` is the one package it cannot resolve from the
 * *framework's* `node_modules` — it is reachable only through the app's. Nesting the copy one level down
 * means the resolver walks up and finds the fixture's real `node_modules`, with no link of any kind in the
 * way.
 *
 * That link used to be a Windows-only build failure. A `'junction'` to the fixture's `node_modules` from a
 * temp directory on another volume is not traversed by the bundler's resolver there, so the build died on
 * `Can't resolve '@rshono/core'` before it could reach the validation these cases are about — while
 * `react` and `hono`, which the framework's own `node_modules` answers for, resolved fine and hid the
 * shape of it.
 *
 * The directory is a sibling of `src/`, so nothing that scans the fixture's pages can see it.
 */
function appWithRoutes(routesSource) {
  const dir = mkdtempSync(join(MINIMAL_APP_DIR, 'throwaway-'));
  throwaway.push(dir);
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
  assert.doesNotMatch(
    output,
    /\n\s+at /,
    'and as a line, not an Error object — the three build stages the app can fail go out through `main().catch` too',
  );
});

test("a 'use server' module that cannot be evaluated is a build warning, not a 500 per action", () => {
  // The one part of an app a build never touched. Nothing on the server imports an action module until an
  // action is called — a client component that calls one gets a `createServerReference` stub — so a module
  // that throws as it evaluates used to reach production behind a green build, and then answer 500 for
  // *every* action it holds, which with Rspack's single-module 'use server' graph is all of them.
  const dir = appWithRoutes(HOME_AND("  { path: '/actions', component: () => import('./pages/calls-an-action') },\n"));
  writeFileSync(
    join(dir, 'src', 'actions.ts'),
    "'use server';\n\nthrow new Error('this module cannot be evaluated');\n\nexport async function doThing(): Promise<string> {\n  return 'never';\n}\n",
  );
  writeFileSync(
    join(dir, 'src', 'pages', 'action-button.tsx'),
    "'use client';\n\nimport { doThing } from '../actions';\n\nexport function ActionButton() {\n  return <button onClick={() => void doThing()}>go</button>;\n}\n",
  );
  writeFileSync(
    join(dir, 'src', 'pages', 'calls-an-action.tsx'),
    'import { ActionButton } from \'./action-button\';\n\nexport default function CallsAnAction() {\n  return (\n    <html lang="en">\n      <body>\n        <ActionButton />\n      </body>\n    </html>\n  );\n}\n',
  );

  const { status, output } = runCli(dir, ['build']);
  // A warning, not a failure: a module can legitimately decline to evaluate in a build — one that reads a
  // secret out of the environment, say — and a build is not where that gets decided.
  assert.equal(status, 0, `the build must still succeed:\n${output}`);
  assert.match(output, /the module holding 1 of the app's 1 server action\(s\) could not be loaded at build time — this module cannot be evaluated/);
  assert.match(output, /each of them answers 500/, 'and says what it means at run time, since nothing else will');
});

test('the one required file missing is one line, from `build` and from `dev` alike', () => {
  // `src/routes.ts` is the file this whole fixture exists to say is required, so its absence is the likeliest
  // first-run failure there is — and it used to get the worst output of any of them. The `[rshono]` message
  // was only turned into a line by a `phase()` helper inside `build.ts`, wrapped around three later stages;
  // `createConfigs` raises this one *before* the first of them, and `dev` never had the helper at all. Both
  // fell through to `main().catch`'s bare `console.error(error)` — a raw `Error` object with
  // `at createConfigs` and `at Module.devCommand` under it. That rule now lives in `main().catch` itself.
  //
  // `PORT: '0'` so `dev` cannot stop on the port-in-use branch instead: 0 is always bindable, and this has to
  // fail for the reason under test on any machine.
  const dir = mkdtempSync(join(MINIMAL_APP_DIR, 'throwaway-'));
  throwaway.push(dir);

  for (const command of ['build', 'dev']) {
    const { status, output } = runCli(dir, [command], { env: { PORT: '0' } });
    assert.equal(status, 1, `\`rshono ${command}\` must exit 1:\n${output}`);
    assert.match(output, /✗ \[rshono\] src\/routes\.ts not found/, `\`rshono ${command}\` must name the file that is missing`);
    assert.match(output, /it is the one required file/, 'and say why it matters');
    assert.doesNotMatch(
      output,
      /\n\s+at /,
      `\`rshono ${command}\` must not print a stack — node:internal and framework frames are not the user’s to read`,
    );
  }
});

test('a failure that is not the app’s keeps its stack, because that stack is the report', () => {
  // The other half of the rule: only a `[rshono]`-prefixed message is a message for the user. Anything else
  // is a bug in the framework, and flattening it to one line would throw away the only thing that locates it.
  // A config module that throws is the cheapest way to raise one from inside the CLI's own call path.
  const dir = appWithRoutes(HOME_AND(''));
  writeFileSync(join(dir, 'rshono.config.ts'), "throw new Error('not an rshono message');\n");

  const { status, output } = runCli(dir, ['build']);
  assert.equal(status, 1);
  assert.match(output, /not an rshono message/);
  assert.match(output, /\n\s+at /, 'a framework fault has to keep the frames that say where it came from');
});

test('a src/server.ts that does not default-export a Hono app fails the build, naming the file', () => {
  const dir = appWithRoutes(HOME_AND(''));
  writeFileSync(join(dir, 'src', 'server.ts'), 'export default { notAHono: true };\n');
  const { status, output } = runCli(dir, ['build']);
  assert.equal(status, 1, `the build must not exit 0:\n${output}`);
  assert.match(output, /\[rshono\] src\/server\.ts must `export default` a Hono app/);
  assert.doesNotMatch(output, /Cannot read properties of undefined/, "Hono's own failure names nothing the developer wrote");
  assert.doesNotMatch(output, /\n\s+at /, 'and as a line, not an Error object');
});

/*
 * The other half of the same claim, one level down: the route *table* is checked at load, and until now the
 * modules it points at were only checked on first request. A build could not tell a page that renders from
 * one that can never render, so all four of these exited 0 and then answered 500 in production forever.
 *
 * One build for all four, because the check names every broken route rather than stopping at the first.
 */
test('four route modules that can never serve a request fail the build, naming all four', () => {
  const dir = appWithRoutes(
    `import { defineRoutes } from '@rshono/core';
export const routes = defineRoutes([
  { path: '/', component: () => import('./pages/home') },
  { path: '/clientpage', component: () => import('./pages/clientpage') },
  { path: '/noexport', component: () => import('./pages/noexport') },
  { path: '/static-broken', render: 'static', component: () => import('./pages/noexport') },
  { path: '/api/bad', type: 'endpoint', server: () => import('./api-bad') },
]);
`,
  );
  writeFileSync(join(dir, 'src', 'pages', 'clientpage.tsx'), "'use client';\nexport default function ClientPage() {\n  return <p>nope</p>;\n}\n");
  writeFileSync(join(dir, 'src', 'pages', 'noexport.tsx'), 'export function Page() {\n  return <p>nope</p>;\n}\n');
  writeFileSync(join(dir, 'src', 'api-bad.ts'), "export const GET = () => new Response('nope');\n");

  const { status, output } = runCli(dir, ['build']);
  assert.equal(status, 1, `the build must not exit 0:\n${output}`);
  assert.match(output, /\[rshono\] 4 route modules cannot serve a request:/);
  assert.match(output, /• The page component for "\/clientpage" is missing its client-asset info/);
  assert.match(output, /• The page module for "\/noexport" must default-export a server component\./);
  assert.match(output, /• The page module for "\/static-broken" must default-export a server component\./);
  assert.match(output, /• The endpoint module for "\/api\/bad" must export `handler`/);
  // The endpoint half had no check at all, and this is what it used to say instead.
  assert.doesNotMatch(output, /is not a function/, 'not a TypeError out of a minified frame');
  assert.doesNotMatch(output, /will SSR per request|build complete/, 'and nothing that reads as the build having worked');
});

/*
 * A `render: 'static'` route whose page throws. The structural checks above cannot see this one — the module
 * is shaped correctly and the page only fails when it runs — so the prerender pass is what catches it. It
 * used to be warned about as "will SSR per request", which is true of a 404, a 3xx and a route with no
 * `staticPaths`, and false of a 5xx: that route 500s per request, forever, behind `✓ build complete` and
 * exit 0.
 */
test('a static page that throws at build time fails the build, rather than being called a skip', () => {
  const dir = appWithRoutes(HOME_AND("  { path: '/boom', render: 'static', component: () => import('./pages/boom') },\n"));
  const { status, output } = runCli(dir, ['build']);
  assert.equal(status, 1, `the build must not exit 0:\n${output}`);
  assert.match(output, /\[rshono\] 1 page failed to render while prerendering:/);
  assert.match(output, /• "\/boom" rendered 500/);
  assert.match(output, /minimal app blew up on purpose/, "the page's own error is in the log, from the render that threw");
  assert.doesNotMatch(output, /will SSR per request/, 'because it will not — it will 500 per request');
  assert.doesNotMatch(output, /build complete/);
});

/*
 * The one common mistake the *client* compiler could not explain. `@rshono/core/server` is server-only —
 * `getRequestContext()` is an AsyncLocalStorage lookup — so the browser bundle cannot have it, and the build
 * is right to fail. What it used to fail with was the resolver's report of the first `node:` builtin three
 * modules down: `Reading from "node:async_hooks" is not handled by plugins (Unhandled scheme)`, with no file
 * path, no issuer, and no mention of rshono or of the import that caused it.
 */
test("a 'use client' module importing @rshono/core/server fails the build naming the file, not node:async_hooks", () => {
  const dir = appWithRoutes(HOME_AND("  { path: '/leaky', component: () => import('./pages/leaky') },\n"));
  writeFileSync(
    join(dir, 'src', 'pages', 'leaky.tsx'),
    'import { Widget } from \'./widget\';\nexport default function Leaky() {\n  return (\n    <html lang="en">\n      <body>\n        <Widget />\n      </body>\n    </html>\n  );\n}\n',
  );
  writeFileSync(
    join(dir, 'src', 'pages', 'widget.tsx'),
    "'use client';\nimport { getRequestContext } from '@rshono/core/server';\nexport function Widget() {\n  return <p>{getRequestContext().url.pathname}</p>;\n}\n",
  );

  const { status, output } = runCli(dir, ['build']);
  assert.equal(status, 1, `the build must not exit 0:\n${output}`);
  // Rspack colours its own "ERROR in <file>" line, so the escapes land between the words.
  const plain = output.replaceAll(new RegExp(String.fromCharCode(27) + '\\[\\d+m', 'g'), '');
  assert.match(plain, /ERROR in src[\\/]pages[\\/]widget\.tsx/, 'the path belongs where a reader looks for one');
  assert.match(plain, /\[rshono\] src[\\/]pages[\\/]widget\.tsx imports '@rshono\/core\/server', which the browser bundle cannot have\./);
  assert.match(output, /useNavigation\(\)/, 'and what to use instead');
  assert.doesNotMatch(output, /node:async_hooks|Unhandled scheme/, 'the resolver report names a builtin the author never wrote');
});
