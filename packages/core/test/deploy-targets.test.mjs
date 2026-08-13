// The two serverless targets, built for real and then called the way their platform calls them.
//
// What is unique per target is the handoff (what the entry's default export has to be) and the output
// layout a `finalize` hook assembles — so that is what this asserts. The request handling underneath is
// the same code the Node and Workers suites already cover end to end.
//
// `node` and `cloudflare` are not here: they have suites of their own. Bun and Deno have no preset —
// they run the `node` build — and asserting on its export shape under Node would prove nothing about
// either runtime.
//
// One build per target, so this is a slow file. Nothing else depends on it.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildApp, importServerBundle, TESTBED_DIR, TESTBED_DIST } from './helpers.mjs';

const ORIGIN = 'https://rshono.example';

/**
 * Proves the emitted server output can run where nothing installed it — which is what a serverless
 * deployment is: an uploaded directory, with no `node_modules` for an externalized `import 'some-package'`
 * to resolve against. This is what `bundleDependencies` in the presets exists to satisfy, and it is the one
 * failure no assertion on the output *layout* can see: with the default externals policy in place, the
 * import below throws `ERR_MODULE_NOT_FOUND` exactly as a cold start would.
 *
 * Copied somewhere with no `node_modules` above it rather than parsed, because the question is whether Node
 * can resolve the graph — and a page is rendered through it because route chunks load lazily, so a broken
 * specifier inside one would survive module evaluation.
 */
async function assertSelfContained() {
  const sandbox = mkdtempSync(join(tmpdir(), 'rshono-self-contained-'));
  try {
    // The runtime derives the project root from where the bundle sits, so the two levels are load-bearing.
    cpSync(join(TESTBED_DIST, 'server'), join(sandbox, 'dist', 'server'), { recursive: true });
    const bundle = await import(pathToFileURL(join(sandbox, 'dist', 'server', 'main.mjs')).href);

    // The testbed reads this out of an ordinary `node_modules` dependency, which is the case the default
    // externals policy gets wrong: the package the framework bundles unconditionally would resolve here
    // whether it was bundled or not, so proving the fix takes a package that would not.
    const dependency = await bundle.app.fetch(new Request(`${ORIGIN}/api/external-dep`));
    assert.equal(await dependency.text(), 'resolved-without-node-modules');

    const page = await bundle.app.fetch(new Request(`${ORIGIN}/`));
    assert.equal(page.status, 200, 'a page renders, so its route chunk resolved too');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Builds the testbed for one target and returns its bundle, freshly evaluated. */
async function buildFor(target) {
  buildApp(TESTBED_DIR, { args: ['--deploy', target] });
  // The target names the cache key, so each build is a distinct module rather than the previous one.
  return importServerBundle(target);
}

/** What `rshono build` recorded about the build now on disk — what `rshono start` reads to refuse one. */
function buildMarker() {
  return JSON.parse(readFileSync(join(TESTBED_DIST, 'rshono-build.json'), 'utf8'));
}

/**
 * Drives a Node request listener the way Vercel's `Nodejs` launcher drives one — through a real HTTP server,
 * so the handler is handed an actual `IncomingMessage`/`ServerResponse` pair.
 *
 * A synthetic `new Request(...)` is what this used to pass, and it is precisely the shape the platform never
 * sends: it made a handler that only ever forwarded a web `Request` look correct, while every real request
 * hit `e.headers.get is not a function`. Going through `createServer` means the test cannot assert its own
 * assumption back to itself.
 */
async function requestViaNodeListener(listener, path, headers = {}) {
  const server = createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
    return { res, body: await res.text() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('vercel', () => {
  let bundle;
  const output = join(TESTBED_DIR, '.vercel', 'output');
  const functionDir = join(output, 'functions', 'index.func');

  before(async () => {
    bundle = await buildFor('vercel');
  });

  test('exports a Node request listener and renders through it', async () => {
    assert.equal(buildMarker().deploy, 'vercel');
    assert.equal(typeof bundle.default, 'function');
    const { res, body } = await requestViaNodeListener(bundle.default, '/');
    assert.equal(res.status, 200);
    assert.ok(body.startsWith('<!DOCTYPE html>'));
  });

  test('gives the app the scheme the browser used, not the one the socket saw', async () => {
    // The platform terminates TLS at the edge and reaches the function over plain HTTP, so the socket says
    // `http` for every request — including the ones a browser made to `https`. Left uncorrected, `c.req.url`
    // is an origin the app then redirects to and compares against.
    //
    // Only the scheme is asserted, not a whole expected URL: `Host` is a forbidden header name for `fetch`,
    // so the host here is always the loopback address the test server happens to be on.
    const forwarded = await requestViaNodeListener(bundle.default, '/api/request-url', { 'x-forwarded-proto': 'https' });
    assert.equal(new URL(forwarded.body).protocol, 'https:');
    assert.equal(new URL(forwarded.body).pathname, '/api/request-url');

    // No header at all still means `https`: it is the only scheme a deployment is reachable on, and the
    // alternative — falling back to what the socket says — is the bug above on every request.
    const bare = await requestViaNodeListener(bundle.default, '/api/request-url');
    assert.equal(new URL(bare.body).protocol, 'https:');

    // Honoured in the other direction too, rather than pinned to `https` outright.
    const plain = await requestViaNodeListener(bundle.default, '/api/request-url', { 'x-forwarded-proto': 'http' });
    assert.equal(new URL(plain.body).protocol, 'http:');
  });

  test('splits the build the way the platform routes it', () => {
    assert.ok(existsSync(join(output, 'static', '_static', 'chunks')), 'hashed bundle is CDN-served');
    assert.ok(existsSync(join(output, 'static', 'robots.txt')), 'public/ is CDN-served at the web root');
    // Not in static output on purpose: one URL answers with a document or a flight payload depending on
    // the `RSC` request header, which a path-keyed CDN cannot choose between.
    assert.equal(existsSync(join(output, 'static', 'docs')), false, 'prerendered pages are not CDN-served');
    assert.ok(existsSync(join(functionDir, 'dist', 'ssg', 'docs')), 'they ship inside the function instead');
  });

  test('ships a bundle the function can resolve, since only dist/server is uploaded', async () => {
    await assertSelfContained();
  });

  test('keeps the bundle at the path its runtime derives the project root from', () => {
    assert.ok(existsSync(join(functionDir, 'dist', 'server', 'main.mjs')));
    const config = JSON.parse(readFileSync(join(functionDir, '.vc-config.json'), 'utf8'));
    assert.equal(config.handler, 'dist/server/main.mjs');
    assert.equal(config.launcherType, 'Nodejs');
    assert.equal(config.supportsResponseStreaming, true, 'buffering would undo streamed SSR');
  });

  test('runs the function on the Node the build used, rather than a version pinned in the framework', () => {
    // A hard-coded major is a build that starts failing on a date the framework does not control, with an
    // error pointing at a file the user did not write. Asserted against `process.versions` rather than a
    // literal so this cannot quietly become the hard-coded value again on whatever Node CI happens to run.
    const config = JSON.parse(readFileSync(join(functionDir, '.vc-config.json'), 'utf8'));
    assert.equal(config.runtime, `nodejs${process.versions.node.split('.')[0]}.x`);
  });

  test('uploads public/ to the CDN only, not a second time inside the function', () => {
    // `{ handle: 'filesystem' }` precedes the catch-all route, so the platform answers these paths before the
    // function is reached: a copy inside it is upload size and cold-start unpack time nothing can read.
    assert.ok(existsSync(join(output, 'static', 'robots.txt')), 'the CDN copy is the one that serves');
    assert.equal(existsSync(join(functionDir, 'dist', 'public')), false, 'and it must not be shipped twice');
    // The two the function genuinely does read off its own disk.
    assert.ok(existsSync(join(functionDir, 'dist', 'server')));
    assert.ok(existsSync(join(functionDir, 'dist', 'ssg')));
  });

  test('routes assets before the function, and everything else to it', () => {
    const { version, routes } = JSON.parse(readFileSync(join(output, 'config.json'), 'utf8'));
    assert.equal(version, 3);
    const immutable = routes.find((route) => route.headers?.['cache-control']?.includes('immutable'));
    assert.match(immutable.src, /_static/, 'the one header the CDN cannot infer');
    assert.ok(routes.indexOf(routes.find((r) => r.handle === 'filesystem')) < routes.length - 1);
    assert.deepEqual(routes.at(-1), { src: '/(.*)', dest: '/index' }, 'the app is the fallback');
  });
});

describe('aws-lambda', () => {
  let bundle;

  before(async () => {
    // The Lambda runtime injects this global; `streamHandle` builds its handler out of it, and the
    // module deliberately exports nothing when it is absent so the build's prerender pass still works.
    globalThis.awslambda = { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (stream) => stream } };
    bundle = await buildFor('aws-lambda');
  });

  test('exports a streaming handler when the runtime globals are present', () => {
    assert.equal(buildMarker().deploy, 'aws-lambda');
    assert.equal(typeof bundle.default, 'function', 'streamifyResponse-wrapped, so SSR still streams');
  });

  test('ships a bundle the function can resolve, since the package is dist/ and nothing else', async () => {
    await assertSelfContained();
  });
});
