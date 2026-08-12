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

  serveApp(app: Hono): unknown {
    return handle(app);
  },
};
