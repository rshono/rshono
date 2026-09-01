/**
 * Carrying the flight payload inside the HTML document, so the browser hydrates from bytes it already has
 * rather than fetching the page twice. The reader is `readFlightPayload` in `entry.client.tsx`.
 *
 * The wire format is `rsc-html-stream`'s — a run of `<script>(self.__FLIGHT_DATA||=[]).push("…")</script>`
 * tags — but the implementation is first-party, because that package tests each HTML chunk for the
 * document trailer with `endsWith`: React's byte writer splits any write straddling its 2 kB views, so
 * `</body></html>` can arrive as two chunks and the document ends up with two trailers.
 */

/**
 * {@link Transformer} plus the `cancel` hook the Streams standard added for a cancelled readable side —
 * declared here because the bundled lib types have not caught up with what Node calls.
 *
 * It matters because `cancel` is the only notification that a response ended *without* finishing, and both
 * users of it release a listener that would otherwise outlive the request.
 */
export type CancellableTransformer<I, O> = Transformer<I, O> & { cancel?: (reason?: unknown) => void };

const encoder = new TextEncoder();

/** What React closes an `<html>` document with, and what this module re-emits after the last payload script. */
const TRAILER = '</body></html>';
const TRAILER_BYTES = encoder.encode(TRAILER);

/**
 * A macrotask boundary: `setImmediate` where there is one, which is the current turn's check phase rather
 * than a timer, and `setTimeout` as the portable fallback. A Node timer has a 1ms floor that every HTML
 * flush would pay — 4.7ms → 3.0ms time-to-last-byte on a 30 kB payload.
 */
type TaskHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate>;
const hasSetImmediate = typeof setImmediate === 'function';
const schedule: (fn: () => void) => TaskHandle = hasSetImmediate ? setImmediate : (fn) => setTimeout(fn, 0);
const unschedule = (handle: TaskHandle): void => {
  if (hasSetImmediate) clearImmediate(handle as ReturnType<typeof setImmediate>);
  else clearTimeout(handle as ReturnType<typeof setTimeout>);
};

/**
 * Escapes the two sequences that would end a `<script>` element early. Guarded by `includes('<')`, which is
 * far cheaper than two regex passes over 30 kB of payload that usually has no `<` in it. `</script` becomes
 * `</\script`, not `<\/script`, which would break the valid JS `0</script/`.
 */
function escapeScript(script: string): string {
  return script.includes('<') ? script.replace(/<!--/g, '<\\!--').replace(/<\/(script)/gi, '</\\$1') : script;
}

/**
 * The bytes of `chunk` as a latin1 string, which is the form `btoa` takes. Sliced because
 * `String.fromCharCode(...chunk)` passes one argument per byte and overflows the stack.
 */
function latin1(chunk: Uint8Array): string {
  let out = '';
  for (let at = 0; at < chunk.length; at += 8192) out += String.fromCharCode(...chunk.subarray(at, at + 8192));
  return out;
}

/** Whether `buffer`'s first `length` bytes end with the document trailer. */
function endsWithTrailer(buffer: Uint8Array, length: number): boolean {
  if (length < TRAILER_BYTES.length) return false;
  const from = length - TRAILER_BYTES.length;
  for (let i = 0; i < TRAILER_BYTES.length; i++) {
    if (buffer[from + i] !== TRAILER_BYTES[i]) return false;
  }
  return true;
}

/**
 * How many of `buffer`'s last bytes could still turn into the document trailer — the length of the longest
 * suffix of `buffer[0..length)` that is a prefix of it, `TRAILER_BYTES.length` for the whole thing.
 *
 * At most 14 bytes are ever held back, and in practice 0: a React flush ends with a closed tag, not with the
 * start of one. Cheaper than it looks, too — the first comparison rejects every suffix whose first byte is
 * not `<`.
 */
function trailerPrefixLength(buffer: Uint8Array, length: number): number {
  candidate: for (let take = Math.min(length, TRAILER_BYTES.length); take > 0; take--) {
    const from = length - take;
    for (let i = 0; i < take; i++) if (buffer[from + i] !== TRAILER_BYTES[i]) continue candidate;
    return take;
  }
  return 0;
}

/**
 * The characters a CSP nonce may be made of: base64 and base64url, which is what every generator of one emits
 * — Hono's `secureHeaders()`, the only source the framework reads, produces base64 of 16 random bytes.
 *
 * The tag below is built by hand rather than by React, so this is the one attribute value in a rendered
 * document that nothing else escapes. The value is not attacker-controlled today, but the framework does not
 * own where it comes from: `c.get('secureHeadersNonce')` is an ordinary context variable that any middleware
 * can set, and a nonce carrying a `"` would close the attribute and open a script-injection point in the
 * document. Anything outside this set is dropped rather than escaped, because a value made of other characters
 * is not a nonce at all: a page whose payload scripts the policy then refuses is the visible failure to have,
 * where an escaped garbage nonce would be a silent one.
 */
const NONCE_CHARS = /^[A-Za-z0-9+/=_-]+$/;

export function injectFlightPayload(
  rscStream: ReadableStream<Uint8Array>,
  options: { nonce?: string; onDone?: () => void } = {},
): ReadableWritablePair<Uint8Array, Uint8Array> {
  const { nonce, onDone } = options;
  const safeNonce = nonce !== undefined && NONCE_CHARS.test(nonce) ? nonce : undefined;
  const scriptOpen = `<script${safeNonce ? ` nonce="${safeNonce}"` : ''}>(self.__FLIGHT_DATA||=[]).push(`;
  const scriptClose = ')</script>';

  const { promise: flightWritten, resolve: flightDone } = Promise.withResolvers<void>();
  let startedFlight = false;

  const batch: Uint8Array[] = [];
  let boundary: TaskHandle | null = null;
  /**
   * The tail of the last batch that could still be the start of the document trailer, carried into the next
   * one. See {@link emitBatch}.
   */
  let carry: Uint8Array | null = null;

  /**
   * Set once the consumer has gone away, so nothing tries to enqueue into a readable that cannot take it.
   *
   * The `cancel` hook alone cannot set this: per the Streams standard, cancelling the readable after the
   * close algorithm has started skips the transformer's `cancel` entirely — and `flush` awaiting the whole
   * payload is precisely that window. So a failed enqueue counts as the signal too.
   */
  let cancelled = false;
  /** Held so {@link cancelled} can release the teed RSC branch rather than leaving it to be pumped. */
  let flightReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  /**
   * One permit per chunk the consumer has asked for: the backpressure a `TransformStream` alone does not give
   * this module.
   *
   * A transform's writable side parks a write while its readable's queue is over the mark, which covers the
   * HTML — but only once something has been enqueued, and `transform` defers that to a macrotask. So a
   * producer that writes a whole document without ever yielding the microtask queue is admitted in full, and
   * {@link writeFlight}, which pumps the payload into the same controller from a detached promise, is never
   * gated at all: measured, a consumer that read one chunk and stalled still pulled all 500 chunks of a test
   * payload into the queue, where this brings it down to 3. `controller.desiredSize` is no help — a transform
   * readable's high-water mark is 0, so it is never positive.
   *
   * The wrapper readable this function returns is the missing signal: its `pull` runs exactly when the
   * consumer wants another chunk, and releases one permit. Both producers — the HTML batcher and the payload
   * pump — take one before they enqueue, so a stalled client parks React instead of filling the process. The
   * Streams standard calls `pull` again only once the previous call has settled, so at most one permit is ever
   * outstanding, which bounds the queue at a chunk.
   *
   * What is left buffered is one React flush, because a flush has to leave here as a single chunk (see
   * {@link emitBatch}) — the same bound React itself holds while it builds one. The two enqueues in `flush`
   * are ungated for a related reason: the response is over by then, and parking its last two chunks on a
   * permit would only add a way for it not to end.
   */
  let permits = 0;
  const waiting: Array<() => void> = [];

  /** Returns nothing when a permit was already free, so the common case costs no microtask. */
  function takePermit(): Promise<void> | undefined {
    // Nothing will release another permit once the consumer is gone, and there is nothing left to protect:
    // the caller goes on to a failing enqueue, which is what tears the pipeline down.
    if (cancelled) return;
    if (permits > 0) {
      permits--;
      return;
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  }

  function releasePermit(): void {
    const next = waiting.shift();
    if (next) next();
    else permits++;
  }

  /** Fires `onDone` at most once, however the response ended — both cancel paths can reach it. */
  let ended = false;
  function reportDone(): void {
    if (ended) return;
    ended = true;
    onDone?.();
  }

  /**
   * The consumer has gone away: stop producing, release everything the request was holding, and unpark both
   * producers so they see {@link cancelled} rather than a permit that will never come.
   *
   * Called from the wrapper readable's `cancel`, which is reliable, and from the transformer's, which the
   * standard skips once the close algorithm has started — so it has to be idempotent.
   */
  function teardown(reason?: unknown): void {
    cancelled = true;
    if (boundary) {
      unschedule(boundary);
      boundary = null;
    }
    batch.length = 0;
    carry = null;
    for (const resolve of waiting.splice(0)) resolve();
    // Otherwise the teed RSC branch keeps being pumped for a response nobody will read, and the tee's
    // other half buffers every chunk waiting for this one to catch up.
    flightReader?.cancel(reason).catch(() => {});
    // Unparks `flush` if it is waiting on a payload that will now never arrive.
    flightDone();
    reportDone();
  }

  /**
   * Emits the HTML buffered since the last boundary, holding back the document trailer for `flush` to re-emit
   * after the payload scripts.
   *
   * The batch is joined before the trailer is looked for, so one React split across two views is still found.
   * A trailer split across two *batches* is not a shape React produces — it writes its final flush in one
   * synchronous run — but this injector exists because `rsc-html-stream` made a narrower version of that same
   * assumption and was wrong (see the module header), so anything that could still become a trailer is held
   * back in {@link carry} rather than assumed not to be. Only `final`, the call from `flush`, may emit such a
   * tail: by then there is no next batch for it to complete.
   *
   * A tail that never does complete therefore leaves after the payload scripts rather than before them, which
   * is the deliberate half of the trade: releasing it the moment a script wants to go out is the very bug this
   * guards, because the next batch may be the rest of the trailer. It costs at most 13 bytes of a truncated
   * document arriving late, still inside `<body>`.
   */
  function emitBatch(controller: TransformStreamDefaultController<Uint8Array>, final = false): void {
    boundary = null;
    let total = carry?.byteLength ?? 0;
    for (const chunk of batch) total += chunk.byteLength;
    if (total === 0) {
      batch.length = 0;
      return;
    }

    const joined = new Uint8Array(total);
    let at = 0;
    if (carry) {
      joined.set(carry, at);
      at += carry.byteLength;
      carry = null;
    }
    for (const chunk of batch) {
      joined.set(chunk, at);
      at += chunk.byteLength;
    }
    batch.length = 0;

    const held = final ? (endsWithTrailer(joined, total) ? TRAILER_BYTES.length : 0) : trailerPrefixLength(joined, total);
    const end = total - held;
    // Copied rather than a `subarray`, which would keep the whole joined flush alive for 14 bytes.
    if (held > 0 && !final) carry = joined.slice(end);
    if (end > 0) controller.enqueue(joined.subarray(0, end));
  }

  async function writeFlight(controller: TransformStreamDefaultController<Uint8Array>): Promise<void> {
    const reader = (flightReader = rscStream.getReader());
    // `fatal`, so a chunk that split a multi-byte character throws instead of emitting U+FFFD; the catch
    // below falls back to a byte-exact encoding for it.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const push = async (literal: string): Promise<void> => {
      const permit = takePermit();
      if (permit) await permit;
      if (cancelled) return;
      controller.enqueue(encoder.encode(scriptOpen + literal + scriptClose));
    };
    for (;;) {
      if (cancelled) return;
      const { done, value } = await reader.read();
      if (done) break;
      // Only the decode is guarded: a `push` inside the same `try` would answer a dead controller by
      // re-encoding the chunk and enqueueing it again.
      let literal: string;
      try {
        literal = escapeScript(JSON.stringify(decoder.decode(value, { stream: true })));
      } catch {
        literal = `Uint8Array.from(atob(${JSON.stringify(btoa(latin1(value)))}), m => m.codePointAt(0))`;
      }
      if (cancelled) return;
      // A failed enqueue means the consumer is gone: release the RSC branch so `flush` unparks now rather
      // than whenever the payload would have ended on its own.
      try {
        await push(literal);
      } catch {
        cancelled = true;
        reader.cancel().catch(() => {});
        return;
      }
    }
    if (cancelled) return;
    const remaining = decoder.decode();
    if (remaining.length) await push(escapeScript(JSON.stringify(remaining)));
  }

  const transformer: CancellableTransformer<Uint8Array, Uint8Array> = {
    async transform(chunk, controller) {
      if (boundary) {
        batch.push(chunk);
        return;
      }
      // The permit is taken once per *batch*, not once per chunk: React writes a whole flush in one microtask
      // cascade and the flush has to leave here as one chunk (see `emitBatch`), so a per-chunk gate would
      // hand the consumer one chunk per read instead. `transform` is never re-entered concurrently — the
      // writable side serializes it on the promise this returns — so nothing else can claim the batch in
      // between.
      const permit = takePermit();
      if (permit) await permit;
      batch.push(chunk);
      // A macrotask, not a microtask: React writes a whole flush in one synchronous run but `pipeThrough`
      // delivers it one microtask at a time, and a script injected between two chunks lands inside a tag.
      boundary = schedule(() => {
        try {
          emitBatch(controller);
        } catch (error) {
          // A dead consumer, all but always. `teardown` rather than `flightDone` alone: a payload pump parked
          // on a permit has to be unparked too, and the RSC branch it holds released.
          controller.error(error);
          teardown(error);
          return;
        }
        if (!startedFlight) {
          startedFlight = true;
          // Deliberately not awaited: this runs inside a scheduled callback with nothing to return to, and
          // the chain already routes a write failure to `controller.error` before settling `flightDone`.
          void writeFlight(controller)
            .catch((error) => controller.error(error))
            .then(flightDone);
        }
      });
    },
    async flush(controller) {
      // Both of these have to happen *before* the await, and in this order.
      try {
        // Anything still batched — or carried — belongs ahead of the payload scripts, which sit at the end of
        // `<body>`. Called unconditionally: a `carry` outlives its boundary, and an empty batch returns early.
        if (boundary) unschedule(boundary);
        emitBatch(controller, true);
        // A writable side that closed without ever reaching `transform` — an HTML stream with no chunks at
        // all — leaves nothing to have started the payload, and `flightDone` is only ever called from that
        // chain or from `cancel`. Without this the await below parks on a promise nothing will settle and the
        // response never ends. `cancelled` short-circuits it: there is nowhere to write the payload to.
        if (!startedFlight) {
          startedFlight = true;
          if (cancelled) flightDone();
          else
            void writeFlight(controller)
              .catch((error) => controller.error(error))
              .then(flightDone);
        }
      } catch (error) {
        // The consumer went away while the batch was being emitted, so there is nothing left to write to and
        // nothing to wait for. Settled explicitly rather than left dangling, so the payload chain is released.
        teardown(error);
        return;
      }

      await flightWritten;
      // That await spans the whole payload, and the consumer can go away inside it — with `cancel` skipped
      // (see `cancelled`), a throwing enqueue is the only signal. Unguarded it rejects `flush`, which
      // nothing owns and which surfaces as an unhandled rejection.
      try {
        if (!cancelled) controller.enqueue(encoder.encode(TRAILER));
      } catch {
        // Nowhere left to put the trailer. A response the client abandoned is not a fault.
        cancelled = true;
        flightReader?.cancel().catch(() => {});
      } finally {
        // A `finally` because `onDone` releases the abort forwarder in `renderComponent`, however this ended.
        reportDone();
      }
    },
    cancel(reason) {
      teardown(reason);
    },
  };

  const inner = new TransformStream<Uint8Array, Uint8Array>(transformer);
  const innerReader = inner.readable.getReader();
  /**
   * A pull-driven wrapper around the transform's readable, and the only reason this function does not simply
   * return the transform: `pull` runs once per chunk the consumer takes, which is the demand signal the two
   * producers park on (see {@link takePermit}). It is also the one cancel notification the standard never
   * skips, which is what makes {@link teardown} reliable.
   */
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      releasePermit();
      const { done, value } = await innerReader.read();
      try {
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        // Cancelled while this pull was in flight. `teardown` has already run; there is nobody to hand it to.
      }
    },
    cancel(reason) {
      teardown(reason);
      return innerReader.cancel(reason);
    },
  });
  return { readable, writable: inner.writable };
}
