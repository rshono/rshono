import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { isPageRoute, type PageRoute, type Route } from '../router.js';
import {
  createPageCache,
  ssgFilePath,
  SSG_MANIFEST_FILE,
  toPrerenderedPage,
  VARIANTS,
  type PrerenderedPage,
  type PrerenderVariant,
} from './prerendered.js';

/**
 * Stand-in origin for a build that declared no `siteUrl`. Obviously wrong rather than a guess, so a page that
 * bakes it into a canonical tag is easy to spot; the build warns as well.
 */
const DEFAULT_SSG_ORIGIN = 'http://localhost';

/**
 * Resolves `siteUrl` to the origin prerendering renders against. A path is rejected rather than dropped:
 * `'https://example.com/docs'` means the author expects a base path, which is not supported.
 */
export function resolveSiteOrigin(siteUrl: string | undefined): string {
  if (!siteUrl) return DEFAULT_SSG_ORIGIN;
  const parsed = URL.parse(siteUrl);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(`[rshono] invalid siteUrl ${JSON.stringify(siteUrl)} — use a full origin, e.g. 'https://example.com'.`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`[rshono] siteUrl ${JSON.stringify(siteUrl)} must be a bare origin — a base path is not supported.`);
  }
  return parsed.origin;
}

/**
 * A route's path with its params filled in, ready to render and to store.
 *
 * Throws for a pattern `staticPaths` cannot fill and for a set that does not fill it. Both are warned about
 * and skipped by the caller, which already names the route — so these messages are the reason alone, written
 * to be read at the end of that line.
 */
function interpolatePath(pattern: string, params: Record<string, string>): string {
  return pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) {
        if (segment.includes('*')) {
          throw new Error(`wildcard segments are not supported by staticPaths`);
        }
        return segment;
      }
      const name = segment.slice(1);
      if (!/^\w+$/.test(name)) {
        throw new Error(`optional/regex params are not supported by staticPaths`);
      }
      const value = params[name];
      if (value === undefined) {
        throw new Error(`staticPaths returned a param set without "${name}"`);
      }
      return encodeURIComponent(value);
    })
    .join('/');
}

/** Prerendered pages, keyed by the request that produced them (see {@link readPrerendered}). */
const pageCache = createPageCache();

/** One in-flight or settled read of each store's {@link SSG_MANIFEST_FILE}; the file cannot change while the server is up. */
const storeIndexes = new Map<string, Promise<ReadonlySet<string> | null>>();

/**
 * What `ssgDir` holds, as {@link ssgFilePath} names it — or `null` where the build left no manifest, which
 * is every build made before there was one. A `null` gates nothing, so those keep the behaviour they had.
 */
function storeIndex(ssgDir: string): Promise<ReadonlySet<string> | null> {
  let pending = storeIndexes.get(ssgDir);
  if (!pending) {
    // One `catch` for both failures worth the same answer: no manifest, and a manifest that is not one.
    pending = readFile(join(ssgDir, SSG_MANIFEST_FILE), 'utf8')
      .then((text) => new Set((JSON.parse(text) as { files?: string[] }).files ?? []) as ReadonlySet<string>)
      .catch(() => null);
    storeIndexes.set(ssgDir, pending);
  }
  return pending;
}

export async function readPrerendered(ssgDir: string, requestPath: string, variant: PrerenderVariant = 'html'): Promise<PrerenderedPage | null> {
  // Keyed by what the request carried rather than by the resolved filename, so a hit costs one Map lookup. Safe
  // because only *hits* are cached: an entry exists only if this exact key already passed the checks below.
  const key = `${ssgDir}\0${variant}\0${requestPath}`;
  const cached = pageCache.get(key);
  if (cached) return cached;

  const relPath = ssgFilePath(requestPath, variant);
  if (relPath === null) return null;

  // Before the store is touched: a `render: 'static'` route whose build wrote nothing — no `staticPaths`, a
  // param the build never saw, a page that did not render cleanly — falls through to SSR on every request,
  // and without this each of those pays a failed read first, forever.
  const index = await storeIndex(ssgDir);
  if (index && !index.has(relPath)) return null;
  // Belt and braces over the shared traversal guard: this proves the resolved file is under the root.
  const root = resolve(ssgDir);
  const file = resolve(root, relPath);
  if (!file.startsWith(root + sep)) return null;

  // No encoding argument: the bytes are what gets served. Copied out of the Buffer rather than kept as one,
  // because `readFile` can hand back a view into Node's shared pool and this is retained for the process.
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await readFile(file));
  } catch {
    return null;
  }

  const page = await toPrerenderedPage(body);
  pageCache.set(key, page);
  return page;
}

interface PrerenderOptions {
  routes: readonly Route[];
  fetch: (request: Request) => Response | Promise<Response>;
  ssgDir: string;
  /** The origin absolute URLs in the output are built against — `siteUrl` from `rshono.config.ts`. */
  siteUrl?: string;
}

export interface PrerenderResult {
  written: string[];
  skipped: string[];
}

/**
 * Records what the pass wrote, beside what it wrote. Written by the same pass for the same reason
 * {@link ssgFilePath} is one function: an index that disagrees with the store is invisible, so the two are
 * produced together or not at all.
 */
function writeManifest(ssgDir: string, files: readonly string[]): void {
  mkdirSync(ssgDir, { recursive: true });
  writeFileSync(join(ssgDir, SSG_MANIFEST_FILE), `${JSON.stringify({ files }, null, 2)}\n`);
}

/**
 * One representation of a path, as the app answered for it at build time. Discriminated on `ok` because both
 * callers have to tell "the app rendered this" from "it did not", and only one cares why.
 */
type RenderedVariant = { ok: true; body: string } | { ok: false; reason: string };

async function renderVariant(fetch: PrerenderOptions['fetch'], url: string, variant: PrerenderVariant): Promise<RenderedVariant> {
  const response = await fetch(new Request(url, { headers: VARIANTS[variant].headers }));
  if (response.status !== 200) return { ok: false, reason: `${response.status}` };
  if (!(response.headers.get('Content-Type') ?? '').includes(VARIANTS[variant].contentType)) {
    return { ok: false, reason: `a non-${VARIANTS[variant].contentType} response` };
  }
  return { ok: true, body: await response.text() };
}

export async function prerenderStaticRoutes(options: PrerenderOptions): Promise<PrerenderResult> {
  const { routes, fetch, ssgDir } = options;
  const staticRoutes = routes.filter((r): r is PageRoute => isPageRoute(r) && r.render === 'static');
  const origin = resolveSiteOrigin(options.siteUrl);

  if (staticRoutes.length > 0 && !options.siteUrl) {
    console.warn(
      `  ⚠ No siteUrl in rshono.config — prerendered pages are built against ${DEFAULT_SSG_ORIGIN}, so any absolute URL\n` +
        `    they derive from a page's \`url\` prop (canonical tags, og:url, absolute links) will point there.`,
    );
  }

  const written: string[] = [];
  const skipped: string[] = [];
  /** Every file written, as the reader names it — {@link writeManifest}. */
  const files: string[] = [];

  for (const route of staticRoutes) {
    let paths: string[];
    if (!/[:*]/.test(route.path)) {
      paths = [route.path];
    } else {
      if (!route.staticPaths) {
        console.warn(`  ⚠ Static route "${route.path}" has params but no staticPaths — will SSR per request.`);
        skipped.push(route.path);
        continue;
      }
      try {
        paths = (await route.staticPaths()).map((params) => interpolatePath(route.path, params));
      } catch (error) {
        // A route whose paths cannot be computed — a wildcard or a regex/optional param, which `staticPaths`
        // has no way to fill, or a set it filled wrongly — is unprerenderable, not unservable. It gets the
        // same answer as the branch above rather than killing a build the route would have survived: the
        // page is still there, rendered per request.
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`  ⚠ Static route "${route.path}" will SSR per request — ${reason.replace(/\.$/, '')}.`);
        skipped.push(route.path);
        continue;
      }
    }

    for (const path of paths) {
      // Resolved *before* the render, so a path no file can hold fails the build naming the path, rather than
      // after the work and as a bare `join(dir, null)` TypeError. The same call answers for the reader, which
      // is the whole point: a page written under a name the request path never resolves to is a page the build
      // reports as prerendered and nothing ever serves.
      const relPath = ssgFilePath(path, 'html');
      if (relPath === null) {
        throw new Error(
          `Cannot prerender "${path}" for route "${route.path}": a path segment is "." or "..", or holds a ` +
            `character a portable file name cannot — one of \\ / : * ? " < > | or a control character.`,
        );
      }
      const pageDir = join(ssgDir, dirname(relPath));

      const document = await renderVariant(fetch, origin + path, 'html');
      if (!document.ok) {
        console.warn(`  ⚠ "${path}" rendered ${document.reason} at build time — skipping, will SSR per request.`);
        skipped.push(path);
        continue;
      }

      // Both representations of a page share its directory and differ only in the file name.
      const write = (variant: PrerenderVariant, body: string) => {
        mkdirSync(pageDir, { recursive: true });
        writeFileSync(join(pageDir, VARIANTS[variant].file), body);
        // `ssgFilePath` again rather than the `join` above: the manifest is read against what a *request*
        // resolves to, which is that function's output and not a filesystem path.
        files.push(ssgFilePath(path, variant)!);
      };
      write('html', document.body);

      // The soft-navigation representation of the same page. Best-effort: the document is valid on its own, and
      // serving falls back to rendering the flight payload per request.
      const flight = await renderVariant(fetch, origin + path, 'flight');
      if (flight.ok) {
        write('flight', flight.body);
      } else {
        console.warn(`  ⚠ "${path}" produced no flight payload — soft navigations to it will render per request.`);
      }

      written.push(path);
    }
  }

  // Only where the app has static routes at all: an empty manifest would be a store, and a build with
  // nothing to prerender should leave no `ssg/` directory for a preset to carry around.
  if (staticRoutes.length > 0) writeManifest(ssgDir, files);

  return { written, skipped };
}
