// `rshono dev`, which is a front-end proxy in front of a worker process that owns the compilers. That
// indirection is what these test: everything has to arrive at the browser as if it were served
// directly, and dev is also where React's debug channel is live and can leak what prod never would.
import assert from 'node:assert/strict';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runCli, startTestbed, stopServer, TESTBED_DEV_DIR, TESTBED_DIR } from './helpers.mjs';

// Served under the testbed's hardened profile, so the dev-only half of the CSP contract is covered
// here: the app writes one policy for both environments and the framework widens it for React Refresh.
const { base, child, port, getOutput } = await startTestbed('dev', { timeoutMs: 90_000, env: { TESTBED_CSP: '1' } });
after(() => stopServer(child));

// A `redirect()` from a boundary that resolves after the shell cannot become a 3xx — the response is
// already committed (see the README's "Requirements & limitations"). The fix is in app code, so the
// framework says so where the app is being written. Production stays silent; prod.test.mjs asserts that.
test('dev warns when a control signal arrives after the page shell has been sent', async () => {
  const logsBefore = getOutput().length;
  const res = await fetch(`${base}/late-signal`, { redirect: 'manual' });
  await res.text();
  assert.equal(res.status, 200, 'the degradation itself is the documented behaviour');

  await new Promise((resolve) => setTimeout(resolve, 300)); // the child's stderr reaches us asynchronously
  const logged = getOutput().slice(logsBefore);
  assert.match(logged, /resolved after the page shell had already been sent/, 'the author has to be told');
  assert.match(logged, /GET \/late-signal/, 'and which request it was');
  assert.match(logged, /middleware/, 'and where the decision belongs instead');
});

test('dev serves both representations of a page through the worker proxy', async () => {
  const document = await fetch(`${base}/`);
  assert.equal(document.status, 200);
  const html = await document.text();
  assert.match(html, /__FLIGHT_DATA/);
  assert.match(html, /\/_static\/chunks\/main\.js/, 'dev assets are unhashed, so a reload picks up a rebuild');

  const flight = await fetch(`${base}/users`, { headers: { RSC: '1' } });
  assert.equal(flight.status, 200);
  assert.match(flight.headers.get('content-type'), /text\/x-component/);
});

test('dev resolves the browser-facing URL through the proxy, not the worker address', async () => {
  // `trustProxy` is off by default but forced on in dev, because the dev front-end proxies to a
  // worker on a random localhost port and X-Forwarded-Host is the only thing that knows the real
  // one. Without it every page would see the internal 127.0.0.1:<worker> address.
  const flight = await (await fetch(`${base}/whoami`, { headers: { RSC: '1' } })).text();
  assert.match(flight, new RegExp(`http://localhost:${port}/whoami`), 'the page URL should be the address the browser used');
  assert.doesNotMatch(flight, /127\.0\.0\.1/, 'the internal worker address must not leak into the page URL');
});

test('dev does not serialize the ctx page prop into the flight payload', async () => {
  // Dev is the case that needs guarding: React's debug channel puts a server component's props on
  // the wire (that is what the `"props":` row below is), walking own *enumerable* properties. `ctx`
  // is defined non-enumerable precisely so it is skipped — an enumerable one would ship the whole
  // Hono Context, `c.env` bindings and all, to the browser and add >10 kB to every page.
  const flight = await (await fetch(`${base}/`, { headers: { RSC: '1', cookie: 'visitor=Ada' } })).text();
  assert.match(flight, /"props":\{[^{}]*"url"/, 'dev really does serialize page props — this test is only meaningful while it does');
  // As a JSON key — the home page renders the literal word "ctx" as prose, which is not a leak.
  assert.doesNotMatch(flight, /"ctx":/, 'the ctx prop must stay out of the dev debug payload');
  assert.doesNotMatch(flight, /newResponse|setRenderer|HtmlEscapedCallbackPhase/, 'a serialized Hono Context would carry its own internals');
  assert.match(flight, /data-ctx/, 'the page should still have rendered its ctx-derived markup');
});

test("dev widens the app's own script-src with 'unsafe-eval', which React Refresh needs", async () => {
  // The app's `secureHeaders()` policy says nothing about eval — see the same policy asserted
  // *without* it in prod-config.test.mjs. React Refresh compiles updates with eval, so a policy that
  // worked in production would break HMR; the framework adds it here rather than making every app
  // remember to branch on the environment.
  const res = await fetch(`${base}/`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'the app registered a CSP, so dev should carry it too');
  assert.match(csp, /script-src 'unsafe-eval'/, 'dev must widen script-src for React Refresh');
  assert.match(csp, /'nonce-[^']+'/, 'and the nonce Hono minted must survive the widening');

  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.ok((await res.text()).includes(`nonce="${nonce}"`), 'the nonce should reach the rendered scripts in dev too');
});

test("csrf() works through the dev server's own proxy, in both directions", async () => {
  // The dev server fronts the app on one port and proxies to a worker on another, and `csrf()`
  // compares `Origin` against `c.req.url` — the address the *worker* was reached on. That only lines
  // up because the proxy forwards the browser's `Host` header along, so both halves are asserted
  // here: a forged origin is refused, and a genuine same-origin post is not.
  const post = (headers) => fetch(`${base}/signup`, { method: 'POST', headers, body: new FormData() });

  const forged = await post({ Origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(forged.status, 403, 'a cross-origin action must be rejected in dev too');

  const genuine = await post({ Origin: base, 'sec-fetch-site': 'cross-site' });
  await genuine.text();
  assert.notEqual(genuine.status, 403, "the app's own origin must survive the dev proxy's extra hop");
});

test('a render failure shows the real error and stack in dev', async () => {
  const res = await fetch(`${base}/crash?render=1`);
  assert.equal(res.status, 500);
  const html = await res.text();
  // The dev-only copy, which appears nowhere else — asserting on the error message alone would also
  // match the flight payload, which carries it in dev whether or not the document rendered it.
  assert.match(html, /Server-side rendering failed before the page shell/, 'dev should explain what failed');
  assert.match(html, /<pre[^>]*>Error: Intentional render failure/, 'dev should render the real message and stack');
});

test('public/ files are served at the web root in dev (through the worker proxy)', async () => {
  const res = await fetch(`${base}/robots.txt`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /User-agent: \*/);
  assert.equal(res.headers.get('cache-control'), 'no-cache', 'dev serves public assets without caching');
});

test('a second dev server refuses the port instead of wiping the first one’s output', async () => {
  // `rshono dev` empties its output directory as its first action, so a second one started against a
  // running server used to delete the chunks that server imports lazily, at request time, and only
  // *then* exit on EADDRINUSE. The first server was left serving a build no longer on disk — 500s on
  // every route it had not already loaded, 404 on the client bundle — and its watcher never re-emits
  // them, because it compares against what it believes it wrote rather than against the disk.
  //
  // So the exit code proves nothing on its own: the unguarded version exited 1 too, just after doing
  // the damage. What is asserted is that the first server is untouched.

  // A request parks until the first build has landed, so this is also what makes the listing below
  // meaningful: `rshono dev` reports its address as soon as it is listening, which is before the
  // compilers have written anything.
  assert.equal((await fetch(`${base}/`)).status, 200);
  // Tolerating ENOENT so the damage arrives as a diff against the assertion below rather than as a
  // bare throw: the unguarded version deletes the directory outright, it does not merely change it.
  const chunks = join(TESTBED_DEV_DIR, 'server', 'chunks');
  const listChunks = () => {
    try {
      return readdirSync(chunks);
    } catch {
      return [];
    }
  };
  const before = listChunks();
  assert.ok(before.length > 0, 'the running dev server should have route chunks on disk to protect');

  const second = runCli(TESTBED_DIR, ['dev'], { env: { PORT: String(port) } });
  assert.equal(second.status, 1, `a second dev server on port ${port} should refuse to start:\n${second.output}`);

  assert.deepEqual(listChunks(), before, "the running server's route chunks must all survive");
  assert.equal((await fetch(`${base}/boundary`)).status, 200, 'a route the first server had not yet imported must still load');
  assert.equal((await fetch(`${base}/_static/chunks/main.js`)).status, 200, 'and the browser must still get its bundle');
  // Last, so a reworded refusal fails on its wording and not before the invariants above are checked.
  assert.match(second.output, /port \d+ is already in use/, 'the refusal should say so, not crash on EADDRINUSE');
});

test('HMR SSE channel greets with the current build hash', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/_rshono/hmr`, { signal: controller.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /"type":"hello"/);
  controller.abort();
});

/*
 * `.env` and `rshono.config.ts` are read once, at startup, and what a build needs from them is compiled in —
 * so a rebuild cannot pick up an edit to either, and the failure is invisible: the page rebuilds, is served,
 * and shows the old value. Watching them to say "restart" is the whole of the fix; reloading them for real
 * means re-exec'ing the process, since `process.loadEnvFile` will not override a variable already set.
 *
 * Written as `rshono.config.js` rather than `.env`: the testbed's `.env` is a contributor's own file and must
 * not be clobbered, and this name cannot collide — `loadConfig` prefers the `.ts` that is already there, so
 * even a leftover would change nothing.
 */
test('dev says a change to a file it compiled in needs a restart', async () => {
  const marker = join(TESTBED_DIR, 'rshono.config.js');
  const logsBefore = getOutput().length;
  try {
    writeFileSync(marker, 'export default {};\n');
    await new Promise((resolve) => setTimeout(resolve, 500)); // the watcher event, then the child's stderr
  } finally {
    rmSync(marker, { force: true });
  }
  const logged = getOutput().slice(logsBefore);
  assert.match(logged, /rshono\.config\.js changed/, 'the file has to be named');
  assert.match(logged, /restart `rshono dev`/, 'and what to do about it');
  assert.match(logged, /compiled into the build, not read per request/, 'and why a rebuild did not do it');
});
