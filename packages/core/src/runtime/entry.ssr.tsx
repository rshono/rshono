import React from 'react';
import type { ReactFormState } from 'react-dom/client';
import { renderToReadableStream } from 'react-dom/server';
import { createFromReadableStream } from 'react-server-dom-rspack/client';
import { isControlDigest } from './control.js';
import { injectFlightPayload } from './flight-inject.js';
import type { RscPayload } from './entry.rsc.js';

export interface RenderHTMLOptions {
  bootstrapScripts?: string[];
  formState?: ReactFormState;
  signal?: AbortSignal;
  nonce?: string;
  /**
   * Called when SSR fails before the shell is sent with an error nothing else has seen, just before
   * {@link renderHTML} re-throws. Reporting is the RSC layer's job: this module is compiled into the SSR
   * layer, which gets its own instance of every module it imports, so a handler registered through
   * `@rshono/core/server` is not reachable from here.
   *
   * **A defensive floor, and expected to stay quiet.** Every failure React announces reaches
   * {@link RenderHTMLOptions.onError} first, and both of the shapes that then abort the shell are already
   * accounted for: one that came out of the payload was reported by the RSC layer, and one that started
   * here was reported by `onError` itself. What is left is a rejection React never announced — the same
   * shape as the client runtime's "produced no result" branch, and kept for the same reason.
   */
  onShellError?: (error: unknown) => void;
  /**
   * Called for an error that *originated* in SSR — a client component that threw while rendering on the
   * server. See {@link renderHTML} for why the others are dropped.
   */
  onError?: (error: unknown) => void;
  /**
   * Called once the response stream has ended, however it ended. Load-bearing: the RSC layer uses it to
   * detach the abort forwarder that would otherwise retain the whole rendered tree.
   */
  onDone?: () => void;
}

/**
 * Whether an error is React's stand-in for one that came out of the flight payload, rather than one that
 * started life in this render.
 *
 * A `digest` is what React puts on the client side of the payload boundary in place of the real error, so
 * its presence *is* the provenance: the layer that wrote the payload met the original and reported it in
 * full. Reporting the stand-in too would tag one fault with a second `source`, and in a build the copy
 * carries no message — React redacts it — so the second line says nothing the first did not.
 *
 * A control signal also crosses as a digest, which is why the callers test {@link isControlDigest} first
 * where it matters: those are not faults at all.
 */
function cameFromPayload(error: unknown): boolean {
  return typeof (error as { digest?: unknown } | null)?.digest === 'string';
}

/**
 * Renders the flight payload to an HTML document, with a copy of the payload inlined for the client.
 *
 * **A shell failure is thrown, not answered.** Nothing has reached the socket when `renderToReadableStream`
 * rejects — the response has not been built yet, let alone returned — so the fault belongs in front of
 * `app.onError`, where the app's `error` page lives. Absorbing it into a framework document here was the one
 * path that page could not be reached from, which made `RouteConfig.error`'s "rendered when a request
 * throws" false for the commonest server error there is: a page component that throws.
 */
export async function renderHTML(rscStream: ReadableStream<Uint8Array>, options: RenderHTMLOptions) {
  // One copy is rendered to HTML here; the other rides along in that HTML for the client to hydrate from.
  const [rscForSsr, rscForClient] = rscStream.tee();

  let payload: Promise<RscPayload>;
  function SsrRoot() {
    payload ??= createFromReadableStream<RscPayload>(rscForSsr, options.nonce ? { nonce: options.nonce } : undefined);
    return React.use(payload).root;
  }

  // React hands `onError` every error it meets while streaming, contained ones included. Almost all arrive
  // out of the flight payload as its redacted stand-in — a `digest` and no message — and the RSC layer has
  // already reported those in full. Only an error carrying no digest started life in this render, and that
  // one nothing else will report.
  let reported: unknown;
  const onError = (error: unknown): void => {
    if (cameFromPayload(error)) return;
    if (options.signal?.aborted) return; // an abort is the client leaving, not a fault
    reported = error;
    options.onError?.(error);
  };

  let htmlStream: ReadableStream<Uint8Array>;
  try {
    htmlStream = await renderToReadableStream(<SsrRoot />, {
      bootstrapScripts: options.bootstrapScripts,
      formState: options.formState,
      signal: options.signal,
      nonce: options.nonce,
      // Returns nothing, so the digest React gives the client's `onRecoverableError` is unchanged.
      onError,
    });
  } catch (error) {
    // The inlining branch is never read now, so drop it rather than leave the tee buffering a side no
    // reader will come for. The SSR branch is locked by `createFromReadableStream` and is the caller's to
    // wind down, through the signal both renders were handed.
    void rscForClient.cancel().catch(() => {
      // Nothing holds it either way.
    });
    if (isControlDigest((error as { digest?: unknown } | null)?.digest)) throw error;
    // `onError` runs first for the failure that aborts the shell, so this reports only what it let through:
    // not an error `onError` forwarded, and not one it dropped as a payload stand-in. Without the second
    // test this was the *only* live path to `onShellError` — a thrown page component was reported twice,
    // as `render` and then as a message-free `ssr` copy of itself, while the SSR-only failure the hook is
    // named for never reached it at all.
    if (!options.signal?.aborted && error !== reported && !cameFromPayload(error)) options.onShellError?.(error);
    throw error;
  }

  return { stream: htmlStream.pipeThrough(injectFlightPayload(rscForClient, { nonce: options.nonce, onDone: options.onDone })) };
}
