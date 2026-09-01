import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

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
  // The 404 carries a `Cache-Control` of its own because `cacheControl` above returns early for it, and a
  // 404 is heuristically cacheable under RFC 9111 — the same reasoning as `plainNotFound`'s, and it matters
  // most here: during a rolling deploy an old instance 404s a chunk the new one has, and without this a
  // shared cache may store that answer for a content-hashed URL that is about to become valid.
  app.get('/*', cacheControl(isDev), serveStatic({ root, rewriteRequestPath: (path) => path.replace(/^\/_static/, '') }), (c) =>
    c.text('Not Found', 404, { 'cache-control': 'private, no-cache' }),
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
