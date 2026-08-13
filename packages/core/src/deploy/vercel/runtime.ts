import type { Hono } from 'hono';
import { handle } from 'hono/vercel';
import type { DeployRuntime } from '../contract.js';
import { fileSystemRuntime } from '../filesystem.js';

/**
 * Vercel, as a single Node function fed by the platform's own router.
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
    return handle(app);
  },
};
