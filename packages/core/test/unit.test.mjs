// Unit tests for the pure pieces — the parsers, path maths and header helpers the e2e suite only
// exercises indirectly through one happy path. They import the *built* package, so they double as a
// check that dist is importable from plain Node.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { scanPageFiles } from '../dist/builder/page-files.js';
import { checkReactVersions } from '../dist/builder/react-versions.js';
import { createConfigs } from '../dist/builder/rspack-config.js';
import { DEPLOY_TARGETS, deployHintFor, NODE_PRESET, resolveDeployPreset } from '../dist/deploy/presets.js';
import { appendVary, etagMatches } from '../dist/server/headers.js';
import { loadConfig } from '../dist/server/load-config.js';
import { parsePort, resolveServerConfig } from '../dist/server/server-config.js';
import { createPageCache, ssgAssetPath, ssgFilePath } from '../dist/server/prerendered.js';
import { prerenderStaticRoutes, readPrerendered, resolveSiteOrigin } from '../dist/server/ssg.js';
import { injectFlightPayload } from '../dist/runtime/flight-inject.js';
import { asksForRsc, createRscRequest, isActionRequest, parseRenderRequest, wantsRsc } from '../dist/runtime/request.js';
import { isControlDigest, parseRedirectDigest, RedirectSignal } from '../dist/runtime/control.js';
import {
  beginPageRender,
  getRequestContext,
  onServerError,
  publicUrl,
  reportServerError,
  RequestContext,
  runWithContext,
} from '../dist/runtime/context.js';
import { walkHotUpdates } from '../dist/runtime/hot-update.js';
import { assertRouteModules, validateRoutesModule, validateServerApp } from '../dist/runtime/validate-entries.js';
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

  // The five splits above all land in one batch: they are enqueued synchronously, so the boundary macrotask
  // has not run between them. This one puts a real macrotask between the halves, which is the only shape
  // `emitBatch` can miss — it tests the joined batch, and a tail is what carries the miss across batches.
  // React does not produce it (its final flush is one synchronous run), but this injector exists precisely
  // because `rsc-html-stream` made a narrower version of that same assumption, so it is guarded rather than
  // asserted about React.
  test('holds back a document trailer split across two batches', async () => {
    /** One chunk per batch: the wait is long enough that the injector's boundary has fired in between. */
    const batchedStreamOf = (chunks) => {
      let next = 0;
      return new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (next >= chunks.length) controller.close();
          else controller.enqueue(encoder.encode(chunks[next++]));
        },
      });
    };

    const html = await readAll(batchedStreamOf(['<html><body><p>hi</p></bo', 'dy></html>']).pipeThrough(injectFlightPayload(streamOf(['0:"hi"\n']))));
    assert.equal(countOf(html, '</body></html>'), 1, 'exactly one trailer, however the batches fell');
    assert.ok(html.indexOf('__FLIGHT_DATA') < html.indexOf('</body></html>'), 'the script must not land inside the trailer');
    assert.match(html, /<script>\(self\.__FLIGHT_DATA\|\|=\[\]\)\.push\("0:\\"hi\\"\\n"\)<\/script><\/body><\/html>$/);

    // The other half of holding a tail back: one that never completes still has to come back out. It comes
    // out *after* the payload scripts, which is deliberate — releasing it as soon as a script wants to go out
    // is exactly the bug above, since the next batch may be the rest of the trailer. Only a truncated
    // document can reach this, it is 13 bytes at most, and they stay inside `<body>`.
    const stump = await readAll(batchedStreamOf(['<html><body>a</bod']).pipeThrough(injectFlightPayload(streamOf(['0:"hi"\n']))));
    assert.match(stump, /^<html><body>a<script>.*<\/script><\/bod<\/body><\/html>$/, 'a tail that was not a trailer is not lost');
  });

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

  // The `atob` fallback is how a binary row — a `Uint8Array` a server component handed a client one —
  // survives the trip through a `<script>` tag. Reassembles the payload the way `entry.client.tsx` does,
  // by running the emitted script bodies against a `__FLIGHT_DATA` shim, and asserts the bytes are the
  // bytes that went in.
  async function replayPayload(payloadChunks) {
    const out = streamOf(['<html><body>hi</body></html>']).pipeThrough(injectFlightPayload(streamOf(payloadChunks)));
    const html = await readAll(out);
    const parts = [];
    for (const [, body] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      new Function('self', body)({ __FLIGHT_DATA: { push: (chunk) => parts.push(chunk) } });
    }
    return Buffer.concat(parts.map((part) => Buffer.from(typeof part === 'string' ? encoder.encode(part) : part)));
  }

  test('carries binary payload bytes through the document byte-exactly', async () => {
    // The chunk boundary is the hazard: a payload cut mid-character used to leave its lead bytes inside a
    // streaming decoder, and the next chunk's `atob` fallback — which re-encodes only the chunk that threw —
    // dropped them. The client then reassembled a payload short by those bytes and failed to hydrate.
    const payload = Buffer.from('303a22e282ac220a313afffe0a', 'hex');
    const got = await replayPayload([payload.subarray(0, 5), payload.subarray(5)]);
    assert.deepEqual(got, payload, 'the client must read back exactly the bytes the server wrote');
  });

  test('keeps a byte-order mark that opens a payload chunk', async () => {
    // Decoding per chunk re-runs the BOM check on every call, so the decoder is `ignoreBOM`.
    const payload = Buffer.from('efbbbf41', 'hex');
    assert.deepEqual(await replayPayload([payload]), payload);
  });

  test('completes the response when the payload ends mid-character', async () => {
    // The end-of-stream flush on a `fatal` decoder holding an incomplete sequence threw from outside any
    // `try`, and the rejection errored the response stream: a truncated document with no trailer.
    const out = streamOf(['<html><body>hi</body></html>']).pipeThrough(
      injectFlightPayload(streamOf([encoder.encode('0:"hi"\n'), Uint8Array.from([0x31, 0x3a, 0x22, 0xe2])])),
    );
    const html = await readAll(out);
    assert.equal(countOf(html, '</body></html>'), 1, 'the document still has to be closed');
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

  // A slow client must park the producers rather than let them run to completion into the readable's queue.
  // The payload pump is the half that had no gate at all: it writes into the transform's controller from a
  // detached promise, so nothing about the transform's own backpressure applied to it.
  test('stops producing while the consumer is not reading', async () => {
    let htmlPulled = 0;
    let flushes = 0;
    // Shaped like React: a run of chunks per flush, flushes separated by a macrotask.
    const html = new ReadableStream({
      async pull(controller) {
        if (htmlPulled % 5 === 0) {
          flushes++;
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (++htmlPulled > 500) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode('<p>hi</p>'));
      },
    });
    let flightPulled = 0;
    const flight = new ReadableStream({
      pull(controller) {
        if (++flightPulled > 500) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${flightPulled}:"hi"\n`));
      },
    });

    const reader = html.pipeThrough(injectFlightPayload(flight)).getReader();
    await reader.read(); // one chunk, then stall — a client that stopped reading
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(flightPulled < 10, `the payload must park, not run to completion (pulled ${flightPulled})`);
    assert.ok(htmlPulled < 20, `the document must park, not run to completion (pulled ${htmlPulled})`);
    assert.ok(flushes >= 1, 'sanity: the source did produce');

    // And reading again has to resume it, rather than having deadlocked on a permit nobody releases.
    const before = flightPulled;
    for (let i = 0; i < 20; i++) await reader.read();
    assert.ok(flightPulled > before, 'reading again must resume the payload');
    await reader.cancel();
  });
});

// Two fields, because only two things here are decided by the build. The CSRF check, the CSP and the
// body cap used to live alongside them and are now Hono middleware an app registers in src/server.ts
// — see prod-config.test.mjs, which exercises them over HTTP rather than through a resolver.
// The ambient context, which every `getRequestContext()` call in an app resolves through. Sequential tests
// cannot see the failure that matters here: one request reading another's context.
describe('runWithContext', () => {
  const contextFor = (path) => ({ req: { url: `http://example.test${path}`, param: () => ({}) }, env: {} });

  test('keeps one context per flow across suspensions', async () => {
    const seen = [];
    /** Reads the ambient context either side of an await, so what is asserted is that the store survives one. */
    const flow = (path, delay) =>
      runWithContext(contextFor(path), async () => {
        const before = getRequestContext().url.pathname;
        await new Promise((resolve) => setTimeout(resolve, delay));
        const after = getRequestContext().url.pathname;
        seen.push({ path, before, after });
      });

    // Interleaved deliberately: the longest-running flow starts first and finishes last, so every other
    // flow enters and leaves inside it.
    await Promise.all([flow('/a', 30), flow('/b', 5), flow('/c', 15), flow('/d', 0)]);

    assert.equal(seen.length, 4);
    for (const { path, before, after } of seen) {
      assert.equal(before, path, `${path} read the wrong context before its await`);
      assert.equal(after, path, `${path} read the wrong context after its await — another flow's store leaked in`);
    }
  });

  test('throws outside a flow rather than resolving to the last one that ran', () => {
    assert.throws(() => getRequestContext(), /outside a request/);
  });

  test('hands back the same wrapper for the same request, and a different one for another', () => {
    const c = contextFor('/a');
    const [first, second] = runWithContext(c, () => [getRequestContext(), getRequestContext()]);
    assert.equal(first, second, 'memoised per request, so repeated calls are one object');
    assert.notEqual(runWithContext(contextFor('/a'), getRequestContext), first, 'and never shared between requests');
  });
});

// The single funnel every caught server-side error goes through. `prod.test.mjs` covers the happy path over
// HTTP; these are the parts an app only meets when something else has already gone wrong.
describe('reportServerError', () => {
  const hono = { req: { raw: new Request('http://example.test/boom') } };
  const report = (error, source = 'request') => reportServerError(error, { source, hono, message: '[rshono] test:' });

  /** Runs `body` with `console.error` collected rather than printed — every report writes one. */
  function withStderr(body) {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.map(String).join(' '));
    try {
      body(lines);
    } finally {
      console.error = original;
    }
    return lines;
  }

  // Registered handlers are module state with no way to unregister, so every test sets its own and the
  // last one leaves a no-op behind.
  after(() => onServerError(() => {}));

  test('hands the handler the source, the request and the Hono context, and still writes to stderr', () => {
    const seen = [];
    onServerError((error, context) => seen.push({ error, ...context }));
    const lines = withStderr(() => report(new Error('boom'), 'action'));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].source, 'action');
    assert.equal(seen[0].error.message, 'boom');
    assert.equal(seen[0].request.url, 'http://example.test/boom', 'the request is derived from the context');
    assert.equal(seen[0].hono, hono);
    assert.equal(typeof seen[0].waitUntil, 'function');
    assert.match(lines.join('\n'), /\[rshono\] test:/, 'a handler must not replace the stderr log');
  });

  test('reports one fault once, however many stages catch it', () => {
    const seen = [];
    onServerError((_error, { source }) => seen.push(source));
    withStderr(() => {
      const error = new Error('one fault');
      // What a thrown server action does: reported where it is known to be an action, then re-thrown, which
      // lands it in the top-level handler as well. Two sources for one fault is worse than only the outer.
      report(error, 'action');
      report(error, 'request');
    });
    assert.deepEqual(seen, ['action'], 'the first stage to recognise it wins — it is the one that knows what it was');
  });

  test('reports a primitive throw wherever it is caught, having nothing to track it by', () => {
    const seen = [];
    onServerError((_error, { source }) => seen.push(source));
    withStderr(() => {
      report('a string', 'render');
      report('a string', 'request');
    });
    assert.deepEqual(seen, ['render', 'request'], 'a primitive cannot go in a WeakSet, so it is reported twice');
  });

  test('a handler that throws is caught and logged, and does not fail the request', () => {
    onServerError(() => {
      throw new Error('the tracker is down');
    });
    const lines = withStderr(() => {
      assert.doesNotThrow(() => report(new Error('boom')), 'reporting can never be what fails a request');
    });
    assert.match(lines.join('\n'), /the onServerError handler threw/);
    assert.match(lines.join('\n'), /the tracker is down/, 'and the handler’s own error is not swallowed');
  });

  test('registering again replaces the previous handler', () => {
    const calls = [];
    onServerError(() => calls.push('first'));
    onServerError(() => calls.push('second'));
    withStderr(() => report(new Error('boom')));
    assert.deepEqual(calls, ['second'], 'one funnel, not a growing list');
  });

  test('waitUntil is a no-op where the platform has no execution context, and swallows a rejection', async () => {
    // `c.executionCtx` *throws* rather than answering undefined, so a handler reaching for it itself would
    // have its report swallowed by the guard above — on exactly the platforms where nothing needed holding
    // open. And an unhandled rejection from a report must not be what ends the process.
    const rejections = [];
    const onRejection = (error) => rejections.push(error);
    process.on('unhandledRejection', onRejection);
    // Captured across the await rather than with `withStderr`: the rejection is logged a tick after the
    // report returns, which is exactly the window that helper closes.
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.map(String).join(' '));
    try {
      onServerError((_error, { waitUntil }) => {
        assert.doesNotThrow(() => waitUntil(Promise.resolve('sent')));
        waitUntil(Promise.reject(new Error('the tracker refused it')));
      });
      report(new Error('boom'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(rejections, [], 'a failed report must not surface as an unhandled rejection');
      assert.match(lines.join('\n'), /waitUntil rejected/);
      assert.match(lines.join('\n'), /the tracker refused it/);
    } finally {
      console.error = original;
      process.off('unhandledRejection', onRejection);
    }
  });
});

// Every branch here ends in a message someone reads while a build is failing, and only the happy path of
// `--config` was covered — indirectly, by `prod-config.test.mjs` building with a fixture config.
describe('loadConfig', () => {
  test('returns an empty config where the project has none', async () => {
    assert.deepEqual(await loadConfig(tempDir()), {}, 'no config file is not an error — every field has a default');
  });

  test('finds rshono.config.{ts,js,mjs} at the root, in that order', async () => {
    for (const [name, marker] of [
      ['rshono.config.ts', 'ts'],
      ['rshono.config.js', 'js'],
      ['rshono.config.mjs', 'mjs'],
    ]) {
      const dir = tempDir();
      writeFileSync(join(dir, name), `export default { siteUrl: 'https://${marker}.example' };\n`);
      assert.equal((await loadConfig(dir)).siteUrl, `https://${marker}.example`, `${name} must be found`);
    }

    // Precedence, so a leftover file cannot quietly win: .ts first.
    const dir = tempDir();
    writeFileSync(join(dir, 'rshono.config.mjs'), "export default { siteUrl: 'https://mjs.example' };\n");
    writeFileSync(join(dir, 'rshono.config.ts'), "export default { siteUrl: 'https://ts.example' };\n");
    assert.equal((await loadConfig(dir)).siteUrl, 'https://ts.example');
  });

  test('names an explicit --config that is not there, rather than failing later', async () => {
    const missing = join(tempDir(), 'nope.config.mjs');
    await assert.rejects(loadConfig(tempDir(), missing), /\[rshono\] config file not found: /);
  });

  test('resolves a relative --config against the working directory', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'custom.config.mjs'), "export default { siteUrl: 'https://custom.example' };\n");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal((await loadConfig(tempDir(), 'custom.config.mjs')).siteUrl, 'https://custom.example');
    } finally {
      process.chdir(cwd);
    }
  });

  test('says a config with no default export is missing one', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'rshono.config.mjs'), "export const config = { siteUrl: 'https://x.example' };\n");
    await assert.rejects(loadConfig(dir), /must `export default` a config object/);
  });

  // The bespoke branch: Node strips types itself, and the one thing it will not do is rewrite a `.js`
  // specifier to the `.ts` file beside it. Without the hint this surfaces as a raw ERR_MODULE_NOT_FOUND
  // naming a path that does exist — as a .ts file.
  test("explains a .ts config importing a sibling by its '.js' specifier", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'shared.ts'), 'export const siteUrl = "https://shared.example";\n');
    writeFileSync(join(dir, 'rshono.config.ts'), "import { siteUrl } from './shared.js';\nexport default { siteUrl };\n");
    await assert.rejects(loadConfig(dir), (error) => {
      assert.match(error.message, /imports a module Node could not resolve/);
      assert.match(error.message, /does not rewrite a \.js specifier/);
      assert.equal(error.cause?.code, 'ERR_MODULE_NOT_FOUND', 'the original is kept as the cause');
      return true;
    });

    // And the same import by its real extension loads, so the advice is advice that works. In a directory
    // of its own: Node's module registry keeps the failed load above under its URL, so rewriting the file
    // in place would re-throw it.
    const fixed = tempDir();
    writeFileSync(join(fixed, 'shared.ts'), 'export const siteUrl = "https://shared.example";\n');
    writeFileSync(join(fixed, 'rshono.config.ts'), "import { siteUrl } from './shared.ts';\nexport default { siteUrl };\n");
    assert.equal((await loadConfig(fixed)).siteUrl, 'https://shared.example');
  });

  test('lets any other import failure through as itself', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'rshono.config.mjs'), 'throw new Error("config blew up");\n');
    await assert.rejects(loadConfig(dir), /config blew up/, 'a config that throws must not be dressed up as a resolution hint');
  });
});

// The browser-facing URL, which is what `csrf()` and every absolute link the app builds depend on. Reached
// only through `prod-config.test.mjs`'s `csrf()` assertions until now, so the pieces below — a forwarded
// chain, a forwarded host with no port, a host that is not one — were covered end to end at best and not at
// all in the cases the e2e app does not send.
describe('publicUrl', () => {
  /** The two members `publicUrl` reads, and nothing else, so the test says what it depends on. */
  const request = (url, headers = {}) => ({ req: { url, header: (name) => headers[name.toLowerCase()] } });

  test('ignores the forwarded headers when trustProxy is off', () => {
    const url = publicUrl(request('http://127.0.0.1:3000/a?b=1', { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }));
    assert.equal(url.href, 'http://127.0.0.1:3000/a?b=1', 'the default must be the address the server was reached on');
  });

  describe('with trustProxy on', () => {
    // The flag is a module-level const read from the `DefinePlugin` global when the module is first
    // evaluated, so the only way to reach the other branch is a fresh module instance with the global
    // already set. The query string is what makes the import fresh.
    let trusted;
    before(async () => {
      globalThis.__RSHONO_CONFIG__ = { trustProxy: true, isDev: false };
      trusted = (await import('../dist/runtime/context.js?trustProxy=1')).publicUrl;
    });
    after(() => {
      delete globalThis.__RSHONO_CONFIG__;
    });

    test('takes the host and scheme the browser used, and drops the internal port', () => {
      // The port is the subtle one: assigning `url.host` would keep :3000 when the new value has none,
      // which is why the implementation parses instead. Asserted end to end once; never in isolation.
      const url = trusted(request('http://127.0.0.1:3000/a?b=1', { 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https' }));
      assert.equal(url.href, 'https://example.com/a?b=1');
    });

    test('keeps a port the forwarded host names', () => {
      const url = trusted(request('http://127.0.0.1:3000/', { 'x-forwarded-host': 'example.com:8443', 'x-forwarded-proto': 'https' }));
      assert.equal(url.href, 'https://example.com:8443/');
    });

    test('honours the first hop of a proxy chain, which is the client-facing one', () => {
      const url = trusted(
        request('http://127.0.0.1:3000/', { 'x-forwarded-host': 'example.com, inner.local:8080', 'x-forwarded-proto': 'https, http' }),
      );
      assert.equal(url.href, 'https://example.com/', 'a chain appends, so the browser-facing value is the first entry');
    });

    test('leaves the URL alone where a header is not usable', () => {
      const internal = 'http://127.0.0.1:3000/a';
      // A host no URL can hold, an empty value, and a scheme a browser could not have requested. Each
      // leaves that half of the URL as it was rather than throwing or guessing.
      assert.equal(trusted(request(internal, { 'x-forwarded-host': 'a b' })).href, internal, 'an unparseable host');
      assert.equal(trusted(request(internal, { 'x-forwarded-host': '  ' })).href, internal, 'a blank host');
      assert.equal(trusted(request(internal, { 'x-forwarded-host': ', example.com' })).href, internal, 'a blank first hop');
      assert.equal(trusted(request(internal, { 'x-forwarded-proto': 'ftp' })).href, internal, 'a scheme that is not http(s)');
      assert.equal(trusted(request(internal, { 'x-forwarded-proto': 'HTTPS' })).href, internal, 'and it is compared case-sensitively');
    });

    test('returns a fresh URL each call, so a caller mutating one cannot affect the next', () => {
      const c = request('http://127.0.0.1:3000/', { 'x-forwarded-host': 'example.com' });
      const first = trusted(c);
      first.pathname = '/mutated';
      assert.equal(trusted(c).pathname, '/');
    });
  });
});

describe('resolveServerConfig', () => {
  test('applies the documented defaults', () => {
    const config = resolveServerConfig({}, { isDev: false });
    assert.equal(config.trustProxy, false, 'proxy headers are never trusted by default');
    assert.equal(config.isDev, false, 'the build mode is baked in rather than read from NODE_ENV at runtime');
    assert.equal(config.envBindings, false, 'no platform supplies bindings unless its preset says so');
  });

  // Only `cloudflare` passes it, and `ctx.env` merges `c.env` on exactly that condition. Defaulting the
  // other way would spread an adapter's private handles — a live socket, or a whole Lambda invocation —
  // into an object typed `Record<string, string | undefined>`.
  test('records whether the selected platform supplies bindings', () => {
    assert.equal(resolveServerConfig({}, { isDev: false, envBindings: true }).envBindings, true);
    assert.equal(resolveServerConfig({}, { isDev: false, envBindings: undefined }).envBindings, false);
  });

  test('forces trustProxy on in dev, where the framework owns the proxy', () => {
    const config = resolveServerConfig({ trustProxy: false }, { isDev: true });
    assert.equal(config.trustProxy, true);
    assert.equal(config.isDev, true);
  });
});

// The same parse backs `--port`, `PORT` in the CLI, and `PORT` in the node bundle — one function, so the
// three cannot drift apart. `test/start.test.mjs` covers what the CLI does with the result.
describe('parsePort', () => {
  test('reads a port, including 0 — "any free port"', () => {
    assert.equal(parsePort('3000', 'PORT'), 3000);
    assert.equal(parsePort('0', 'PORT'), 0, 'an explicit 0 is a request, not an accident');
    assert.equal(parsePort('65535', 'PORT'), 65535);
    assert.equal(parsePort(' 8080 ', 'PORT'), 8080, 'a shell heredoc or a .env file leaves whitespace behind');
  });

  test('reads blank as unset rather than as port 0', () => {
    assert.equal(parsePort(undefined, 'PORT'), undefined);
    assert.equal(parsePort('', 'PORT'), undefined, 'an empty PORT is common in CI and container templates');
    assert.equal(parsePort('   ', 'PORT'), undefined);
  });

  test('refuses anything else, naming the source and the value', () => {
    for (const value of ['abc', '-1', '65536', '3.5', '0x50', '1e3', '+80']) {
      assert.throws(
        () => parsePort(value, '--port'),
        (error) => error instanceof RangeError && error.message.includes('--port') && error.message.includes(JSON.stringify(value)),
        `${value} is not a port`,
      );
    }
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
    const attempts = ['/../secret', '/docs/../../etc/passwd', '/..', '/docs/..', '/./docs', '/docs/./x', '/%2e%2e/secret', '/..%2f', '/..%2F'];
    for (const attempt of attempts) {
      assert.equal(ssgFilePath(attempt, 'html'), null, `${attempt} must not resolve to a file`);
    }
  });

  // Not a traversal, and pinned so nobody "fixes" it into one: a double-encoded escape decodes to the
  // literal text `..%2f`, which is one ordinary directory name. The single-encoded forms above are the
  // ones that decode to a separator, and those are refused.
  test('treats a double-encoded escape as the literal name it is', () => {
    assert.equal(ssgFilePath('/..%252f'), '..%2f/index.html');
  });

  // The guard checks *decoded* segments, so what arrives decoded and what does not is load-bearing. Both
  // layers below are upstream, and neither is ours to change — hence a test rather than a comment.
  test('the upstream layers the guard is written against keep their promises', async () => {
    // 1. The URL parser resolves a percent-encoded dot segment when the Request is built, so `%2e%2e`
    //    never reaches a handler as a segment at all.
    for (const encoded of ['%2e%2e', '%2E%2E']) {
      assert.equal(new URL(`/docs/${encoded}/x`, 'http://example.test').pathname, '/x', `${encoded} must be resolved by the URL parser`);
    }

    // 2. Hono hands a handler the path with `decodeURI` run over it, which is the form `ssgFilePath`
    //    stores under — and `decodeURI` leaves the reserved escapes alone, so a `%2F` arrives as an escape
    //    rather than as a separator and cannot smuggle a second segment past the router. The framework's
    //    own per-segment `decodeURIComponent` is what then refuses it as a file name (asserted above).
    const { Hono } = await import('hono');
    const app = new Hono();
    const seen = [];
    app.get('*', (c) => {
      seen.push(c.req.path);
      return c.text('ok');
    });
    for (const path of ['/docs/caf%C3%A9', '/docs/a%2Fb']) await app.fetch(new Request(`http://example.test${path}`));
    assert.deepEqual(seen, ['/docs/café', '/docs/a%2Fb'], 'a non-reserved escape arrives decoded; a %2F arrives as itself');
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

  // What the build's manifest is for: a `render: 'static'` route the build wrote nothing for — no
  // `staticPaths`, a param it never saw, a page that did not render cleanly — falls through to SSR on every
  // request, and misses are deliberately not cached, so without the index each of those pays a failed read
  // first, forever.
  test('does not touch the store for a path the build did not write', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'listed'), { recursive: true });
    writeFileSync(join(dir, 'listed', 'index.html'), '<!DOCTYPE html><p>listed</p>');
    mkdirSync(join(dir, 'unlisted'), { recursive: true });
    writeFileSync(join(dir, 'unlisted', 'index.html'), '<!DOCTYPE html><p>unlisted</p>');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: ['listed/index.html'] }));

    assert.ok(await readPrerendered(dir, '/listed'), 'a page the build recorded is served');
    assert.equal(await readPrerendered(dir, '/unlisted'), null, 'the index is what the store holds — not whatever is on disk');
    assert.equal(await readPrerendered(dir, '/listed', 'flight'), null, 'per variant: the flight half is best-effort and may not exist');
  });

  test('reads the store directly when the build left no manifest', async () => {
    // A build from before there was one. Refusing to serve what it wrote would be worse than the failed
    // read the index exists to avoid.
    const dir = tempDir();
    mkdirSync(join(dir, 'old'), { recursive: true });
    writeFileSync(join(dir, 'old', 'index.html'), '<!DOCTYPE html><p>old</p>');
    assert.ok(await readPrerendered(dir, '/old'));
  });

  test('treats a manifest it cannot parse as no manifest at all', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'page'), { recursive: true });
    writeFileSync(join(dir, 'page', 'index.html'), '<!DOCTYPE html><p>page</p>');
    writeFileSync(join(dir, 'manifest.json'), 'not json');
    assert.ok(await readPrerendered(dir, '/page'), 'a broken index must not take the store down with it');
  });

  test('returns null for a missing page instead of throwing', async () => {
    assert.equal(await readPrerendered(tempDir(), '/nope'), null);
  });

  test('refuses to escape the ssg directory, with the file a traversal would reach actually there', async () => {
    // The version of this test that shipped first ran its attempts against a *freshly created empty* temp
    // dir, so `null` proved nothing beyond "no file was there". Here the file a traversal is aiming at
    // exists and is readable, so the only thing that can refuse it is the guard.
    const parent = tempDir();
    const store = join(parent, 'store');
    mkdirSync(join(parent, 'sibling'), { recursive: true });
    mkdirSync(store, { recursive: true });
    writeFileSync(join(parent, 'sibling', 'index.html'), '<!DOCTYPE html><p>outside the store</p>');
    // The control: the bytes are there, one `..` away from the root, and nothing but the guard is between
    // them and a response.
    assert.match(readFileSync(join(store, '..', 'sibling', 'index.html'), 'utf8'), /outside the store/);

    for (const attempt of ['/../sibling', '/../sibling/', '/docs/../../sibling', '/..%2fsibling', '/%2e%2e/sibling']) {
      assert.equal(await readPrerendered(store, attempt), null, `traversal attempt "${attempt}" must not resolve`);
    }

    // And a page genuinely inside the store still resolves, so the guard is not simply refusing everything.
    mkdirSync(join(store, 'sibling'), { recursive: true });
    writeFileSync(join(store, 'sibling', 'index.html'), '<!DOCTYPE html><p>inside</p>');
    assert.ok(await readPrerendered(store, '/sibling'), 'the same name inside the root is an ordinary page');
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

    assert.deepEqual(result.written, ['/about', '/docs/a', '/docs/b'], 'reported in route order, whatever order they rendered in');
    assert.deepEqual(
      requested.toSorted(),
      ['document /about', 'document /docs/a', 'document /docs/b', 'flight /about', 'flight /docs/a', 'flight /docs/b'],
      'each path is rendered as a document and as a flight payload; a dynamic route is never prerendered',
    );
    // Sorted above because paths render concurrently. Within a path the order is still fixed: the flight
    // payload is only asked for once the document has come back 200.
    for (const path of ['/about', '/docs/a', '/docs/b']) {
      assert.ok(requested.indexOf(`document ${path}`) < requested.indexOf(`flight ${path}`), `${path}: document before flight`);
    }
    const decode = (page) => new TextDecoder().decode(page.body);
    assert.equal(decode(await readPrerendered(ssgDir, '/docs/a')), '<!DOCTYPE html><p>ok</p>');
    assert.equal(decode(await readPrerendered(ssgDir, '/docs/a', 'flight')), '0:{"root":"flight"}');

    // The index the reader gates on: every file, under the name a *request* resolves to, and nothing for
    // the dynamic route that was never prerendered.
    const manifest = JSON.parse(readFileSync(join(ssgDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files.toSorted(), [
      'about/index.html',
      'about/index.rsc',
      'docs/a/index.html',
      'docs/a/index.rsc',
      'docs/b/index.html',
      'docs/b/index.rsc',
    ]);
  });

  test('writes a payload carrying binary rows byte-for-byte', async () => {
    // A flight payload is not text: `emitChunk` puts the raw bytes of a `Uint8Array` a server component
    // returned straight on the wire. Reading a variant with `response.text()` is a *non-fatal* UTF-8 decode,
    // so each of those bytes became U+FFFD and was written back out as three — a page the build reports as
    // prerendered and the client cannot parse, on every soft navigation to it, forever.
    const payload = Buffer.from('303a226869220a313afffe0a', 'hex');
    const ssgDir = tempDir();
    await prerenderStaticRoutes({
      ssgDir,
      routes: [{ path: '/about', render: 'static', component: async () => ({ default: () => null }) }],
      fetch: (request) =>
        request.headers.get('RSC') === '1'
          ? new Response(payload, { status: 200, headers: { 'Content-Type': 'text/x-component' } })
          : new Response('<!DOCTYPE html><p>ok</p>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    });

    const stored = await readPrerendered(ssgDir, '/about', 'flight');
    assert.deepEqual(Buffer.from(stored.body), payload, 'the file on disk must be the bytes the render produced');
  });

  test('renders a path once however many times staticPaths returns it', async () => {
    const requested = [];
    const warnings = [];
    const warn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    let result;
    try {
      result = await prerenderStaticRoutes({
        ssgDir: tempDir(),
        routes: [
          {
            path: '/docs/:slug',
            render: 'static',
            component: async () => ({ default: () => null }),
            staticPaths: async () => [{ slug: 'a' }, { slug: 'b' }, { slug: 'a' }],
          },
        ],
        fetch: (request) => {
          requested.push(new URL(request.url).pathname);
          return okResponse(request);
        },
      });
    } finally {
      console.warn = warn;
    }

    assert.deepEqual(result.written, ['/docs/a', '/docs/b']);
    assert.equal(requested.filter((path) => path === '/docs/a').length, 2, 'one document and one flight payload, not two of each');
    assert.match(warnings.join('\n'), /repeated 1 path/, 'and the app is told, since a repeated entry is usually a bug in its query');
  });

  test('renders paths concurrently, up to a bound', async () => {
    let inFlight = 0;
    let peak = 0;
    const slugs = Array.from({ length: 20 }, (_, index) => `p${index}`);
    const result = await prerenderStaticRoutes({
      ssgDir: tempDir(),
      routes: [
        {
          path: '/docs/:slug',
          render: 'static',
          component: async () => ({ default: () => null }),
          staticPaths: async () => slugs.map((slug) => ({ slug })),
        },
      ],
      fetch: async (request) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return okResponse(request);
      },
    });

    assert.deepEqual(
      result.written,
      slugs.map((slug) => `/docs/${slug}`),
      'reported in staticPaths order, whatever order they finished in',
    );
    assert.ok(peak > 1, "rendered one at a time, a few hundred paths pay every page's latency in series");
    assert.ok(peak <= 8, `and rendered all at once, a build points the whole site at the app's database (peak ${peak})`);
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

  // A 5xx means the app threw, and this pass renders a page exactly as a request does — so the route will
  // throw again per request, forever. It used to be warned about as "will SSR per request" and skipped,
  // which is true of every *other* skip reason and false of this one; the build then exited 0.
  test('fails the build for a page that rendered 5xx, rather than calling it a skip', async () => {
    await assert.rejects(
      prerenderStaticRoutes({
        ssgDir: tempDir(),
        routes: [{ path: '/boom', render: 'static', component: async () => ({ default: () => null }) }],
        fetch: () => new Response('nope', { status: 500 }),
      }),
      (error) => {
        assert.match(error.message, /\[rshono\] 1 page failed to render while prerendering/);
        assert.match(error.message, /"\/boom" rendered 500/);
        assert.doesNotMatch(error.message, /will SSR per request/, 'because it will not — it will 500 per request');
        return true;
      },
    );
  });

  // The other side of the split: a page the pass cannot store but the server can still render is skipped,
  // which is what the warning has always said. `notFound()` from a static page is the ordinary case.
  test('still skips a page that answered something unprerenderable but servable', async () => {
    for (const status of [404, 302]) {
      const warnings = [];
      const warn = console.warn;
      console.warn = (message) => warnings.push(String(message));
      let result;
      try {
        result = await prerenderStaticRoutes({
          ssgDir: tempDir(),
          routes: [{ path: '/gone', render: 'static', component: async () => ({ default: () => null }) }],
          fetch: () => new Response('gone', { status }),
        });
      } finally {
        console.warn = warn;
      }
      assert.deepEqual(result.written, [], `${status} must not be stored`);
      assert.deepEqual(result.skipped, ['/gone'], `${status} must be skipped, not fatal`);
      assert.match(warnings.join('\n'), /will SSR per request/);
    }
  });

  test('names every failing page at once, in route order', async () => {
    await assert.rejects(
      prerenderStaticRoutes({
        ssgDir: tempDir(),
        routes: ['/a', '/b'].map((path) => ({ path, render: 'static', component: async () => ({ default: () => null }) })),
        fetch: () => new Response('nope', { status: 500 }),
      }),
      (error) => {
        assert.match(error.message, /2 pages failed to render/);
        assert.ok(error.message.indexOf('"/a"') < error.message.indexOf('"/b"'), 'reported in route order, not completion order');
        return true;
      },
    );
  });

  // A route whose paths cannot be computed is unprerenderable, not unservable — the same answer as a
  // parameterised route with no `staticPaths` at all, one branch above it in the source. These used to
  // throw out of the pass and take the whole build with them, for routes that work perfectly per request.
  test('warns and skips a param shape it cannot turn into a single file, rather than failing the build', async () => {
    const cases = [
      { path: '/files/*', staticPaths: async () => [{}], expected: /wildcard segments/ },
      { path: '/docs/:slug{[a-z]+}', staticPaths: async () => [{ slug: 'a' }], expected: /optional\/regex params/ },
      { path: '/docs/:slug', staticPaths: async () => [{ wrong: 'a' }], expected: /without "slug"/ },
      { path: '/docs/:slug', staticPaths: () => Promise.reject(new Error('the database is down')), expected: /database is down/ },
    ];
    for (const { path, staticPaths, expected } of cases) {
      const warnings = [];
      const warn = console.warn;
      console.warn = (message) => warnings.push(String(message));
      let result;
      try {
        result = await prerenderStaticRoutes({
          ssgDir: tempDir(),
          routes: [
            { path, render: 'static', staticPaths, component: async () => ({ default: () => null }) },
            { path: '/about', render: 'static', component: async () => ({ default: () => null }) },
          ],
          fetch: okResponse,
        });
      } finally {
        console.warn = warn;
      }

      assert.deepEqual(result.skipped, [path], `"${path}" should be skipped`);
      assert.deepEqual(result.written, ['/about'], 'and the routes around it still prerender');
      assert.match(warnings.join('\n'), expected, `"${path}" should say why`);
      assert.match(warnings.join('\n'), /will SSR per request/i, 'and what happens instead');
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
      requested.toSorted(),
      ['/docs/a%20b', '/docs/a%20b', '/docs/caf%C3%A9', '/docs/caf%C3%A9'],
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

  // A bare bracket access resolves every `Object.prototype` key to an inherited value, which then passes a
  // truthiness guard: `RSHONO_DEPLOY=constructor` used to reach the builder and die there on
  // `preset.runtimeModule.split('/')` instead of being named as the typo it is.
  test('a prototype key is a typo, not a target', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      assert.throws(() => resolveDeployPreset({ env: key }), /unknown deploy target/, `${key} must not resolve to a preset`);
      assert.equal(deployHintFor(key), null, `${key} has no deploy hint`);
    }
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

describe('parseRenderRequest', () => {
  const BASE = 'https://app.test/page';
  const parse = (init) => parseRenderRequest(new Request(BASE, init));

  test('classifies a GET by the RSC header alone', () => {
    assert.deepEqual(parse({}), { kind: 'document' });
    assert.deepEqual(parse({ headers: { RSC: '1' } }), { kind: 'rsc' });
    // Exactly two states — that is what makes `Vary: RSC` cheap enough to put on a cacheable response.
    assert.deepEqual(parse({ headers: { RSC: '0' } }), { kind: 'document' });
    assert.deepEqual(parse({ headers: { RSC: 'true' } }), { kind: 'document' });
    // An action id on a GET is not a shape the union can hold, and a GET must never run one.
    assert.deepEqual(parse({ headers: { 'x-rsc-action': 'abc' } }), { kind: 'document' });
  });

  test("a POST is a client-initiated action exactly when it carries 'x-rsc-action'", () => {
    // Which branch a POST takes is a security boundary, not just dispatch. `x-rsc-action` is not a
    // CORS-safelisted header, so a page on another origin cannot send one without a preflight the framework
    // never answers — which is why this branch carries no origin check of its own. If the classification
    // ever moved to something a cross-origin form *can* send, that defence would be gone with no test
    // failing anywhere else. See `SECURITY.md` and `refusesCrossSiteForm`.
    assert.deepEqual(parse({ method: 'POST', headers: { 'x-rsc-action': 'abc' }, body: '[]' }), { kind: 'rsc-action', actionId: 'abc' });
    // The header decides even when the body is form-shaped: a client-initiated call is not forgeable
    // whatever it is encoded as.
    assert.deepEqual(parse({ method: 'POST', headers: { 'x-rsc-action': 'abc', 'content-type': 'multipart/form-data; boundary=x' }, body: '' }), {
      kind: 'rsc-action',
      actionId: 'abc',
    });
    assert.deepEqual(parse({ method: 'POST', headers: { 'x-rsc-action': '' }, body: '[]' }), { kind: 'document' }, 'an empty id names nothing');
  });

  test('a POST is a form action exactly for the content types a browser can send cross-origin', () => {
    // These two need no preflight, which is what makes this the forgeable shape and the one
    // `refusesCrossSiteForm` stands in front of.
    for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=----x', 'MULTIPART/FORM-DATA; boundary=y']) {
      assert.deepEqual(parse({ method: 'POST', headers: { 'content-type': contentType }, body: 'x=1' }), { kind: 'form-action' }, contentType);
    }
    // Matched as a prefix, so the `; charset=UTF-8` a browser appends does not fall out of the branch — and
    // erring wide is the safe direction here: an over-matched POST lands on the guarded branch and decodes to
    // nothing, where an under-matched one would land on a branch with no origin check.
    assert.deepEqual(parse({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencodedX' }, body: 'x=1' }), {
      kind: 'form-action',
    });
    // Anything else is not an action at all — it renders the page and runs nothing, so a `text/plain` POST
    // without the header cannot reach an action however it is aimed.
    for (const contentType of ['application/json', 'text/plain', 'text/html', 'application/xml']) {
      assert.deepEqual(parse({ method: 'POST', headers: { 'content-type': contentType }, body: '{}' }), { kind: 'document' }, contentType);
    }
    assert.deepEqual(parse({ method: 'POST', body: 'x=1' }), { kind: 'document' }, 'no content-type at all');
  });

  test('what each shape means downstream', () => {
    const shapes = {
      document: parse({}),
      rsc: parse({ headers: { RSC: '1' } }),
      'form-action': parse({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1' }),
      'rsc-action': parse({ method: 'POST', headers: { 'x-rsc-action': 'abc' }, body: '[]' }),
    };
    assert.deepEqual(Object.fromEntries(Object.entries(shapes).map(([name, shape]) => [name, [wantsRsc(shape), isActionRequest(shape)]])), {
      document: [false, false],
      rsc: [true, false],
      // A no-JS form post answers with a document; a client-initiated call answers with a payload.
      'form-action': [false, true],
      'rsc-action': [true, true],
    });
  });

  test('asksForRsc reads the same header without parsing the rest', () => {
    // The prerendered-page path takes it on every GET, so it never builds a `RenderRequest` it would drop.
    assert.equal(asksForRsc(new Request(BASE, { headers: { RSC: '1' } })), true);
    assert.equal(asksForRsc(new Request(BASE)), false);
    assert.equal(asksForRsc(new Request(BASE, { method: 'POST', headers: { 'x-rsc-action': 'abc' }, body: '[]' })), false, 'RSC, not the action id');
  });

  test('createRscRequest round-trips through the parser it is read by', () => {
    // `location` is the browser global the client runtime resolves a relative href against.
    const location = globalThis.location;
    globalThis.location = { origin: 'https://app.test' };
    try {
      const navigation = createRscRequest('/docs?q=1');
      assert.equal(navigation.method, 'GET');
      assert.equal(navigation.url, 'https://app.test/docs?q=1');
      assert.deepEqual(parseRenderRequest(navigation), { kind: 'rsc' });

      const action = createRscRequest('/docs', { id: 'abc123', body: '[]' });
      assert.equal(action.method, 'POST');
      assert.deepEqual(parseRenderRequest(action), { kind: 'rsc-action', actionId: 'abc123' });
      // The header the whole cross-origin argument rests on has to be the one actually sent.
      assert.equal(action.headers.get('x-rsc-action'), 'abc123');
      assert.equal(action.headers.get('rsc'), '1');
    } finally {
      if (location === undefined) delete globalThis.location;
      else globalThis.location = location;
    }
  });
});

describe('the security-middleware build warning', () => {
  /**
   * The minimal app somewhere disposable, plus whatever `src/server.ts` the case wants.
   *
   * No `node_modules`: `createConfigs` builds config objects and scans `src/`, and resolves packages from
   * the *framework's* tree rather than the app's, so nothing here reads one. It used to borrow the
   * fixture's through a junction, which was both unnecessary and a Windows reparse point for no reason.
   */
  function appWithServer(serverSource) {
    const dir = mkdtempSync(join(tmpdir(), 'rshono-warn-'));
    cpSync(join(MINIMAL_APP_DIR, 'package.json'), join(dir, 'package.json'));
    cpSync(join(MINIMAL_APP_DIR, 'src'), join(dir, 'src'), { recursive: true });
    if (serverSource !== null) writeFileSync(join(dir, 'src', 'server.ts'), serverSource);
    after(() => rmSync(dir, { recursive: true, force: true }));
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
  /** The loader options the builder actually generates, read off the rule that carries them. */
  function generatedOptions({ isDev = false } = {}) {
    const [, serverConfig] = createConfigs({ rootDir: MINIMAL_APP_DIR, isDev, config: {}, preset: NODE_PRESET });
    const rule = serverConfig.module.rules.find((entry) => entry.use?.[0]?.loader?.includes('env-shadow-loader'));
    assert.ok(rule, 'the SSR env-shadow rule has to be in the server config');
    return rule.use[0].options;
  }

  const generatedPrelude = () => generatedOptions().prelude;

  test('tells the loader the mode it is building for, so the prelude does not cost dead-code elimination', () => {
    // Without this the SSR layer bundles React's development builds beside the production ones — the prelude
    // shadows `process`, and DefinePlugin will not substitute through a local binding. The two have to agree:
    // the value the loader writes is the value the prelude's own `env` carries.
    assert.equal(generatedOptions({ isDev: false }).nodeEnv, 'production');
    assert.equal(generatedOptions({ isDev: true }).nodeEnv, 'development');
    assert.match(generatedOptions({ isDev: false }).prelude, /"NODE_ENV":"production"/);
  });

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
  const run = (source, { layer = 'ssr', resourcePath = join(APP_SRC, 'component.tsx'), warnings, nodeEnv } = {}) =>
    envShadowLoader.call(
      {
        getOptions: () => ({ prelude: PRELUDE, layer: 'ssr', appSrcPrefix: APP_SRC + sep, nodeEnv }),
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
      "export const x = globalThis?.['process']?.env?.DATABASE_URL;",
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

  test('substitutes NODE_ENV before the prelude hides it from DefinePlugin', () => {
    // The prelude declares a module-scope `process`, and DefinePlugin respects lexical scope — so every
    // `if (process.env.NODE_ENV === 'production')` in this layer stayed a runtime branch and React's
    // development builds were bundled beside the production ones. Substituting first hands the optimiser the
    // one expression it needs back. Not a behaviour change: `NODE_ENV` is the build's mode, so the literal
    // written here is the value the shadow would have returned anyway.
    assert.equal(
      run("if (process.env.NODE_ENV === 'production') { a(); } else { b(); }", { nodeEnv: 'production' }),
      `${PRELUDE}if ("production" === 'production') { a(); } else { b(); }`,
    );
    assert.equal(run('export const x = process.env.NODE_ENV;', { nodeEnv: 'development' }), `${PRELUDE}export const x = "development";`);
  });

  test('substitutes NODE_ENV only in the layer it shadows, and only when asked', () => {
    const source = 'export const x = process.env.NODE_ENV;';
    // The RSC layer gets no prelude, so DefinePlugin still reaches it there and this loader must not touch it.
    assert.equal(run(source, { layer: 'rsc', nodeEnv: 'production' }), source);
    // And with no `nodeEnv` configured the loader is the shadow and nothing more.
    assert.equal(run(source), PRELUDE + source);
  });

  test('leaves NODE_ENV read off something other than the free process binding alone', () => {
    // The same shapes DefinePlugin itself declines. Substituting a member read off another object would be
    // rewriting an unrelated expression, and the shadow still answers all of these correctly at runtime.
    // Asserted on the value not appearing rather than on the exact output, because `myprocess` never gets a
    // prelude either — `\bprocess\b` turns it away one gate earlier.
    for (const source of [
      'export const x = this.process.env.NODE_ENV;',
      'export const x = config.process.env.NODE_ENV;',
      'export const x = myprocess.env.NODE_ENV;',
      'export const x = process.env.NODE_ENVIRONMENT;',
    ]) {
      assert.ok(run(source, { nodeEnv: 'production' }).includes(source), `"${source}" must survive unrewritten`);
    }
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

  test('takes a list of methods, and refuses the lists that are mistakes', () => {
    assert.deepEqual(validateRoutesModule([{ ...endpoint, method: ['get', 'delete'] }]).routes[0].method, ['get', 'delete']);
    // Named member by member, so the message points at the bad one rather than printing the array.
    rejects([{ ...endpoint, method: ['get', 'HEAD'] }], /has method "HEAD", which is not one of get, post/);
    rejects([{ ...endpoint, method: [] }], /has an empty `method` list/);
    rejects([{ ...endpoint, method: ['get', 'all'] }], /has 'all' inside a `method` list/);
  });

  // The one that built cleanly, exited 0 and said nothing: Hono matches in registration order.
  test('refuses a route every method of which the table already answers', () => {
    rejects(
      [page, { ...page, component: page.component }],
      /routes\[1\] \("\/"\) would never run — routes\[0\] \("\/"\) already answers GET, POST \//,
    );
    rejects([endpoint, { ...endpoint, method: 'get' }], /already answers GET \/api\/x/, 'an `all` endpoint claims every method');
    rejects(
      [
        { ...endpoint, method: ['get', 'post'] },
        { ...endpoint, method: 'post' },
      ],
      /already answers POST \/api\/x/,
      'a listed method is claimed like any other',
    );
    rejects([{ ...endpoint, path: '/' }, page], /already answers GET, POST \//, 'an endpoint shadows a page at the same path too');
  });

  test('sees a dead route whose path is spelled differently from the one that shadows it', () => {
    // The check used to key on the literal path string, so a dead route only had to be spelled differently
    // to pass — exactly the build-exits-0-with-an-unreachable-route case it exists to prevent. Every pair
    // below was confirmed against Hono 4.13 directly: the second route never wins for any request.
    const at = (path) => ({ ...page, path });
    for (const [table, expected, what] of [
      [[at('/u/:id'), at('/u/:name')], /routes\[1\] \("\/u\/:name"\) would never run/, "a parameter's name is not part of the pattern"],
      [[at('/posts/:y/:m'), at('/posts/:a/:b')], /routes\[1\] .* would never run/, 'two parameters, both renamed'],
      [[at('/a/*'), at('/a/b')], /routes\[1\] \("\/a\/b"\) would never run/, 'a wildcard registered ahead of a concrete path'],
      [[at('/a/*'), at('/a')], /routes\[1\] \("\/a"\) would never run/, 'a trailing wildcard answers its bare prefix too'],
      [[at('/*'), at('/anything')], /routes\[1\] .* would never run/, 'a root wildcard claims everything after it'],
      [[at('/u/:id/*'), at('/u/:name/x')], /routes\[1\] .* would never run/, 'both mechanisms at once'],
      [[at('/a/*/c'), at('/a/:id/c')], /routes\[1\] .* would never run/, 'a `*` before the last segment is one segment, like a parameter'],
      [[at('/a/:id?'), at('/a')], /routes\[1\] \("\/a"\) would never run/, 'an optional parameter answers the path without it'],
    ]) {
      rejects(table, expected, what);
    }

    // And says why, since two paths that look different reading as one route is the confusing part.
    rejects([at('/u/:id'), at('/u/:name')], /Hono matches on the pattern, not the spelling/);
    // An exact duplicate needs no explaining, so it does not get the sentence.
    assert.throws(
      () => validateRoutesModule([at('/u/:id'), at('/u/:id')]),
      (error) => !error.message.includes('not the spelling'),
      'an exact duplicate is self-explanatory',
    );
  });

  test('leaves a route that still answers something alone', () => {
    for (const table of [
      // A `{regex}` constraint *is* part of the pattern, so these are two routes and both can answer:
      // `/a/7` goes to the first and `/a/xy` to the second.
      [
        { ...page, path: '/a/:id{[0-9]+}' },
        { ...page, path: '/a/:name' },
      ],
      // Specific-behind-generic is the dead one; generic behind specific still answers everything else.
      [
        { ...page, path: '/a/b' },
        { ...page, path: '/a/*' },
      ],
      // The wildcard's boundary is the `/` — `/a/*` does not answer `/ab`.
      [
        { ...page, path: '/a/*' },
        { ...page, path: '/ab' },
      ],
      // `/a/:id?` answers `/a` as well as `/a/x`, so a bare `/a` ahead of it leaves it half its work.
      [
        { ...page, path: '/a' },
        { ...page, path: '/a/:id?' },
      ],
      // A wildcard claims one subtree, not the table.
      [
        { ...page, path: '/a/*' },
        { ...page, path: '/b/c' },
      ],
      // One path split across two methods — an ordinary thing to write.
      [
        { ...endpoint, method: 'get' },
        { ...endpoint, method: 'post' },
        { ...page, path: '/other' },
      ],
      // A catch-all behind a route claiming one method of the path: it still answers PUT, DELETE, …
      [{ ...endpoint, method: 'post' }, endpoint],
      // And behind one claiming two of them.
      [{ ...endpoint, method: ['get', 'post'] }, endpoint],
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
/*
 * The checks a route's *own* module gets. `rshono build` runs these against every route once the bundle
 * exists; before that they only ran on first request, so a page module that could never render — a
 * `'use client'` page, a missing default export — shipped behind a green build and answered 500 for the life
 * of the deployment. The endpoint half had no check at all: it destructured `handler` and called it, which
 * turns a method-named export into `TypeError: r is not a function` from a minified frame.
 */
describe('assertRouteModules', () => {
  /** What a `'use server-entry'` page module's default export looks like: the client-asset list is on it. */
  const serverPage = Object.assign(() => null, { entryJsFiles: ['/_static/chunks/main.js'] });
  /** And what a `'use client'` one looks like — a reference with no assets recorded against it. */
  const clientPage = () => null;

  const page = (path, mod) => ({ path, component: () => Promise.resolve(mod) });
  const endpoint = (path, mod) => ({ path, type: 'endpoint', server: () => Promise.resolve(mod) });

  test('accepts a table whose every module is what it claims to be', async () => {
    await assertRouteModules({
      routes: [page('/', { default: serverPage }), endpoint('/api/health', { handler: () => null })],
      notFound: { component: () => Promise.resolve({ default: serverPage }) },
      error: { component: () => Promise.resolve({ default: serverPage }) },
    });
  });

  test('refuses a page module with no default export', async () => {
    await assert.rejects(
      assertRouteModules({ routes: [page('/noexport', { Page: serverPage })] }),
      /\[rshono\] The page module for "\/noexport" must default-export a server component\./,
    );
  });

  test("refuses a 'use client' page, which has no client assets recorded against it", async () => {
    await assert.rejects(
      assertRouteModules({ routes: [page('/clientpage', { default: clientPage })] }),
      /\[rshono\] The page component for "\/clientpage" is missing its client-asset info/,
    );
  });

  test('refuses an endpoint module that exports anything but `handler`', async () => {
    await assert.rejects(assertRouteModules({ routes: [endpoint('/api/bad', { GET: () => null })] }), (error) => {
      assert.match(error.message, /\[rshono\] The endpoint module for "\/api\/bad" must export `handler`/);
      assert.match(error.message, /a method-named export \(`GET`, `POST`\) is never read/, 'the mistake people actually make');
      return true;
    });
  });

  test('checks the notFound and error pages too, which the request path only reaches once something failed', async () => {
    await assert.rejects(
      assertRouteModules({ routes: [], notFound: { component: () => Promise.resolve({ default: clientPage }) } }),
      /The page component for the notFound page is missing/,
    );
    await assert.rejects(
      assertRouteModules({ routes: [], error: { component: () => Promise.resolve({}) } }),
      /The page module for the error page must default-export/,
    );
  });

  test('names every broken route at once, so fixing four of them costs one build', async () => {
    await assert.rejects(
      assertRouteModules({
        routes: [page('/ok', { default: serverPage }), page('/clientpage', { default: clientPage }), page('/noexport', {})],
      }),
      (error) => {
        assert.match(error.message, /\[rshono\] 2 route modules cannot serve a request:/);
        assert.match(error.message, /• The page component for "\/clientpage"/);
        assert.match(error.message, /• The page module for "\/noexport"/);
        assert.doesNotMatch(error.message, /"\/ok"/, 'a route that is fine must not be listed');
        return true;
      },
    );
  });

  test('warns rather than failing when a module cannot be imported, and checks every other route anyway', async () => {
    // Checking a module's shape means importing it, and an import that throws is a fact about the build
    // environment as much as about the module: a page whose module scope reads a secret or opens a
    // connection fails here and serves per request. A `render: 'static'` route is the one that cannot get
    // away with it, and the prerender pass is what says so.
    const warnings = [];
    const warn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      await assertRouteModules({
        routes: [
          { path: '/side-effect', component: () => Promise.reject(new Error('DATABASE_URL is not set')) },
          page('/ok', { default: serverPage }),
        ],
      });
      await assert.rejects(
        assertRouteModules({
          routes: [{ path: '/side-effect', component: () => Promise.reject(new Error('nope')) }, page('/clientpage', { default: clientPage })],
        }),
        /The page component for "\/clientpage" is missing/,
        'a route it could not load must not stop it checking the rest',
      );
    } finally {
      console.warn = warn;
    }
    assert.match(warnings.join('\n'), /"\/side-effect" could not be loaded at build time, so its module was not checked — DATABASE_URL is not set/);
  });
});

// The CLI's failure paths print the report that says what went wrong and then exit. `process.exit` does not
// drain a pipe — every CI job, and any `rshono build | tee` — so everything past the 64 KiB pipe buffer used
// to be discarded, cutting a large Rspack error dump mid-error.
describe('exit', () => {
  const EXIT_MODULE = new URL('../dist/cli/exit.js', import.meta.url).href;
  const spawnWriting = (bytes, exiting) =>
    spawnSync(
      process.execPath,
      [
        '-e',
        `import('${EXIT_MODULE}').then(async ({ exit }) => {
           console.error('E'.repeat(${bytes}));
           ${exiting}
         })`,
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );

  test('a piped stream is drained before the process goes away', () => {
    const bytes = 300_000;
    const drained = spawnWriting(bytes, 'await exit(1);');
    assert.equal(drained.status, 1, 'the exit code still has to be the one asked for');
    assert.equal(drained.stderr.length, bytes + 1, 'every byte written must reach the pipe');

    // The same write without the helper, so the assertion above is measuring the drain and not a pipe
    // that was never small enough to matter on this machine. Only POSIX: a write to a pipe is synchronous
    // on Windows, so there is nothing there for a bare exit to drop and nothing for the drain to rescue.
    if (process.platform !== 'win32') {
      const cut = spawnWriting(bytes, 'process.exit(1);');
      assert.ok(cut.stderr.length < bytes, `a bare process.exit is what truncates (${cut.stderr.length} bytes)`);
    }
  });
});
