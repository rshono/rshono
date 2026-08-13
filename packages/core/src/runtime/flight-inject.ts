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

export function injectFlightPayload(
  rscStream: ReadableStream<Uint8Array>,
  options: { nonce?: string; onDone?: () => void } = {},
): TransformStream<Uint8Array, Uint8Array> {
  const { nonce, onDone } = options;
  const scriptOpen = `<script${nonce ? ` nonce="${nonce}"` : ''}>(self.__FLIGHT_DATA||=[]).push(`;
  const scriptClose = ')</script>';

  const { promise: flightWritten, resolve: flightDone } = Promise.withResolvers<void>();
  let startedFlight = false;

  const batch: Uint8Array[] = [];
  let boundary: TaskHandle | null = null;

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
   * Emits the HTML buffered since the last boundary, holding back the document trailer for
   * {@link TransformStream.flush} to re-emit after the payload scripts.
   *
   * The batch is joined before the trailer is looked for, so one React split across two views is still
   * found. React writes its final flush in one synchronous run, so a trailer split across *batches* is not
   * a shape it produces.
   */
  function emitBatch(controller: TransformStreamDefaultController<Uint8Array>): void {
    boundary = null;
    let total = 0;
    for (const chunk of batch) total += chunk.byteLength;
    if (total === 0) {
      batch.length = 0;
      return;
    }

    const joined = new Uint8Array(total);
    let at = 0;
    for (const chunk of batch) {
      joined.set(chunk, at);
      at += chunk.byteLength;
    }
    batch.length = 0;

    const end = endsWithTrailer(joined, total) ? total - TRAILER_BYTES.length : total;
    if (end > 0) controller.enqueue(joined.subarray(0, end));
  }

  async function writeFlight(controller: TransformStreamDefaultController<Uint8Array>): Promise<void> {
    const reader = (flightReader = rscStream.getReader());
    // `fatal`, so a chunk that split a multi-byte character throws instead of emitting U+FFFD; the catch
    // below falls back to a byte-exact encoding for it.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const push = (literal: string) => controller.enqueue(encoder.encode(scriptOpen + literal + scriptClose));
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
        push(literal);
      } catch {
        cancelled = true;
        reader.cancel().catch(() => {});
        return;
      }
    }
    if (cancelled) return;
    const remaining = decoder.decode();
    if (remaining.length) push(escapeScript(JSON.stringify(remaining)));
  }

  const transformer: CancellableTransformer<Uint8Array, Uint8Array> = {
    transform(chunk, controller) {
      batch.push(chunk);
      if (boundary) return;
      // A macrotask, not a microtask: React writes a whole flush in one synchronous run but `pipeThrough`
      // delivers it one microtask at a time, and a script injected between two chunks lands inside a tag.
      boundary = schedule(() => {
        try {
          emitBatch(controller);
        } catch (error) {
          controller.error(error);
          flightDone();
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
        // Anything still batched belongs ahead of the payload scripts, which sit at the end of `<body>`.
        if (boundary) {
          unschedule(boundary);
          boundary = null;
          emitBatch(controller);
        }
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
      } catch {
        // The consumer went away while the batch was being emitted, so there is nothing left to write to and
        // nothing to wait for. Settled explicitly rather than left dangling, so the payload chain is released.
        cancelled = true;
        flightReader?.cancel().catch(() => {});
        flightDone();
        onDone?.();
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
        onDone?.();
      }
    },
    cancel(reason) {
      cancelled = true;
      if (boundary) {
        unschedule(boundary);
        boundary = null;
      }
      batch.length = 0;
      // Otherwise the teed RSC branch keeps being pumped for a response nobody will read, and the tee's
      // other half buffers every chunk waiting for this one to catch up.
      flightReader?.cancel(reason).catch(() => {});
      // Unparks `flush` if it is waiting on a payload that will now never arrive.
      flightDone();
      onDone?.();
    },
  };
  return new TransformStream<Uint8Array, Uint8Array>(transformer);
}
