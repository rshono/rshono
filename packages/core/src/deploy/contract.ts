import type { Context, Hono } from 'hono';
import type { PrerenderVariant, PrerenderedPage } from '../server/prerendered.js';

/**
 * A hosting platform `rshono build` targets. Selected with `deploy` in `rshono.config.ts`, the
 * `--deploy` flag or the `RSHONO_DEPLOY` env var.
 *
 * - `'node'` (the default) — rshono binds the port and you run the build with `rshono start`. Covers a
 *   VPS, a container, a PaaS, and — through `node:` compatibility — Bun and Deno.
 * - `'cloudflare'` — a Worker; the entry exports `{ fetch }`.
 * - `'vercel'` — a Vercel function, plus the on-disk layout and config streaming needs there.
 * - `'aws-lambda'` — a streaming Lambda handler.
 *
 * There is one target per *handoff* — who opens the socket, and what shape a request arrives in — since
 * that is the part an app cannot arrange for itself. `rshono dev` always runs the `node` server.
 *
 * @example
 * ```ts
 * export default defineConfig({ deploy: 'cloudflare' });
 * ```
 *
 * @see {@link https://www.rshono.com/docs/deployment#the-targets | Docs — the targets}
 */
export type DeployTarget = 'node' | 'cloudflare' | 'vercel' | 'aws-lambda';

/**
 * Everything the app server needs from the platform it runs on — the whole of what "which platform is
 * this" means at request time, since `runtime/entry.rsc.tsx` is written against this and nothing else.
 *
 * One preset implements it per target, and the build-time `@rshono/deploy` alias resolves to exactly
 * that module, so only the selected platform's code is ever in the bundle.
 */
export interface DeployRuntime {
  /**
   * Hands the app to the platform and returns whatever the entry module should `export default` there:
   * nothing where rshono owns the process (this binds the port), otherwise the export the platform looks
   * for — `{ fetch }` on Workers, a streaming handler on Lambda, and on Vercel a Node
   * `(IncomingMessage, ServerResponse)` listener, which is what its `Nodejs` launcher calls.
   *
   * Note that a web `Request` is not the common currency here: two of the three targets are handed one by
   * their platform, and Vercel is not, so converting is part of the handoff rather than something the
   * request-handling code below can assume has already happened.
   */
  serveApp(app: Hono): unknown;
  /** Mounts the hashed client bundle at `/_static`, ahead of the app's routes. A no-op where a CDN serves it. */
  mountStaticAssets(app: Hono): void;
  /** Mounts `public/` at the web root, after every route, so it only answers paths no route claimed. */
  mountPublicFallback(app: Hono): void;
  /**
   * Reads the page prerendered for `c.req.path`, or `null` when there is none — in which case the route
   * renders per request.
   *
   * Takes the whole {@link Context} because without a filesystem the store *is* a request-scoped
   * binding (`c.env.ASSETS` on Workers). The path is untrusted either way, so an implementation treats
   * traversal as a miss — see `ssgFilePath`, the one mapping from a path to the file that holds its page.
   */
  readPrerendered(c: Context, variant: PrerenderVariant): Promise<PrerenderedPage | null>;
  /** Loads `.env` files where the platform has a filesystem. Env is bindings elsewhere. */
  loadEnv(): void;
}
