/**
 * Everything about a prerendered page that doesn't need a filesystem: where the build puts it, and what it
 * looks like once read back.
 *
 * Apart from `ssg.ts`, which does the reading and writing through `node:fs`, because a deploy target without a
 * filesystem reads the same layout out of an asset store — and importing it from there would drag `node:fs`
 * into a bundle that has neither.
 */

/**
 * The two representations of a page, prerendered side by side: a hard load wants the HTML document, a soft
 * navigation asks the same URL for a flight payload. Without both, every in-app click would re-render a page
 * that was already built.
 */
export type PrerenderVariant = 'html' | 'flight';

export const VARIANTS = {
  // `headers` is what the build asks each representation for, so it stays the same request the browser makes:
  // a document is the default and a flight payload is the `RSC` header. See `runtime/request.ts`.
  html: { file: 'index.html', headers: {}, contentType: 'text/html' },
  flight: { file: 'index.rsc', headers: { RSC: '1' }, contentType: 'text/x-component' },
} as const satisfies Record<PrerenderVariant, { file: string; headers: Record<string, string>; contentType: string }>;

/**
 * Where a route's prerendered output lives, relative to the output root — or `null` for a path that cannot be
 * prerendered at all, one with a param or a wildcard left in it.
 *
 * Always `/`-separated: the same string addresses a file on a filesystem, which accepts forward slashes on
 * Windows too, and a key in an asset store, where a backslash would be the wrong character.
 */
export function ssgFilePath(routePath: string, variant: PrerenderVariant = 'html'): string | null {
  if (/[:*]/.test(routePath)) return null;
  const trimmed = routePath.replace(/^\/+|\/+$/g, '');
  const file = VARIANTS[variant].file;
  return trimmed === '' ? file : `${trimmed}/${file}`;
}

/**
 * {@link ssgFilePath} for a path that came off a request, so traversal is a miss rather than a lookup. A store
 * addressed by key has no `resolve()` to fall back on, so `..` is refused here or not at all.
 */
export function prerenderedRelPath(requestPath: string, variant: PrerenderVariant): string | null {
  if (/(^|\/)\.\.?(\/|$)/.test(requestPath)) return null;
  return ssgFilePath(requestPath, variant);
}

/** The default cache budget: enough for a large documentation site's working set, small enough to be ignorable. */
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * A bounded, insertion-ordered cache of prerendered pages, so a site with thousands of them keeps a working set
 * rather than the whole build in memory. Only *hits* are stored — caching misses would let anyone mint entries
 * by requesting paths that don't exist — and the files never change while the server is up.
 *
 * Bounded by **bytes**, not by entry count: a count says nothing about how much memory it stands for, and a
 * page can be any size. At 128 entries — the previous limit — a documentation site with half-megabyte pages
 * retained ~64 MB across the two variants, with nothing about the number to suggest it.
 *
 * A page larger than the whole budget is served and not stored, rather than evicting everything to hold one.
 */
export function createPageCache(maxBytes = DEFAULT_CACHE_BYTES): {
  get(key: string): PrerenderedPage | undefined;
  set(key: string, page: PrerenderedPage): void;
} {
  const pages = new Map<string, PrerenderedPage>();
  let bytes = 0;
  return {
    get: (key) => pages.get(key),
    set(key, page) {
      const size = page.body.byteLength;
      if (size > maxBytes) return;
      // Deleted before it is set, so re-setting an existing key moves it to the *back*: `Map.set` on a key it
      // already holds keeps that key's original position, which would leave the entry just stored sitting at
      // the front as the next thing evicted — a store whose eviction could drop the write that caused it.
      const replaced = pages.get(key);
      if (replaced) {
        bytes -= replaced.body.byteLength;
        pages.delete(key);
      }
      pages.set(key, page);
      bytes += size;
      // Insertion-ordered, so the first key is the oldest.
      while (bytes > maxBytes) {
        const oldest = pages.keys().next().value!;
        bytes -= pages.get(oldest)!.body.byteLength;
        pages.delete(oldest);
      }
    },
  };
}

/**
 * A weak `ETag` for a page body — see {@link PrerenderedPage.etag} for why weak. Web Crypto rather than
 * `node:crypto`, so one implementation serves both a Node server and `workerd`.
 */
export async function weakEtag(body: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body);
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `W/"${base64url.slice(0, 22)}"`;
}

/**
 * Assembles a {@link PrerenderedPage} from a body just read out of the build. `storeEtag` is the validator the
 * store supplied, where it has one: it already describes these exact bytes, so it is weakened rather than
 * replaced by a fresh hash.
 */
export async function toPrerenderedPage(body: Uint8Array<ArrayBuffer>, storeEtag?: string | null): Promise<PrerenderedPage> {
  return {
    body,
    contentLength: String(body.byteLength),
    etag: storeEtag ? storeEtag.replace(/^(?!W\/)/, 'W/') : await weakEtag(body),
  };
}

/** A prerendered page, ready to serve: its body and a validator derived from those exact bytes. */
export interface PrerenderedPage {
  /**
   * The document or the flight payload, depending on which {@link PrerenderVariant} was read. Bytes rather
   * than a string, because this cache entry is served verbatim to every request that hits it — as a string,
   * each would pay a fresh UTF-8 encode of the whole page.
   */
  body: Uint8Array<ArrayBuffer>;
  /**
   * `Content-Length` for {@link body}, in bytes. Served explicitly because Hono sets no length for an
   * in-memory body, and a proxy in front is entitled to make decisions with it.
   */
  contentLength: string;
  /**
   * `ETag` for the page, so a revalidating client can be answered with a 304 instead of the body.
   *
   * Deliberately **weak**: the bytes on the wire depend on whether something in front re-encoded them, so a
   * strong validator would differ per coding and a cache would treat the 200 and the 304 that revalidates it
   * as different pages. A weak tag says "the same representation", which stays true across codings.
   */
  etag: string;
}
