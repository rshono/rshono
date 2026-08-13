import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployRuntime } from '../contract.js';
import { fileSystemRuntime } from '../filesystem.js';

/**
 * The scheme the browser used, which the socket cannot answer for: Vercel terminates TLS at the edge and
 * reaches the function over plain HTTP, so an `https://` request arrives on an unencrypted socket and every
 * absolute URL the app derived from it would carry the wrong scheme — a redirect back to `http://`, an
 * origin check comparing against one.
 *
 * Read without `trustProxy`, unlike `publicUrl`, because on this target the header is not
 * client-supplied: the function is reachable only through Vercel's edge, which sets it on every request. The
 * config field stays what it is — the answer for a proxy *you* put in front, which the framework cannot vouch
 * for. Falls back to `https`, the only scheme a deployment is served on.
 */
function browserScheme(incoming: IncomingMessage): string {
  const header = incoming.headers['x-forwarded-proto'];
  const value = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
  return value === 'http' ? 'http' : 'https';
}

/**
 * Vercel, as a single Node function fed by the platform's own router.
 *
 * The function is invoked the way `launcherType: 'Nodejs'` invokes one — with `(IncomingMessage,
 * ServerResponse)`, not a web `Request`. That is the whole of the Build Output API's Node contract; the
 * `Request`/`Response` handler shape the platform documents elsewhere belongs to the `@vercel/node` builder,
 * which compiles and wraps a source file, and a `--prebuilt` upload never runs it. So the handoff converts,
 * and `hono/vercel`'s `handle` — a pass-through that forwards its first argument straight to `app.fetch` —
 * cannot be what does it.
 *
 * `/_static` and `public/` are in the static output, and `config.json` puts the filesystem handler ahead of the
 * function, so mounting them here would be dead weight. Prerendered pages are *not* static output — one URL
 * answers with a document or a flight payload on the `RSC` request header, and a path-keyed CDN cannot choose — so
 * they ship inside the function and are read from its read-only disk, exactly as on a server.
 */
export const runtime: DeployRuntime = {
  ...fileSystemRuntime,

  mountStaticAssets(): void {
    // Served from `.vercel/output/static` before the function runs.
  },

  mountPublicFallback(): void {
    // As above: `public/` is in the static output and `{ handle: 'filesystem' }` is matched ahead of this
    // function, so nothing here could ever answer for one of those paths. Stated as an override rather than
    // left to fall out of `dist/public` not being uploaded, because that would make the behaviour incidental
    // to a `cpSync` in `build.ts` instead of a decision.
    //
    // The one thing this hands to the platform: resolving a directory to its `index.html`. Vercel's static
    // handler does that; `serveStatic`, which the filesystem targets use, is no longer in the path.
  },

  serveApp(app: Hono): unknown {
    // The same conversion `rshono start` runs on, so a request is built here exactly as it is on the `node`
    // target — including a streamed response body, which `supportsResponseStreaming` in `.vc-config.json`
    // then keeps unbuffered on the way out.
    const listener = getRequestListener(app.fetch);

    return (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
      const host = incoming.headers.host;
      // Left alone when there is no `Host`, so the listener answers with its own 400 rather than this
      // building `https://undefined/…` and the app rejecting a URL it should never have been handed.
      if (host) incoming.url = `${browserScheme(incoming)}://${host}${incoming.url ?? '/'}`;
      return listener(incoming, outgoing);
    };
  },
};
