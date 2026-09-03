import type { Context, Hono } from 'hono';
import { ASSET_MISS_CACHE_CONTROL } from '../../server/headers.js';
import { createPageCache, ssgAssetPath, ssgFilePath, SSG_MANIFEST_FILE, toPrerenderedPage, type PrerenderedPage } from '../../server/prerendered.js';
import type { DeployRuntime } from '../contract.js';

/**
 * Where `finalize` puts the prerendered pages inside the assets directory.
 *
 * A prefix of its own, rather than the pages' real URLs, is what keeps every page URL reaching the worker: one
 * URL answers with a document or a flight payload on the `RSC` request header, and a path-keyed CDN cannot make that
 * choice. The tree is reachable here too, so `finalize` marks it `noindex` rather than leaving a crawler to
 * find the same page twice.
 */
const SSG_PREFIX = '/__ssg';

/** The Workers Assets binding, as much of it as this file uses. */
interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

function assetsBinding(c: Context): AssetsBinding | null {
  const binding = (c.env as { ASSETS?: AssetsBinding } | undefined)?.ASSETS;
  return binding && typeof binding.fetch === 'function' ? binding : null;
}

/**
 * Asks the assets binding for one path, or `null` when there is no binding — which is how a caller tells "this
 * deployment serves its assets some other way" from "that file is not there".
 *
 * `headers` is forwarded only where the *client's* conditional and range requests should be answered by the
 * store: an `If-None-Match` on a page being fetched to serve would come back 304 with no body.
 */
async function assetResponse(c: Context, path: string, headers?: Headers): Promise<Response | null> {
  const binding = assetsBinding(c);
  if (!binding) return null;
  // Resolved against the request so the lookup carries this deployment's own origin; only the path is used.
  const url = new URL(path, c.req.url);
  return binding.fetch(new Request(url, { method: 'GET', headers }));
}

/**
 * Hands an asset response back as the app's own. Rebuilt rather than returned as-is, because a `Response` from
 * `fetch` has immutable headers and the framework's outermost middleware writes to them on the way out.
 */
function serveAsset(asset: Response): Response {
  return new Response(asset.body, asset);
}

/** Prerendered pages, keyed by the path that produced them. Per isolate rather than per process. */
const pageCache = createPageCache();

/** The store's own index of itself, fetched once per isolate — see {@link SSG_MANIFEST_FILE}. */
let storeIndex: Promise<ReadonlySet<string> | null> | undefined;

/**
 * What the store holds, or `null` where there is no manifest to read — an older build, or a deployment with
 * no assets binding at all. `null` gates nothing, which is how it behaved before there was an index.
 *
 * Worth one fetch per isolate: without it every request for a path the build did not prerender spends a
 * subrequest asking the binding for a file that is not there, and misses are deliberately not cached.
 */
function knownFiles(c: Context): Promise<ReadonlySet<string> | null> {
  storeIndex ??= assetResponse(c, `${SSG_PREFIX}/${SSG_MANIFEST_FILE}`)
    .then(async (asset) => {
      if (!asset || asset.status !== 200) return null;
      const manifest = (await asset.json()) as { files?: string[] };
      return new Set(manifest.files ?? []);
    })
    .catch(() => null);
  return storeIndex;
}

/**
 * Cloudflare Workers: the host owns the process, so there is nothing to listen on, and there is no filesystem,
 * so `.env` files are out. What is left is the assets binding, which every read here goes through.
 */
export const runtime: DeployRuntime = {
  serveApp(app: Hono): unknown {
    // `app.fetch` already takes `(request, env, ctx)`, which is why bindings arrive as `c.env`.
    return { fetch: app.fetch };
  },

  mountStaticAssets(app: Hono): void {
    // Normally dead — the CDN answers `/_static/*` before the worker is invoked — but keeps the deployment
    // correct, if slower, under an assets configuration that routes everything to the worker first.
    // `GET` covers `HEAD` — Hono dispatches one as the other. See `HTTPMethod`.
    //
    // Terminal, like the filesystem mount's last handler, and this used to be `next()`: a miss walked the
    // whole route table, then `mountPublicFallback`, and landed in `app.notFound` — which for anything asking
    // for HTML is a full server render of the app's 404 page under a prefix no app can own. A browser asking
    // for a real subresource sends `Accept: */*` and got the plain 404 either way, so what it cost was a
    // render for a crawler, a probe, or a hand-typed URL. `RESERVED_PREFIX`'s doc in `validate-entries.ts`
    // says the mount ends in a terminal 404 and the reserved-route check leans on it; on this target it did
    // not. `null` — no assets binding at all — answers the same way: nothing else in the worker can serve
    // this prefix, so falling through would only find a longer route to the same status.
    app.get('/_static/*', async (c) => {
      const asset = await assetResponse(c, c.req.path, c.req.raw.headers);
      if (asset && asset.status !== 404) return serveAsset(asset);
      return c.text('Not Found', 404, { 'cache-control': ASSET_MISS_CACHE_CONTROL });
    });
  },

  mountPublicFallback(app: Hono): void {
    app.get('/*', async (c, next) => {
      // The prerender tree lives in the same store, but the app only serves it through `readPrerendered`.
      if (c.req.path.startsWith(`${SSG_PREFIX}/`)) return next();
      const asset = await assetResponse(c, c.req.path, c.req.raw.headers);
      return asset && asset.status !== 404 ? serveAsset(asset) : next();
    });
  },

  async readPrerendered(c: Context, variant): Promise<PrerenderedPage | null> {
    const relPath = ssgFilePath(c.req.path, variant);
    if (relPath === null) return null;

    const key = `${variant}\0${relPath}`;
    const cached = pageCache.get(key);
    if (cached) return cached;

    const index = await knownFiles(c);
    if (index && !index.has(relPath)) return null;

    // Escaped on the way into the URL and decoded again by the store, so this lands on the file the build
    // wrote under exactly `relPath` — a page whose slug holds a `#` or a `?` included.
    const asset = await assetResponse(c, `${SSG_PREFIX}/${ssgAssetPath(relPath)}`);
    if (!asset || asset.status !== 200) return null;

    // The store's own validator where it has one — it already describes these exact bytes.
    const page = await toPrerenderedPage(new Uint8Array(await asset.arrayBuffer()), asset.headers.get('etag'));
    pageCache.set(key, page);
    return page;
  },

  loadEnv(): void {
    // Nothing to load: secrets and bindings arrive per request as `c.env`, which `getRequestContext().env`
    // already merges.
  },
};
