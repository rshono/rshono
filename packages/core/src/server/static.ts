import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { ASSET_MISS_CACHE_CONTROL } from './headers.js';

const CONTENT_HASHED = /\.[0-9a-f]{8,}\./;

function cacheControl(isDev: boolean): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status !== 200 && c.res.status !== 206) return;
    c.res.headers.set(
      'Cache-Control',
      isDev ? 'no-cache' : CONTENT_HASHED.test(c.req.path) ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    );
  };
}

interface StaticOptions {
  /** Directory the files are read from. */
  root: string;
  /** Dev serves revalidated (`no-cache`); a build serves hashed files as immutable. */
  isDev: boolean;
}

/** A sub-app serving the hashed client bundle, to be mounted at `/_static`. */
export function createStaticAssetsApp(options: StaticOptions): Hono {
  const { root, isDev } = options;
  const app = new Hono();

  // `GET` alone: Hono dispatches a `HEAD` as a `GET` and strips the body, so a `HEAD` registration beside it
  // is never reached — see `HTTPMethod`.
  // The 404 carries a `Cache-Control` of its own because `cacheControl` above returns early for it; the
  // policy and the reason are {@link ASSET_MISS_CACHE_CONTROL}'s, and the Workers mount answers a miss with
  // the same pair.
  app.get('/*', cacheControl(isDev), serveStatic({ root, rewriteRequestPath: (path) => path.replace(/^\/_static/, '') }), (c) =>
    c.text('Not Found', 404, { 'cache-control': ASSET_MISS_CACHE_CONTROL }),
  );

  return app;
}

/** Middleware serving the app's `public/` files verbatim at the web root, for paths no route claimed. */
export function createPublicFallback({ root, isDev }: StaticOptions): MiddlewareHandler {
  const serve = serveStatic({ root });
  return async (c, next) => {
    const result = await serve(c, next);
    if (result instanceof Response && (result.status === 200 || result.status === 206)) {
      result.headers.set('Cache-Control', isDev ? 'no-cache' : 'public, max-age=300');
    }
    return result;
  };
}
