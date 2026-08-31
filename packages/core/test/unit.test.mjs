// Unit tests for the pure pieces — the parsers, path maths and header helpers the e2e suite only
// exercises indirectly through one happy path. They import the *built* package, so they double as a
// check that dist is importable from plain Node.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { after, describe, test } from 'node:test';

import { scanPageFiles } from '../dist/builder/page-files.js';
import { checkReactVersions } from '../dist/builder/react-versions.js';
import { createConfigs } from '../dist/builder/rspack-config.js';
import { DEPLOY_TARGETS, deployHintFor, NODE_PRESET, resolveDeployPreset } from '../dist/deploy/presets.js';
import { appendVary, etagMatches } from '../dist/server/headers.js';
import { resolveServerConfig } from '../dist/server/server-config.js';
import { createPageCache, ssgAssetPath, ssgFilePath } from '../dist/server/prerendered.js';
import { prerenderStaticRoutes, readPrerendered, resolveSiteOrigin } from '../dist/server/ssg.js';
import { injectFlightPayload } from '../dist/runtime/flight-inject.js';
import { isControlDigest, parseRedirectDigest, RedirectSignal } from '../dist/runtime/control.js';
import { beginPageRender, RequestContext } from '../dist/runtime/context.js';
import { walkHotUpdates } from '../dist/runtime/hot-update.js';
import { validateRoutesModule, validateServerApp } from '../dist/runtime/validate-entries.js';
import { MINIMAL_APP_DIR, TESTBED_DIR } from './helpers.mjs';

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rshono-unit-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('injectFlightPayload', () => {
  const encoder = new TextEncoder();
  const streamOf = (chunks) =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        controller.close();
      },
    });

  async function readAll(stream) {
    const decoder = new TextDecoder();
    let html = '';
    for await (const chunk of stream) html += decoder.decode(chunk, { stream: true });
    return html + decoder.decode();
  }

  /** Fails loudly instead of hanging the suite: a transformer that never settles is exactly the bug below. */
  function withTimeout(promise, ms, message) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref())]);
  }

  function inject(htmlChunks, { nonce } = {}) {
    return readAll(streamOf(htmlChunks).pipeThrough(injectFlightPayload(streamOf(['0:"hi"\n']), nonce ? { nonce } : {})));
  }

  const countOf = (html, needle) => html.split(needle).length - 1;

  // React's byte writer packs output into 2 kB views and splits any write that straddles one, so the
  // document trailer can arrive as two chunks. `rsc-html-stream/server` tests each chunk with
  // `endsWith` and misses that, emitting two trailers with the payload script after the first — i.e.
  // outside <body>. A page's byte layout is deterministic, so such a page is malformed every time.
  const splits = {
    'one chunk': ['<html><body><p>hi</p>', '</body></html>'],
    'mid-tag': ['<html><body><p>hi</p></bo', 'dy></html>'],
    'between tags': ['<html><body><p>hi</p></body>', '</html>'],
    'one byte early': ['<html><body><p>hi</p></body></htm', 'l>'],
    'byte at a time': ['<html><body><p>hi</p>', ...'</body></html>'],
  };

  for (const [name, chunks] of Object.entries(splits)) {
    test(`holds back a document trailer split ${name}`, async () => {
      const html = await inject(chunks);
      assert.equal(countOf(html, '</body></html>'), 1, 'exactly one trailer, however React chunked it');
      assert.equal(countOf(html, '__FLIGHT_DATA'), 1, 'the payload rides in one script');
      assert.match(html, /<script>\(self\.__FLIGHT_DATA\|\|=\[\]\)\.push\("0:\\"hi\\"\\n"\)<\/script><\/body><\/html>$/);
    });
  }

  test('puts the payload script inside the body, before the trailer', async () => {
    const html = await inject(['<html><body><p>hi</p></body></html>']);
    assert.ok(html.indexOf('__FLIGHT_DATA') < html.indexOf('</body></html>'), 'the script must not land after </body>');
  });

  test('carries the CSP nonce on the injected script', async () => {
    const html = await inject(['<html><body></body></html>'], { nonce: 'abc123' });
    assert.match(html, /<script nonce="abc123">/);
    // Base64url too — a generator may emit either alphabet, and `=` padding.
    const urlSafe = await inject(['<html><body></body></html>'], { nonce: 'aB-_0z==' });
    assert.match(urlSafe, /<script nonce="aB-_0z==">/);
  });

  test('drops a nonce that is not one rather than writing it into the tag', async () => {
    // This tag is built by hand, so its attribute value is the one in a rendered document that nothing else
    // escapes. The value is not attacker-controlled today — it comes from Hono's `secureHeaders()` — but the
    // framework does not own where it comes from: `secureHeadersNonce` is an ordinary context variable any
    // middleware can set. A `"` in it would close the attribute and open a script-injection point in every
    // page. Dropped rather than escaped: a value that is not a nonce is not one, and a payload script the
    // policy then refuses is the visible failure to have.
    for (const nonce of ['" onload="alert(1)', 'abc"><script>alert(1)</script>', 'has space', 'weird;value', '<>']) {
      const html = await inject(['<html><body></body></html>'], { nonce });
      assert.match(html, /<script>\(self\.__FLIGHT_DATA/, `"${nonce}" must not reach the tag`);
      assert.equal(countOf(html, 'nonce'), 0, `"${nonce}" was written into the document`);
    }
  });

  test('escapes a payload that would close the script element early', async () => {
    const out = streamOf(['<html><body></body></html>']).pipeThrough(injectFlightPayload(streamOf(['0:"</script><!--x"\n'])));
    const decoder = new TextDecoder();
    let html = '';
    for await (const chunk of out) html += decoder.decode(chunk, { stream: true });
    html += decoder.decode();
    assert.equal(countOf(html, '</script>'), 1, 'only the real closing tag');
    assert.match(html, /<\/\\script>/, 'the payload copy is escaped');
    assert.match(html, /<\\!--/);
  });

  test('re-emits a trailer even when the document never had one', async () => {
    const html = await inject(['<p>fragment</p>']);
    assert.equal(countOf(html, '</body></html>'), 1);
  });

  test('ends the response even when the HTML side produced no chunks at all', async () => {
    // `transform` is what starts the payload write and so what eventually settles the promise `flush` awaits.
    // An HTML stream that closes having emitted nothing never reaches it, and `flush` used to park on that
    // promise forever — a response held open rather than ended, with `onDone` never firing to release the
    // abort forwarder that retains the rendered tree.
    let released = false;
    const out = streamOf([]).pipeThrough(injectFlightPayload(streamOf(['0:"hi"\n']), { onDone: () => (released = true) }));

    const html = await withTimeout(readAll(out), 2000, 'flush never resolved for a zero-chunk HTML stream');
    assert.match(html, /__FLIGHT_DATA/, 'the payload the client hydrates from still has to be written');
    assert.equal(countOf(html, '</body></html>'), 1, 'and the document still has to be closed');
    assert.ok(released, 'onDone must fire, however the response ended');
  });

  // The client-disconnect path. @hono/node-server cancels the response reader when the socket's
  // writable closes, and a page whose flight payload outlives its HTML — a suspended server component
  // resolving after the shell has flushed — puts that cancel inside `flush`'s `await flightWritten`.
  //
  // The trap is that the transformer's `cancel` hook does *not* run there: per the Streams standard,
  // cancelling the readable once the close algorithm has started returns the pending finish promise
  // without performing the cancel. So the enqueue that follows throws `ERR_INVALID_STATE` out of an
  // async transformer callback, where nothing owns the rejection — and `onDone` never fires, which is
  // what `renderComponent` relies on to detach the abort forwarder holding the rendered tree.
  describe('when the client disconnects mid-response', () => {
    /** A flight stream that stays open until `release()`, so `flush` is parked when the cancel lands. */
    function heldFlightStream() {
      let release;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('0:"hi"\n'));
          release = () => controller.close();
        },
      });
      return { stream, release: () => release() };
    }

    test('cancelling while the flight payload is still open resolves, releases and does not throw', async () => {
      const rejections = [];
      const onRejection = (error) => rejections.push(error);
      process.on('unhandledRejection', onRejection);
      try {
        const flight = heldFlightStream();
        let rscCancelled = false;
        // Interposed so the test can see whether the RSC branch is torn down: left un-cancelled it
        // keeps being pumped for a response nobody will read, and a tee's other half buffers for it.
        const watched = new ReadableStream({
          start: async (c) => {
            const reader = flight.stream.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              try {
                c.enqueue(value);
              } catch {
                break;
              }
            }
            try {
              c.close();
            } catch {
              /* already gone */
            }
          },
          cancel: () => {
            rscCancelled = true;
          },
        });

        let released = 0;
        const out = streamOf(['<html><body><p>hi</p></body></html>']).pipeThrough(injectFlightPayload(watched, { onDone: () => released++ }));
        const reader = out.getReader();
        await reader.read(); // the shell; the trailer is held back and `flush` is now parked

        await reader.cancel(new Error('Client connection prematurely closed.'));
        flight.release();
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.equal(released, 1, 'onDone must fire, or the abort forwarder is never detached');
        assert.equal(rscCancelled, true, 'the RSC branch must be released rather than left to be pumped');
        assert.deepEqual(rejections, [], 'a disconnect must not produce an unhandled rejection');
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    test('cancelling after the payload is written still reports done exactly once', async () => {
      let released = 0;
      const out = streamOf(['<html><body></body></html>']).pipeThrough(injectFlightPayload(streamOf(['0:"hi"\n']), { onDone: () => released++ }));
      for await (const _chunk of out) void _chunk;
      assert.equal(released, 1);
    });
  });
});

// Two fields, because only two things here are decided by the build. The CSRF check, the CSP and the
// body cap used to live alongside them and are now Hono middleware an app registers in src/server.ts
// — see prod-config.test.mjs, which exercises them over HTTP rather than through a resolver.
describe('resolveServerConfig', () => {
  test('applies the documented defaults', () => {
    const config = resolveServerConfig({}, { isDev: false });
    assert.equal(config.trustProxy, false, 'proxy headers are never trusted by default');
    assert.equal(config.isDev, false, 'the build mode is baked in rather than read from NODE_ENV at runtime');
  });

  test('forces trustProxy on in dev, where the framework owns the proxy', () => {
    const config = resolveServerConfig({ trustProxy: false }, { isDev: true });
    assert.equal(config.trustProxy, true);
    assert.equal(config.isDev, true);
  });
});

describe('appendVary', () => {
  test('adds to the list instead of replacing it', () => {
    const headers = new Headers();
    appendVary(headers, 'Accept');
    assert.equal(headers.get('vary'), 'Accept');
    appendVary(headers, 'Accept-Encoding');
    assert.equal(headers.get('vary'), 'Accept, Accept-Encoding', 'the earlier entry must survive');
  });

  test('is idempotent and case-insensitive, and leaves * alone', () => {
    const headers = new Headers({ vary: 'accept' });
    appendVary(headers, 'Accept');
    assert.equal(headers.get('vary'), 'accept');

    const wildcard = new Headers({ vary: '*' });
    appendVary(wildcard, 'Accept');
    assert.equal(wildcard.get('vary'), '*', '* already means "never reuse"');
  });
});

describe('etagMatches', () => {
  const etag = '"abc123"';
  test('matches exact, weak and listed validators', () => {
    assert.equal(etagMatches(etag, etag), true);
    assert.equal(etagMatches(`W/${etag}`, etag), true, 'a proxy that re-encoded the bytes may weaken the tag');
    assert.equal(etagMatches(`"other", ${etag}`, etag), true);
    assert.equal(etagMatches('*', etag), true);
  });

  test('does not match a different or absent validator', () => {
    assert.equal(etagMatches(undefined, etag), false);
    assert.equal(etagMatches('', etag), false);
    assert.equal(etagMatches('"nope"', etag), false);
  });
});

describe('ssgFilePath', () => {
  // The one mapping from a path to the file holding its page — the build's and every deploy target's,
  // because two of them is how a page gets written where no request will ever look for it.
  //
  // Always '/'-separated, on every host: the same string addresses a file (`resolve()` takes forward
  // slashes on Windows) and a key in an asset store, where a backslash is simply the wrong character.
  test('maps a concrete route path to its index.html', () => {
    assert.equal(ssgFilePath('/'), 'index.html');
    assert.equal(ssgFilePath('/docs'), 'docs/index.html');
    assert.equal(ssgFilePath('/docs/getting-started/'), 'docs/getting-started/index.html');
  });

  test('maps the flight variant alongside the document', () => {
    assert.equal(ssgFilePath('/', 'flight'), 'index.rsc');
    assert.equal(ssgFilePath('/docs', 'flight'), 'docs/index.rsc');
  });

  // The blocker this replaced: the build interpolated `staticPaths` values with `encodeURIComponent`,
  // while Hono hands a handler `c.req.path` with `decodeURI` already run over any path holding a `%`.
  // Every non-ASCII slug was therefore built and then never served.
  test('resolves the encoded and the decoded form of a path to the same file', () => {
    for (const [encoded, decoded] of [
      ['/docs/caf%C3%A9', '/docs/café'],
      ['/docs/a%20b', '/docs/a b'],
      ['/%C3%BC', '/ü'],
      ['/docs/%E6%97%A5%E6%9C%AC', '/docs/日本'],
    ]) {
      assert.equal(ssgFilePath(encoded), `${decoded.slice(1)}/index.html`, `${encoded} must resolve decoded`);
      assert.equal(ssgFilePath(decoded), ssgFilePath(encoded), `${decoded} and ${encoded} are one page`);
    }
  });

  test('refuses a segment no portable file name can hold', () => {
    // The first two are route patterns rather than paths; the rest are characters Windows refuses, or a
    // `%2F` that would otherwise smuggle a second segment into one param value.
    for (const path of ['/docs/:slug', '/files/*', '/docs/a%2Fb', '/docs/a%5Cb', '/docs/a?b', '/docs/a|b', '/docs//x']) {
      assert.equal(ssgFilePath(path), null, `${path} must not resolve to a file`);
    }
  });

  // The shared guard every deploy target relies on: an asset store addressed by key has no
  // `resolve()` to fall back on, so a traversal has to be refused here or not at all.
  test('refuses traversal in a request path, escaped or not', () => {
    const attempts = ['/../secret', '/docs/../../etc/passwd', '/..', '/docs/..', '/./docs', '/docs/./x', '/%2e%2e/secret', '/..%2f'];
    for (const attempt of attempts) {
      assert.equal(ssgFilePath(attempt, 'html'), null, `${attempt} must not resolve to a file`);
    }
  });
});

describe('ssgAssetPath', () => {
  // Workers reads the same tree through a URL, so the key has to survive being put into one.
  test('escapes each segment of a store key, and only the segments', () => {
    assert.equal(ssgAssetPath('docs/café/index.html'), 'docs/caf%C3%A9/index.html');
    assert.equal(ssgAssetPath('docs/a b/index.rsc'), 'docs/a%20b/index.rsc');
    assert.equal(ssgAssetPath('docs/a#b/index.html'), 'docs/a%23b/index.html', 'a # would otherwise start a fragment');
  });
});

describe('resolveSiteOrigin', () => {
  test('falls back to a localhost placeholder when unset', () => {
    assert.equal(resolveSiteOrigin(undefined), 'http://localhost');
    assert.equal(resolveSiteOrigin(''), 'http://localhost');
  });

  test('reduces a configured site URL to its origin', () => {
    assert.equal(resolveSiteOrigin('https://example.com'), 'https://example.com');
    assert.equal(resolveSiteOrigin('https://example.com/'), 'https://example.com');
    assert.equal(resolveSiteOrigin('http://localhost:4000'), 'http://localhost:4000');
  });

  test('rejects a base path rather than silently dropping it', () => {
    assert.throws(() => resolveSiteOrigin('https://example.com/docs'), /must be a bare origin/);
    assert.throws(() => resolveSiteOrigin('https://example.com/?a=1'), /must be a bare origin/);
  });

  test('rejects something that is not an http(s) origin', () => {
    for (const bad of ['example.com', 'ftp://example.com', 'not a url']) {
      assert.throws(() => resolveSiteOrigin(bad), /invalid siteUrl/, `${bad} should be rejected`);
    }
  });
});

describe('readPrerendered', () => {
  test('reads a page, derives a stable ETag, and serves the second hit from memory', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'index.html'), '<!DOCTYPE html><p>docs</p>');

    const first = await readPrerendered(dir, '/docs');
    // Bytes, not a string: the entry is served verbatim to every hit, so it is cached already encoded.
    assert.ok(first.body instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(first.body), '<!DOCTYPE html><p>docs</p>');
    assert.equal(first.contentLength, '26');
    assert.match(first.etag, /^W\/"[\w-]{22}"$/, 'weak, so it survives being gzipped on the way out');

    const second = await readPrerendered(dir, '/docs');
    assert.equal(second, first, 'a cache hit returns the very same object, not a re-read');

    // Content decides the ETag, so a different page must not collide with this one.
    writeFileSync(join(dir, 'other.html'), '<!DOCTYPE html><p>other</p>');
    mkdirSync(join(dir, 'other'), { recursive: true });
    writeFileSync(join(dir, 'other', 'index.html'), '<!DOCTYPE html><p>other</p>');
    const other = await readPrerendered(dir, '/other');
    assert.notEqual(other.etag, first.etag);
  });

  test('returns null for a missing page instead of throwing', async () => {
    assert.equal(await readPrerendered(tempDir(), '/nope'), null);
  });

  test('refuses to escape the ssg directory, decoded form included', async () => {
    // `ssgFilePath` above is where the exhaustive path cases live; what this adds is that the
    // percent-encoded form is decoded *before* the check rather than after it.
    const dir = tempDir();
    for (const attempt of ['/../', '/..%2f', '/docs/../../etc']) {
      assert.equal(await readPrerendered(dir, attempt), null, `traversal attempt "${attempt}" must not resolve`);
    }
  });
});

describe('prerenderStaticRoutes', () => {
  // The app answers per the `RSC` header, exactly as the real one does — the point of prerendering both.
  const okResponse = (request) =>
    request.headers.get('RSC') === '1'
      ? new Response('0:{"root":"flight"}', { status: 200, headers: { 'Content-Type': 'text/x-component' } })
      : new Response('<!DOCTYPE html><p>ok</p>', { status: 200, headers: { 'Content-Type': 'text/html' } });

  test('writes both representations per static route and per staticPaths entry', async () => {
    const ssgDir = tempDir();
    const requested = [];
    const result = await prerenderStaticRoutes({
      ssgDir,
      routes: [
        { path: '/about', render: 'static', component: async () => ({ default: () => null }) },
        {
          path: '/docs/:slug',
          render: 'static',
          component: async () => ({ default: () => null }),
          staticPaths: async () => [{ slug: 'a' }, { slug: 'b' }],
        },
        { path: '/live', component: async () => ({ default: () => null }) },
      ],
      fetch: (request) => {
        requested.push(`${request.headers.get('RSC') ? 'flight' : 'document'} ${new URL(request.url).pathname}`);
        return okResponse(request);
      },
    });

    assert.deepEqual(result.written, ['/about', '/docs/a', '/docs/b']);
    assert.deepEqual(
      requested,
      ['document /about', 'flight /about', 'document /docs/a', 'flight /docs/a', 'document /docs/b', 'flight /docs/b'],
      'each path is rendered as a document and as a flight payload; a dynamic route is never prerendered',
    );
    const decode = (page) => new TextDecoder().decode(page.body);
    assert.equal(decode(await readPrerendered(ssgDir, '/docs/a')), '<!DOCTYPE html><p>ok</p>');
    assert.equal(decode(await readPrerendered(ssgDir, '/docs/a', 'flight')), '0:{"root":"flight"}');
  });

  test('renders against siteUrl, so absolute URLs in the output are the deployed ones', async () => {
    const seen = [];
    await prerenderStaticRoutes({
      ssgDir: tempDir(),
      siteUrl: 'https://example.com',
      routes: [{ path: '/about', render: 'static', component: async () => ({ default: () => null }) }],
      fetch: (request) => {
        seen.push(request.url);
        return okResponse(request);
      },
    });
    assert.deepEqual(seen, ['https://example.com/about', 'https://example.com/about']);
  });

  test('keeps the document when the flight payload cannot be produced', async () => {
    const ssgDir = tempDir();
    const result = await prerenderStaticRoutes({
      ssgDir,
      routes: [{ path: '/about', render: 'static', component: async () => ({ default: () => null }) }],
      fetch: (request) =>
        request.headers.get('RSC') === '1'
          ? new Response('nope', { status: 500 })
          : new Response('<!DOCTYPE html><p>ok</p>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    });

    assert.deepEqual(result.written, ['/about'], 'a missing flight payload must not lose the document');
    assert.ok(await readPrerendered(ssgDir, '/about'));
    assert.equal(await readPrerendered(ssgDir, '/about', 'flight'), null, 'serving falls back to rendering it per request');
  });

  test('skips a parameterised static route with no staticPaths rather than failing the build', async () => {
    const result = await prerenderStaticRoutes({
      ssgDir: tempDir(),
      routes: [{ path: '/docs/:slug', render: 'static', component: async () => ({ default: () => null }) }],
      fetch: okResponse,
    });
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.skipped, ['/docs/:slug']);
  });

  test('skips a path that did not render 200 HTML at build time', async () => {
    const result = await prerenderStaticRoutes({
      ssgDir: tempDir(),
      routes: [{ path: '/boom', render: 'static', component: async () => ({ default: () => null }) }],
      fetch: () => new Response('nope', { status: 500 }),
    });
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.skipped, ['/boom']);
  });

  test('rejects param shapes it cannot turn into a single file', async () => {
    const cases = [
      { path: '/files/*', staticPaths: async () => [{}], expected: /wildcard segments/ },
      { path: '/docs/:slug{[a-z]+}', staticPaths: async () => [{ slug: 'a' }], expected: /optional\/regex params/ },
      { path: '/docs/:slug', staticPaths: async () => [{ wrong: 'a' }], expected: /without "slug"/ },
    ];
    for (const { path, staticPaths, expected } of cases) {
      await assert.rejects(
        prerenderStaticRoutes({
          ssgDir: tempDir(),
          routes: [{ path, render: 'static', staticPaths, component: async () => ({ default: () => null }) }],
          fetch: okResponse,
        }),
        expected,
        `"${path}" should be rejected`,
      );
    }
  });

  // The round trip, not `interpolatePath` in isolation — testing the halves separately is exactly what let
  // a page be built under a name no request ever resolves to.
  test('a param value needing percent-encoding is served back for the path the browser asks for', async () => {
    const ssgDir = tempDir();
    const requested = [];
    const result = await prerenderStaticRoutes({
      ssgDir,
      routes: [
        {
          path: '/docs/:slug',
          render: 'static',
          component: async () => ({ default: () => null }),
          staticPaths: async () => [{ slug: 'café' }, { slug: 'a b' }],
        },
      ],
      fetch: (request) => {
        requested.push(new URL(request.url).pathname);
        return okResponse(request);
      },
    });

    assert.deepEqual(result.written, ['/docs/caf%C3%A9', '/docs/a%20b']);
    assert.deepEqual(
      requested,
      ['/docs/caf%C3%A9', '/docs/caf%C3%A9', '/docs/a%20b', '/docs/a%20b'],
      'the page is fetched at the URL a browser would use, once per representation',
    );

    // …and read back at `c.req.path`, which is what Hono hands the handler: `decodeURI` has already run.
    for (const requestPath of ['/docs/café', '/docs/a b']) {
      assert.ok(await readPrerendered(ssgDir, requestPath), `${requestPath} must be served from the build`);
      assert.ok(await readPrerendered(ssgDir, requestPath, 'flight'), `${requestPath} must soft-navigate from the build`);
    }
  });

  test('fails the build for a value it cannot store as one file, rather than writing a page nothing serves', async () => {
    for (const slug of ['a b/c', 'a:b', '..']) {
      await assert.rejects(
        prerenderStaticRoutes({
          ssgDir: tempDir(),
          routes: [
            {
              path: '/docs/:slug',
              render: 'static',
              component: async () => ({ default: () => null }),
              staticPaths: async () => [{ slug }],
            },
          ],
          fetch: okResponse,
        }),
        /Cannot prerender .* for route "\/docs\/:slug"/,
        `"${slug}" should be rejected`,
      );
    }
  });
});

describe('control signals', () => {
  test('a redirect round-trips through its digest', () => {
    const signal = new RedirectSignal('/dashboard?next=/a b', 303);
    assert.equal(isControlDigest(signal.digest), true);
    assert.deepEqual(parseRedirectDigest(signal.digest), { location: '/dashboard?next=/a b', status: 303 });
  });

  test('a notFound digest is a control signal but not a redirect', () => {
    assert.equal(isControlDigest('RSHONO_NOT_FOUND'), true);
    assert.equal(parseRedirectDigest('RSHONO_NOT_FOUND'), null);
  });

  test('an unrelated digest is left alone', () => {
    for (const digest of [undefined, null, 42, '', 'some-react-digest']) {
      assert.equal(isControlDigest(digest), false, `${String(digest)} must not read as a control signal`);
    }
  });
});

describe('RequestContext enumerability', () => {
  // React's diagnostic for a value that cannot cross to a client component walks `Object.keys`
  // recursively with no depth limit and no cycle guard. The Hono context reaches the socket and the
  // whole server through `req.raw` / `env`, so while `raw` was an own enumerable property, passing a
  // RequestContext to a `'use client'` component overflowed the stack *inside React's error-message builder* —
  // and its real "Only plain objects … can be passed to Client Components" error never printed.
  const fakeHonoContext = { req: { url: 'http://example.test/', param: () => ({}) }, env: {} };
  // The cycle that made the walk unbounded, so this test fails the same way React did if `raw` ever
  // becomes enumerable again.
  fakeHonoContext.self = fakeHonoContext;

  test('the Hono context is reachable but not enumerable, so a serializer cannot walk into it', () => {
    const ctx = new RequestContext(fakeHonoContext);
    assert.equal(ctx.hono, fakeHonoContext, 'ctx.hono is documented public API and must keep working');
    assert.ok(!Object.keys(ctx).includes('hono'), 'ctx.hono must not be an own enumerable property');
    // `req` is the same hazard by a shorter path — it *is* the object holding the cycle.
    assert.ok(!Object.keys(ctx).includes('req'), 'ctx.req must not be an own enumerable property either');
    assert.doesNotThrow(() => JSON.stringify(ctx), 'walking a RequestContext must not reach the cyclic Hono context');
  });

  test('the wrapper still resolves request data through the hidden context', () => {
    const ctx = new RequestContext(fakeHonoContext);
    assert.equal(ctx.url.pathname, '/');
    assert.equal(ctx.req.url, 'http://example.test/', 'ctx.req is the promoted Hono request');
    assert.deepEqual(ctx.params, {}, 'ctx.params falls back to an empty record with no route match');
    assert.equal(ctx.hono.req.url, 'http://example.test/', 'the escape hatch still reaches the same request');
  });

  // Hono's response builders are silent no-ops from inside a page, which is the confusion the stubs
  // exist to end. Each must throw and name the API that does work.
  test("Hono's response builders throw instead of doing nothing", () => {
    const ctx = new RequestContext(fakeHonoContext);
    assert.throws(() => ctx.redirect(), /Use `redirect\(\)` from '@rshono\/core\/server'/);
    assert.throws(() => ctx.notFound(), /Use `notFound\(\)` from '@rshono\/core\/server'/);
    assert.throws(() => ctx.header(), /Use `ctx\.setHeader\(name, value\)`/);
    for (const call of ['json', 'text', 'html', 'body', 'status']) {
      assert.throws(() => ctx[call](), /\[rshono\]/, `ctx.${call}() must throw rather than silently do nothing`);
    }
  });

  test('response writes are allowed before the render and throw once it has begun', () => {
    const headers = [];
    const c = { ...fakeHonoContext, header: (name, value) => headers.push([name, value]) };
    const ctx = new RequestContext(c);

    // An action's context: the render has not started, so the write reaches the response.
    ctx.setHeader('x-before', '1');
    assert.deepEqual(headers, [['x-before', '1']]);

    beginPageRender(c);
    assert.throws(() => ctx.setHeader('x-after', '1'), /too late to affect the response/);
    assert.throws(() => ctx.cookies.set('a', 'b'), /too late to affect the response/);
    assert.throws(() => ctx.cookies.delete('a'), /too late to affect the response/);
    assert.deepEqual(headers, [['x-before', '1']], 'nothing may be written after the render begins');
  });

  test('reads stay available throughout the render', () => {
    const c = { ...fakeHonoContext, req: { ...fakeHonoContext.req, header: () => 'v' } };
    const ctx = new RequestContext(c);
    beginPageRender(c);
    assert.equal(ctx.url.pathname, '/', 'ctx.url must survive the render marker');
    assert.equal(ctx.req.header('x'), 'v', 'ctx.req must survive the render marker');
    assert.deepEqual(ctx.params, {});
  });
});

describe('scanPageFiles', () => {
  test('resolves inline component thunks, including @/ and index files', () => {
    const dir = tempDir();
    const srcDir = join(dir, 'src');
    mkdirSync(join(srcDir, 'components', 'nested'), { recursive: true });
    writeFileSync(join(srcDir, 'components', 'home.tsx'), 'export default () => null;');
    writeFileSync(join(srcDir, 'components', 'about.ts'), 'export default () => null;');
    writeFileSync(join(srcDir, 'components', 'nested', 'index.tsx'), 'export default () => null;');

    const routesFile = join(srcDir, 'routes.ts');
    writeFileSync(
      routesFile,
      `export const routes = [
         { path: '/', component: () => import('./components/home') },
         { path: '/about', component: async () => import("@/components/about") },
         { path: '/nested', component: () => import('./components/nested') },
         { path: '/missing', component: () => import('./components/gone') },
         { path: '/indirect', component: loadSomething },
       ];`,
    );

    const found = new Set();
    scanPageFiles(routesFile, srcDir, found);
    assert.deepEqual(
      [...found].sort(),
      [join(srcDir, 'components', 'about.ts'), join(srcDir, 'components', 'home.tsx'), join(srcDir, 'components', 'nested', 'index.tsx')].sort(),
      'unresolvable and non-inline thunks are simply not page files',
    );
  });

  test('clears previous results so a removed route stops being a page file', () => {
    const dir = tempDir();
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const routesFile = join(srcDir, 'routes.ts');
    writeFileSync(routesFile, `export const routes = [];`);

    const found = new Set(['stale-entry']);
    scanPageFiles(routesFile, srcDir, found);
    assert.deepEqual([...found], []);
  });

  test('an unreadable routes file leaves the set empty instead of throwing', () => {
    const found = new Set();
    scanPageFiles(join(tempDir(), 'does-not-exist.ts'), tempDir(), found);
    assert.deepEqual([...found], []);
  });
});

describe('deploy target resolution', () => {
  test('defaults to node, and a blank source is no source at all', () => {
    assert.equal(resolveDeployPreset().name, 'node');
    assert.equal(resolveDeployPreset({}).name, 'node');
    // An `RSHONO_DEPLOY=` that a CI environment sets but never fills in has to fall through to the
    // config file rather than fail the build on the empty string.
    assert.equal(resolveDeployPreset({ env: '' }).name, 'node');
    assert.equal(resolveDeployPreset({ env: '   ' }).name, 'node');
  });

  test('the flag wins over the environment, which wins over the config file', () => {
    assert.equal(resolveDeployPreset({ flag: 'node', env: 'cloudflare', config: 'cloudflare' }).name, 'node');
    assert.equal(resolveDeployPreset({ env: 'cloudflare', config: 'node' }).name, 'cloudflare');
    assert.equal(resolveDeployPreset({ config: 'cloudflare' }).name, 'cloudflare');
    // A loser never reaches the lookup, so only the winner can be the one reported as unknown.
    assert.throws(() => resolveDeployPreset({ flag: 'from-flag', env: 'node', config: 'node' }), /from-flag/);
  });

  test('every target resolves to a preset that can name its own runtime and deploy command', () => {
    for (const target of DEPLOY_TARGETS) {
      const preset = resolveDeployPreset({ config: target });
      assert.equal(preset.name, target);
      assert.match(preset.runtimeModule, /^deploy\/[\w-]+\/runtime\.js$/, `${target} points at a runtime module`);
      assert.equal(deployHintFor(target), preset.deployHint);
      assert.ok(preset.deployHint.length > 0, `${target} says how to deploy`);
    }
  });

  test('an unknown target fails the build, naming the ones that exist', () => {
    assert.throws(() => resolveDeployPreset({ config: 'fly' }), /unknown deploy target "fly"/);
    assert.throws(() => resolveDeployPreset({ config: 'fly' }), new RegExp(DEPLOY_TARGETS.join(', ')));
    assert.equal(deployHintFor('fly'), null, 'a dist/ from a newer rshono can carry a name this one lacks');
  });
});

describe('the deploy seam', () => {
  test('the server bundle resolves @rshono/deploy to the selected platform, and nothing else', () => {
    const [clientConfig, serverConfig] = createConfigs({ rootDir: MINIMAL_APP_DIR, isDev: false, config: {}, preset: NODE_PRESET });
    assert.match(serverConfig.resolve.alias['@rshono/deploy$'], /dist[\\/]deploy[\\/]node[\\/]runtime\.js$/);
    assert.equal('@rshono/deploy$' in clientConfig.resolve.alias, false, 'the browser bundle has no platform to speak of');
  });

  test('a preset can adjust the server compiler, and the user hook still gets the last word', () => {
    const preset = {
      ...NODE_PRESET,
      configureServer(config) {
        config.target = 'webworker';
      },
    };
    const [, serverConfig] = createConfigs({
      rootDir: MINIMAL_APP_DIR,
      isDev: false,
      preset,
      config: {
        rspack(config, { isServer }) {
          if (isServer) config.devtool = 'source-map';
        },
      },
    });
    assert.equal(serverConfig.target, 'webworker', 'the preset reached the generated config');
    assert.equal(serverConfig.devtool, 'source-map', "the app's own hook ran after it");
  });
});

describe('createPageCache', () => {
  const pageOf = (size) => ({ body: new Uint8Array(size), contentLength: String(size), etag: `W/"${size}"` });

  test('evicts oldest-first to stay inside its byte budget', () => {
    const cache = createPageCache(300);
    cache.set('a', pageOf(100));
    cache.set('b', pageOf(100));
    cache.set('c', pageOf(100));
    assert.ok(cache.get('a'), 'still inside the budget');

    cache.set('d', pageOf(100));
    assert.equal(cache.get('a'), undefined, 'the oldest went');
    assert.ok(cache.get('b') && cache.get('c') && cache.get('d'));
  });

  test('counts bytes rather than entries', () => {
    const cache = createPageCache(300);
    cache.set('big', pageOf(250));
    cache.set('small', pageOf(100));
    assert.equal(cache.get('big'), undefined, 'two entries, but 350 bytes');
    assert.ok(cache.get('small'));
  });

  test('serves a page too big to store rather than emptying the cache for it', () => {
    const cache = createPageCache(300);
    cache.set('keep', pageOf(100));
    cache.set('huge', pageOf(500));
    assert.equal(cache.get('huge'), undefined, 'not stored');
    assert.ok(cache.get('keep'), 'and nothing was evicted to make room for it');
  });

  test('re-setting a key does not double-count its bytes', () => {
    const cache = createPageCache(300);
    cache.set('a', pageOf(200));
    cache.set('a', pageOf(200));
    cache.set('b', pageOf(100));
    assert.ok(cache.get('a') && cache.get('b'), '300 bytes held, not 500');
  });

  test('re-setting a key moves it to the back, so the write is never what its own eviction drops', () => {
    // `Map.set` on an existing key keeps that key's original position. Without a delete first, growing the
    // oldest entry would overflow the budget and then evict that same entry — the cache dropping the page it
    // was just asked to store while keeping newer, smaller ones.
    const cache = createPageCache(100);
    cache.set('old', pageOf(10));
    cache.set('new', pageOf(80));
    cache.set('old', pageOf(90));
    assert.ok(cache.get('old'), 'the page just stored must survive its own eviction pass');
    assert.equal(cache.get('new'), undefined, 'the genuinely older entry is what goes');
  });
});

describe('checkReactVersions', () => {
  /** An app root with whatever versions of the two packages the case needs installed into it. */
  const appWith = (versions) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true }));
    for (const [name, version] of Object.entries(versions)) {
      mkdirSync(join(dir, 'node_modules', name), { recursive: true });
      writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
    }
    return dir;
  };

  test('refuses a react/react-dom split, naming both versions', () => {
    const dir = appWith({ react: '19.2.8', 'react-dom': '19.1.0' });
    assert.throws(() => checkReactVersions(dir), /react 19\.2\.8 and react-dom 19\.1\.0 resolve to different versions/);
    // The advice has to name the escape hatch, since a transitive dependency is the usual cause.
    assert.throws(() => checkReactVersions(dir), /overrides/);
  });

  test('accepts a matching pair', () => {
    checkReactVersions(appWith({ react: '19.2.8', 'react-dom': '19.2.8' }));
  });

  test('says nothing when neither is installed — the resolver reports that better', () => {
    checkReactVersions(appWith({}));
  });

  test('does not fire on a real app', () => {
    // The check runs on every dev and build, so a false positive here would break every one of them.
    checkReactVersions(MINIMAL_APP_DIR);
  });
});

describe('module resolution', () => {
  /** The `node_modules` a package was resolved out of, symlinks already followed by `require.resolve`. */
  const installedIn = (name) => {
    let dir = dirname(createRequire(import.meta.url).resolve(name));
    while (basename(dir) !== 'node_modules') dir = dirname(dir);
    return dir;
  };

  test('app source can resolve the RSC runtime the transform injects into it', () => {
    // Nothing in an app imports react-server-dom-rspack by hand — the RSC transform rewrites pages,
    // client components and server actions into imports of it, resolved from the app's own src/. Only
    // a hoisting package manager puts it within reach from there; pnpm installs the framework's
    // dependencies beside the framework instead, so the directory it really lives in has to be on the
    // search path or every pnpm install fails to build.
    const configs = createConfigs({ rootDir: MINIMAL_APP_DIR, isDev: false, config: {}, preset: NODE_PRESET });
    for (const config of configs) {
      const dirs = config.resolve.modules;
      assert.equal(dirs[0], 'node_modules', "an app's own dependencies still win");
      assert.ok(
        dirs.includes(installedIn('react-server-dom-rspack')),
        `${config.name}: react-server-dom-rspack is not reachable from app source — searched ${dirs.join(', ')}`,
      );
    }
  });
});

describe('server bundle externals', () => {
  const [, serverConfig] = createConfigs({ rootDir: MINIMAL_APP_DIR, isDev: false, config: {}, preset: NODE_PRESET });

  /** The hook's verdict for one request: `undefined` means "bundle it", a string means "leave it external". */
  const verdict = (request, contextInfo) => {
    let result;
    serverConfig.externals[0]({ request, contextInfo }, (error, value) => {
      if (error) throw error;
      result = value;
    });
    return result;
  };

  test('leaves third-party packages and node builtins to the runtime', () => {
    assert.equal(verdict('some-npm-package'), 'module-import some-npm-package');
    assert.equal(verdict('@scope/pkg/sub'), 'module-import @scope/pkg/sub');
    assert.equal(verdict('node:fs'), 'module-import node:fs');
  });

  test('bundles a third-party package reached from the SSR layer, whatever the target', () => {
    // The SSR layer is where `'use client'` components render on the server, and `env-shadow-loader` is what
    // keeps a secret out of that HTML. A loader cannot run on a module the bundle merely names, so an
    // externalized third-party client component was loaded raw at request time and read the real
    // `process.env` — a secret in the SSR stream on the one target that externalizes anything, `node`.
    //
    // Nothing is given up by bundling it: the same module is in the browser bundle too, so it was always
    // required to be bundleable.
    const ssr = { issuerLayer: 'server-side-rendering' };
    assert.equal(verdict('some-ui-library', ssr), undefined, 'a client component from node_modules must be compiled');
    assert.equal(verdict('@scope/ui/button', ssr), undefined);
    // The RSC layer is server-only code, and keeps the policy — that is what makes `node` builds fast and
    // lets a server component use a native addon.
    assert.equal(verdict('some-ui-library', { issuerLayer: 'react-server-components' }), 'module-import some-ui-library');

    // A builtin reached from the SSR layer is *deferred* by this hook rather than externalized by it, and
    // `target: 'node'` externalizes it through Rspack's `node` externals preset instead — the same division of
    // labour the serverless presets rely on when they drop this function altogether. `node:` imports surviving
    // into the emitted bundle is asserted end to end by the deploy-targets suite.
    assert.equal(verdict('node:fs', ssr), undefined, 'deferred here, and the node preset is what keeps it external');
    assert.equal(verdict('node:fs', { issuerLayer: 'react-server-components' }), 'module-import node:fs');
  });

  test('bundles the framework, React and Hono, which the server cannot resolve at runtime', () => {
    for (const request of [
      '@rshono/core',
      'react',
      'react-dom/server.edge',
      'hono/cookie',
      '@rshono/routes',
      '@/components/home',
      './entry.ssr.js',
    ]) {
      assert.equal(verdict(request), undefined, `${request} must be bundled`);
    }
  });

  test('bundles path requests on every platform, Windows drive letters included', () => {
    // Rspack asks for the RSC client and server-entry proxies by absolute path. Externalizing one
    // emits an `import()` of a raw filesystem path — harmless-looking on POSIX, where that parses as
    // a URL path, and fatal on Windows, where `D:\…` is read as an unsupported `d:` URL scheme.
    assert.equal(verdict('/app/src/components/home.tsx?rsc-server-entry-proxy=true'), undefined);
    assert.equal(
      verdict('D:\\app\\src\\components\\home.tsx?rsc-server-entry-proxy=true'),
      undefined,
      'a Windows path must never become import("D:\\…")',
    );
    assert.equal(verdict('D:/app/src/components/home.tsx'), undefined, 'forward-slash drive paths too');
    assert.equal(verdict('\\\\server\\share\\home.tsx'), undefined, 'and UNC paths');
  });
});

describe('the security-middleware build warning', () => {
  /** The minimal app somewhere disposable, plus whatever `src/server.ts` the case wants. */
  function appWithServer(serverSource) {
    const dir = mkdtempSync(join(tmpdir(), 'rshono-warn-'));
    symlinkSync(join(MINIMAL_APP_DIR, 'node_modules'), join(dir, 'node_modules'), 'junction');
    cpSync(join(MINIMAL_APP_DIR, 'package.json'), join(dir, 'package.json'));
    cpSync(join(MINIMAL_APP_DIR, 'src'), join(dir, 'src'), { recursive: true });
    if (serverSource !== null) writeFileSync(join(dir, 'src', 'server.ts'), serverSource);
    after(() => {
      // The link, not what it points at: `node_modules` is the fixture's, borrowed rather than copied.
      unlinkSync(join(dir, 'node_modules'));
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  }

  /** What `createConfigs` warns about for `rootDir`, as one string. Builds only — `dev` says nothing. */
  function warningsFor(rootDir, { isDev = false } = {}) {
    const warn = console.warn;
    const lines = [];
    console.warn = (...args) => lines.push(args.join(' '));
    try {
      createConfigs({ rootDir, isDev, config: {}, preset: NODE_PRESET });
    } finally {
      console.warn = warn;
    }
    return lines.join('\n');
  }

  test('an app with no src/server.ts is told it has neither control', () => {
    assert.match(warningsFor(MINIMAL_APP_DIR), /No src\/server\.ts/);
  });

  test('an app whose src/server.ts never registers bodyLimit is told about the body cap', () => {
    // Having a src/server.ts is not the same as having the cap in it, and this half used to be warned
    // about nowhere: the first check only ever asked whether the file existed. Every `'use server'`
    // export is a public POST endpoint, and the action path buffers the whole body before it can decide
    // anything about it.
    const dir = appWithServer("import { Hono } from 'hono';\nexport default new Hono();\n");
    const warnings = warningsFor(dir);
    assert.match(warnings, /No bodyLimit\(\) anywhere in src\//);
    assert.doesNotMatch(warnings, /No src\/server\.ts/, 'the file is there — only the cap is missing');
  });

  test('the scan is the whole of src/, so a cap registered from a helper module counts', () => {
    // A textual scan of one file would call this app unprotected. The failure mode of getting it wrong is
    // a warning nobody needed, so it reads wide rather than narrow.
    const dir = appWithServer("import { Hono } from 'hono';\nimport { security } from './security';\nexport default new Hono().use(security());\n");
    writeFileSync(
      join(dir, 'src', 'security.ts'),
      "import { bodyLimit } from 'hono/body-limit';\nexport const security = () => bodyLimit({ maxSize: 1024 });\n",
    );
    assert.equal(warningsFor(dir), '', 'a registered cap must not be reported as missing');
  });

  test('the testbed, which registers both, is warned about nothing — and dev is never warned at all', () => {
    assert.equal(warningsFor(TESTBED_DIR), '');
    assert.equal(warningsFor(MINIMAL_APP_DIR, { isDev: true }), '', 'a rebuild would print it every time');
  });
});

describe('the env-shadow prelude', () => {
  /** The prelude the builder actually generates, read off the rule that carries it. */
  function generatedPrelude() {
    const [, serverConfig] = createConfigs({ rootDir: MINIMAL_APP_DIR, isDev: false, config: {}, preset: NODE_PRESET });
    const rule = serverConfig.module.rules.find((entry) => entry.use?.[0]?.loader?.includes('env-shadow-loader'));
    assert.ok(rule, 'the SSR env-shadow rule has to be in the server config');
    return rule.use[0].options.prelude;
  }

  test('shadows env while leaving the rest of process reachable', () => {
    // The prelude replaces the whole `process` binding for the module it rewrites, and `react-dom/server` is in
    // that same layer — so anything reading `process.nextTick`, `process.version` or `process.platform` has to
    // still find it. That is why it is `Object.assign(Object.create(real process), { env })` and not a bare
    // `{ env }`. Evaluated rather than pattern-matched, because the property under test is what the code *does*.
    const read = new Function(
      'globalThis',
      `${generatedPrelude()} return { env: process.env, platform: process.platform, hasNextTick: typeof process.nextTick };`,
    );
    const result = read(globalThis);

    assert.equal(result.env.DATABASE_URL, undefined, 'a secret must not be readable through the shadowed env');
    assert.equal(result.env.NODE_ENV, 'production');
    assert.equal(result.platform, process.platform, 'every other member still resolves through the prototype chain');
    assert.equal(result.hasNextTick, 'function');
  });

  test('does not fall over where there is no process to inherit from', () => {
    // A deploy target need not have one — the same server config is what `workerd` compiles from.
    const read = new Function('globalThis', `${generatedPrelude()} return process.env.NODE_ENV;`);
    assert.equal(read({}), 'production');
  });
});

describe('env-shadow-loader', () => {
  const envShadowLoader = createRequire(import.meta.url)('../dist/builder/env-shadow-loader.cjs');
  const PRELUDE = 'const process = { env: {} }; ';
  const APP_SRC = join(tmpdir(), 'rshono-app', 'src');

  /**
   * The slice of Rspack's loader context this loader reads. `layer` is the layer the *module* is in, and
   * `resourcePath` decides whether a module counts as the app's own source for the warning below.
   */
  const run = (source, { layer = 'ssr', resourcePath = join(APP_SRC, 'component.tsx'), warnings } = {}) =>
    envShadowLoader.call(
      {
        getOptions: () => ({ prelude: PRELUDE, layer: 'ssr', appSrcPrefix: APP_SRC + sep }),
        _module: { layer },
        resourcePath,
        emitWarning: (warning) => warnings?.push(warning.message),
      },
      source,
    );

  test('shadows env only in the layer it was configured for', () => {
    const source = 'export const x = process.env.SECRET;';
    assert.equal(run(source, { layer: 'ssr' }), `${PRELUDE}${source}`, 'the SSR layer is the one that must be shadowed');
    assert.equal(run(source, { layer: 'rsc' }), source, 'a server component reads the real env');
    assert.equal(run(source, { layer: null }), source);
  });

  test('leaves a module that never mentions process untouched', () => {
    // The fast path: every module in the bundle now reaches this loader, so the common case has to be one
    // string scan and out.
    assert.equal(run('export const x = 1;'), 'export const x = 1;');
    // And a word that merely contains it is not a mention. Being wrong here only costs bytes, but
    // `child_process` and `preprocess` are common enough to be worth not paying for.
    for (const source of ['export const x = preprocess(1);', 'export const x = processEnv;', "import cp from 'node:child_process';"]) {
      assert.equal(run(source), source, `"${source}" must not drag the prelude in`);
    }
  });

  test('shadows every shape that reads the env through the process binding, not just the literal process.env', () => {
    // A gate on the substring `process.env` saw one shape out of six. The prelude replaces the whole
    // binding, so all of them are covered once it is emitted — `process?.env` above all, which is how env
    // access is written in code meant to run in a browser *and* on a server, i.e. in a `'use client'`
    // component. Every miss rendered the real value into the SSR'd HTML while the browser bundle saw the
    // `PUBLIC_`-only view: a leaked secret, and a hydration mismatch besides.
    for (const source of [
      'export const x = process.env.DATABASE_URL;',
      'const { DATABASE_URL } = process.env;',
      'export const x = process?.env.DATABASE_URL;',
      "export const x = process['env'].DATABASE_URL;",
      'const { env } = process;',
      'const p = process; export const x = p.env.DATABASE_URL;',
      "export const x = typeof process !== 'undefined' ? process.env.DATABASE_URL : '';",
    ]) {
      assert.equal(run(source), PRELUDE + source, `"${source}" must be shadowed`);
    }
  });

  test('warns when the app reads process through the global object, which no binding can shadow', () => {
    // `globalThis.process` is the real `process` however the module names it, so the prelude cannot reach
    // it — the read has to be found by a person. Only the app's own source is worth saying it about: a
    // library feature-detecting `globalThis.process?.env?.NODE_ENV` is doing nothing wrong and has no app
    // secret to read.
    for (const source of [
      'export const x = globalThis.process.env.DATABASE_URL;',
      'export const x = globalThis?.process?.env?.DATABASE_URL;',
      "export const x = global['process'].env.DATABASE_URL;",
      'export const x = self.process.env.DATABASE_URL;',
    ]) {
      const warnings = [];
      assert.equal(run(source, { warnings }), PRELUDE + source, 'the prelude is still emitted');
      assert.equal(warnings.length, 1, `"${source}" must be reported`);
      assert.match(warnings[0], /reads `process` through the global object/);
    }

    const fromLibrary = [];
    run('export const x = globalThis.process.env.NODE_ENV;', {
      resourcePath: join(tmpdir(), 'rshono-app', 'node_modules', 'ui', 'index.js'),
      warnings: fromLibrary,
    });
    assert.deepEqual(fromLibrary, [], 'a dependency is not the app author to tell');

    const rsc = [];
    run('export const x = globalThis.process.env.DATABASE_URL;', { layer: 'rsc', warnings: rsc });
    assert.deepEqual(rsc, [], 'a server component is meant to read the real env');

    const shadowed = [];
    run('export const x = process.env.DATABASE_URL;', { warnings: shadowed });
    assert.deepEqual(shadowed, [], 'the shape the shadow does cover says nothing');
  });

  test('inserts the prelude after the whole directive prologue, not after the first directive', () => {
    // Two directives is ordinary output from a published component library, and this loader now sees
    // `node_modules`. Splitting the pair would leave the second one preceded by a statement — an ordinary
    // expression rather than a directive — silently dropping either strict mode or `'use client'`.
    for (const [first, second] of [
      ["'use client';", "'use strict';"],
      ['"use strict";', '"use client";'],
    ]) {
      const source = `${first}\n${second}\nexport const x = process.env.SECRET;`;
      assert.equal(run(source), `${first}\n${second}\n${PRELUDE}export const x = process.env.SECRET;`, `${first} ${second} must stay adjacent`);
    }
  });

  test('carries comments, blank lines, semicolon-less directives and a three-directive run', () => {
    const prologue = "// banner\n/* block */\n'use strict'\n'use client'\n'use server'\n";
    const body = 'export const x = process.env.SECRET;';
    assert.equal(run(prologue + body), prologue + PRELUDE + body);
  });

  test('prepends to a module with no prologue at all', () => {
    const source = 'export const x = process.env.SECRET;';
    assert.equal(run(source), PRELUDE + source);
  });

  test('fails the build rather than shipping unshadowed when it cannot read the layer', () => {
    // `_module` is a private Rspack field. A silent no-op if it were ever renamed would drop the guarantee
    // that keeps server secrets out of SSR-rendered client components, with nothing to notice.
    assert.throws(
      () => envShadowLoader.call({ getOptions: () => ({ prelude: PRELUDE, layer: 'ssr' }) }, 'process.env.SECRET'),
      /could not read the module's layer/,
    );
  });
});

describe('walkHotUpdates', () => {
  // A fake of the bundler's hot runtime. `chain` maps the hash the page is on to the hash the next
  // `*.hot-update.json` moves it to — exactly the file-per-build chain the real one walks; a hash
  // missing from it is a 404, which the real runtime reports as "no update", not as an error.
  function fakeHot({ from, chain, status = () => 'idle' }) {
    const state = { hash: from, checks: 0 };
    return [
      state,
      {
        status,
        async check() {
          state.checks++;
          const next = chain.get(state.hash);
          if (next === undefined) return null;
          if (next instanceof Error) throw next;
          state.hash = next;
          return ['some/module.js'];
        },
      },
    ];
  }

  const walk = (state, hot, target) =>
    walkHotUpdates(
      hot,
      () => state.hash,
      () => target,
    );

  test('walks one build at a time until the page is on the target', async () => {
    const [state, hot] = fakeHot({
      from: 'a',
      chain: new Map([
        ['a', 'b'],
        ['b', 'c'],
      ]),
    });
    assert.equal(await walk(state, hot, 'c'), null);
    assert.equal(state.hash, 'c');
    assert.equal(state.checks, 2, 'each round should advance exactly one build');
  });

  test('does nothing when the page is already on the target', async () => {
    const [state, hot] = fakeHot({ from: 'a', chain: new Map() });
    assert.equal(await walk(state, hot, 'a'), null);
    assert.equal(state.checks, 0);
  });

  test('gives up instead of spinning when the update chain is broken', async () => {
    // The regression this exists for. A missing manifest 404s, and the runtime resolves `check` with
    // null rather than rejecting — so a walk that only stops on "reached the target" or "threw" keeps
    // re-requesting that same 404 forever, and the page never picks up another change. Restarting the
    // dev server puts every open tab in exactly this state: starting up wipes `dist`.
    const [state, hot] = fakeHot({ from: 'gone', chain: new Map() });
    const giveUp = await walk(state, hot, 'latest');
    assert.match(giveUp?.reason ?? '', /cannot be applied/);
    assert.equal(state.checks, 1, 'the unreachable target must be given up on after a single round');
  });

  test('gives up when an update applies without moving the page forward', async () => {
    const [state, hot] = fakeHot({ from: 'a', chain: new Map([['a', 'a']]) });
    const giveUp = await walk(state, hot, 'z');
    assert.match(giveUp?.reason ?? '', /cannot be applied/);
    assert.equal(state.checks, 1);
  });

  test('gives up, carrying the error, when an update cannot be applied', async () => {
    const failure = new Error('module declined the update');
    const [state, hot] = fakeHot({ from: 'a', chain: new Map([['a', failure]]) });
    const giveUp = await walk(state, hot, 'b');
    assert.equal(giveUp?.error, failure);
  });

  test('gives up when another update is already in flight', async () => {
    const [state, hot] = fakeHot({ from: 'a', chain: new Map([['a', 'b']]), status: () => 'apply' });
    assert.match((await walk(state, hot, 'b'))?.reason ?? '', /already in flight/);
    assert.equal(state.checks, 0, 'check() may only be called from idle');
  });

  test('absorbs builds that land mid-walk rather than finishing against a stale target', async () => {
    // Both hashes are read fresh each round precisely so a save during a walk extends it: the page
    // ends up on the newest build instead of stopping at the one the walk started for.
    const [state, hot] = fakeHot({
      from: 'a',
      chain: new Map([
        ['a', 'b'],
        ['b', 'c'],
      ]),
    });
    let target = 'b';
    const done = walkHotUpdates(
      hot,
      () => state.hash,
      () => target,
    );
    target = 'c';
    assert.equal(await done, null);
    assert.equal(state.hash, 'c');
  });
});

describe('validateRoutesModule', () => {
  // The app's own `src/routes.ts`, checked before anything is built on it. Everything below either
  // crashed somewhere unrelated (`nN is not iterable`, from a minified bundle) or did nothing at all.
  const page = { path: '/', component: () => Promise.resolve({ default: () => null }) };
  const endpoint = { type: 'endpoint', path: '/api/x', server: () => Promise.resolve({ handler: () => null }) };
  const rejects = (exported, expected) => assert.throws(() => validateRoutesModule(exported), expected);

  test('accepts both shapes the docs present, so leaving off defineRoutes is not a trap', () => {
    assert.deepEqual(validateRoutesModule([page]), { routes: [page] });
    const config = { routes: [page], notFound: { component: page.component } };
    assert.equal(validateRoutesModule(config), config, 'a config is returned as it came');
  });

  test('names src/routes.ts when the export is not a route table at all', () => {
    for (const exported of [undefined, null, 42, {}, { routes: 'nope' }]) {
      rejects(exported, /\[rshono\] src\/routes\.ts must export `routes`/);
    }
  });

  test('names the entry that is wrong, by position and by path', () => {
    rejects([page, null], /routes\[1\] is null, not a route object/);
    rejects([page, { component: page.component }], /routes\[1\] needs a `path` starting with "\/"/);
    rejects([{ path: 'docs', component: page.component }], /routes\[0\] \("docs"\) needs a `path` starting with "\/"/);
    rejects([{ path: '/x' }], /routes\[0\] \("\/x"\) needs `component`/);
    rejects([{ type: 'page', path: '/x', component: page.component }], /the only `type` is 'endpoint'/);
    rejects([{ type: 'endpoint', path: '/api/x' }], /is an endpoint, so it needs `server`/);
  });

  // Excess-property checking against a union accepts any key present in *some* member, so these
  // type-check today and are then silently ignored — which looks exactly like a feature not working.
  test('refuses a key that belongs to the other kind of route', () => {
    rejects([{ ...endpoint, render: 'static' }], /has `render`, which only a page route has/);
    rejects([{ ...endpoint, staticPaths: async () => [] }], /has `staticPaths`, which only a page route has/);
    rejects([{ ...page, method: 'get' }], /has `method`, which only an endpoint route has/);
    rejects([{ ...page, server: endpoint.server }], /has `server`, which only an endpoint route has/);
  });

  test('refuses a staticPaths the build would never call', () => {
    rejects([{ ...page, path: '/docs/:slug', staticPaths: async () => [{ slug: 'a' }] }], /is not `render: 'static'`/);
    rejects([{ ...page, render: 'static', staticPaths: 'nope' }], /`staticPaths` that is not a function/);
    rejects([{ ...page, render: 'lazy' }], /has render "lazy" — it is 'static' or 'dynamic'/);
  });

  test("refuses a method the router cannot match, and points 'head' at 'get'", () => {
    rejects([{ ...endpoint, method: 'HEAD' }], /has method "HEAD", which is not one of get, post/);
    rejects([{ ...endpoint, method: 'head' }], /A HEAD is dispatched as a GET, so use 'get'/);
  });

  // The one that built cleanly, exited 0 and said nothing: Hono matches in registration order.
  test('refuses a route every method of which the table already answers', () => {
    rejects(
      [page, { ...page, component: page.component }],
      /routes\[1\] \("\/"\) would never run — routes\[0\] \("\/"\) already answers GET, POST \//,
    );
    rejects([endpoint, { ...endpoint, method: 'get' }], /already answers GET \/api\/x/, 'an `all` endpoint claims every method');
    rejects([{ ...endpoint, path: '/' }, page], /already answers GET, POST \//, 'an endpoint shadows a page at the same path too');
  });

  test('leaves a route that still answers something alone', () => {
    for (const table of [
      // One path split across two methods — an ordinary thing to write.
      [
        { ...endpoint, method: 'get' },
        { ...endpoint, method: 'post' },
        { ...page, path: '/other' },
      ],
      // A catch-all behind a route claiming one method of the path: it still answers PUT, DELETE, …
      [{ ...endpoint, method: 'post' }, endpoint],
      // Overlapping *patterns* are the router's business, and specific-before-generic is the point.
      [
        { ...page, path: '/docs/getting-started' },
        { ...page, path: '/docs/:slug' },
      ],
    ]) {
      assert.deepEqual(validateRoutesModule(table).routes, table);
    }
  });

  test('checks the two framework-owned pages as well', () => {
    rejects({ routes: [page], notFound: {} }, /`notFound` must be a page/);
    rejects({ routes: [page], error: () => null }, /`error` must be a page/);
  });
});

describe('validateServerApp', () => {
  test('takes the Hono app, or nothing where the app has no src/server.ts', () => {
    // What the empty fallback module the alias resolves to default-exports.
    assert.equal(validateServerApp({ default: null }), null);
    assert.equal(validateServerApp({}), null);
    assert.equal(validateServerApp(null), null);
    const app = { fetch: () => null, routes: [] };
    assert.equal(validateServerApp({ default: app }), app);
  });

  test('names src/server.ts rather than letting Hono throw from inside app.route()', () => {
    for (const value of [{ notAHono: true }, 'nope', 42, { fetch: () => null }]) {
      assert.throws(() => validateServerApp({ default: value }), /\[rshono\] src\/server\.ts must `export default` a Hono app/);
    }
  });
});
