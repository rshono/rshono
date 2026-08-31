import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { isPageRoute, type PageRoute, type Route } from '../router.js';
import { createPageCache, ssgFilePath, toPrerenderedPage, VARIANTS, type PrerenderedPage, type PrerenderVariant } from './prerendered.js';

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

function interpolatePath(pattern: string, params: Record<string, string>): string {
  return pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) {
        if (segment.includes('*')) {
          throw new Error(`Cannot prerender "${pattern}": wildcard segments are not supported by staticPaths.`);
        }
        return segment;
      }
      const name = segment.slice(1);
      if (!/^\w+$/.test(name)) {
        throw new Error(`Cannot prerender "${pattern}": optional/regex params are not supported by staticPaths.`);
      }
      const value = params[name];
      if (value === undefined) {
        throw new Error(`staticPaths for "${pattern}" returned a param set without "${name}".`);
      }
      return encodeURIComponent(value);
    })
    .join('/');
}

/** Prerendered pages, keyed by the request that produced them (see {@link readPrerendered}). */
const pageCache = createPageCache();

export async function readPrerendered(ssgDir: string, requestPath: string, variant: PrerenderVariant = 'html'): Promise<PrerenderedPage | null> {
  // Keyed by what the request carried rather than by the resolved filename, so a hit costs one Map lookup. Safe
  // because only *hits* are cached: an entry exists only if this exact key already passed the checks below.
  const key = `${ssgDir}\0${variant}\0${requestPath}`;
  const cached = pageCache.get(key);
  if (cached) return cached;

  const relPath = ssgFilePath(requestPath, variant);
  if (relPath === null) return null;
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
      paths = (await route.staticPaths()).map((params) => interpolatePath(route.path, params));
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

  return { written, skipped };
}
