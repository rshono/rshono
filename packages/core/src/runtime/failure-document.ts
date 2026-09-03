// The baked config, not `process.env.NODE_ENV`: a deploy target need not have a `process`.
const isDev = __RSHONO_CONFIG__.isDev;

/** Escapes text going into HTML body content — a stack trace is untrusted input. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));
}

/**
 * The framework's last-resort 500 document, for a client that asked for HTML and has nothing better to be
 * given: an app with no `error` page in its `routes.ts`, or one whose `error` page threw in its turn.
 *
 * Plain HTML with no client runtime and no stylesheet links. Both would have come from a render that failed,
 * and there is no payload to hydrate from — attaching the runtime would tear the page down over this very
 * message. A string rather than a component for the same reason: React is what failed.
 *
 * The detail is dev-only, matching how the app's `error` page redacts.
 */
export function failureDocument(error: unknown): string {
  const detail = isDev ? (error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)) : null;
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>500 — Internal Server Error</title></head>' +
    '<body style="margin:0;padding:2rem;font:16px/1.6 system-ui,-apple-system,sans-serif;color:#18181b">' +
    '<h1 style="margin:0 0 .5rem;font-size:1.25rem">500 — Internal Server Error</h1>' +
    '<p style="margin:0 0 1.5rem;color:#52525b">' +
    (isDev
      ? 'The request failed and the app’s error page did not answer it: either src/routes.ts declares no <code>error</code> page, or that page threw in its turn. Both are reported on the server.'
      : 'Something went wrong while handling this request. Please try again.') +
    '</p>' +
    (detail
      ? '<pre style="margin:0;padding:1rem;overflow:auto;background:#f4f4f5;border-left:3px solid #ef4444;' +
        `font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word">${escapeHtml(detail)}</pre>`
      : '') +
    '</body></html>'
  );
}
