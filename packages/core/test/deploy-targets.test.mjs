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

/** Drives a web-standard handler — the shape Vercel and any `fetch`-based host invoke. */
async function requestVia(handler, path) {
  const res = await handler(new Request(`${ORIGIN}${path}`));
  return { res, body: await res.text() };
}

describe('vercel', () => {
  let bundle;
  const output = join(TESTBED_DIR, '.vercel', 'output');
  const functionDir = join(output, 'functions', 'index.func');

  before(async () => {
    bundle = await buildFor('vercel');
  });

  test('exports a web handler and renders through it', async () => {
    assert.equal(buildMarker().deploy, 'vercel');
    assert.equal(typeof bundle.default, 'function');
    const { res, body } = await requestVia(bundle.default, '/');
    assert.equal(res.status, 200);
    assert.ok(body.startsWith('<!DOCTYPE html>'));
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
