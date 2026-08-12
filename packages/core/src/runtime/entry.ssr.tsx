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
   * Called when SSR fails before the shell is sent. Reporting is the RSC layer's job: this module is
   * compiled into the SSR layer, which gets its own instance of every module it imports, so a handler
   * registered through `@rshono/core/server` is not reachable from here.
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

// The baked config, not `process.env.NODE_ENV`: a deploy target need not have a `process`.
const isDev = __RSHONO_CONFIG__.isDev;

/** Escapes text going into HTML body content — a stack trace is untrusted input. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));
}

/**
 * The last-resort 500 document, for when SSR fails before a byte of the real shell was sent.
 *
 * Plain HTML with no client runtime and no stylesheet links: both came from the render that just failed,
 * and hydrating a mismatched payload would tear the page down over this very message. A string rather than
 * a component for the same reason — React is what failed. It must end with the document trailer, which
 * `injectFlightPayload` holds back and re-emits.
 *
 * The detail is dev-only, matching how the app's `error` page redacts.
 */
function failureDocument(error: unknown): ReadableStream<Uint8Array> {
  const detail = isDev ? (error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)) : null;
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>500 — Internal Server Error</title></head>' +
    '<body style="margin:0;padding:2rem;font:16px/1.6 system-ui,-apple-system,sans-serif;color:#18181b">' +
    '<h1 style="margin:0 0 .5rem;font-size:1.25rem">500 — Internal Server Error</h1>' +
    '<p style="margin:0 0 1.5rem;color:#52525b">' +
    (isDev
      ? 'Server-side rendering failed before the page shell could be sent, so the app’s error page could not be reached either.'
      : 'Something went wrong while rendering this page. Please try again.') +
    '</p>' +
    (detail
      ? '<pre style="margin:0;padding:1rem;overflow:auto;background:#f4f4f5;border-left:3px solid #ef4444;' +
        `font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word">${escapeHtml(detail)}</pre>`
      : '') +
    '</body></html>';
  const bytes = new TextEncoder().encode(html);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

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
    if (typeof (error as { digest?: unknown } | null)?.digest === 'string') return;
    if (options.signal?.aborted) return; // an abort is the client leaving, not a fault
    reported = error;
    options.onError?.(error);
  };

  let htmlStream: ReadableStream<Uint8Array>;
  let status: number | undefined;
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
    if (isControlDigest((error as { digest?: unknown } | null)?.digest)) throw error;
    // `onError` runs first for the failure that aborts the shell, so this reports only what it let through.
    if (!options.signal?.aborted && error !== reported) options.onShellError?.(error);
    status = 500;
    htmlStream = failureDocument(error);
  }

  const responseStream = htmlStream.pipeThrough(injectFlightPayload(rscForClient, { nonce: options.nonce, onDone: options.onDone }));

  return { stream: responseStream, status };
}
