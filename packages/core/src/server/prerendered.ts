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
 * How a build-time document render tells the prerender pass that the app minted a CSP nonce for its path.
 *
 * The other half of the same contract as {@link VARIANTS}, and it exists because the pass cannot see the
 * request it made: it renders through the app's own middleware inside the server bundle, in a module graph of
 * its own, and keeps the body alone. What it needs to know is whether a *request* for this path will mint a
 * nonce, because a document that will is one the framework re-renders per request — so the file the pass is
 * about to write is one no deployment will read, and saying "prerendered" about it is a lie by omission.
 *
 * Set only while `RSHONO_PRERENDER` is in the environment, which is `rshono build`'s own process, so it never
 * reaches a deployed response; and never stored, since only the body is.
 */
export const PRERENDER_NONCE_HEADER = 'x-rshono-prerender-nonce';

/**
 * The index the build leaves beside the pages, naming every file it wrote — one `files` array of
 * {@link ssgFilePath} names.
 *
 * It exists so a reader can tell "this store has no page for that path" without asking the store, which is
 * the difference between a `Map` lookup and a failed `readFile` (or, without a filesystem, a failed store
 * fetch) on **every** request to a static route the build could not prerender — misses are deliberately not
 * cached, so that one never warms up. Absent is not an error: a build from an older rshono has none, and a
 * reader that finds none looks the way it always did.
 */
export const SSG_MANIFEST_FILE = 'manifest.json';

/**
 * What a decoded path segment may not hold if it is to be one portable file name. `\ / : * ? " < > |` are
 * refused by Windows and `/` by every host, so a `staticPaths` value containing one fails the build rather
 * than writing a page on one machine and not on another — and a route pattern, whose params and wildcards are
 * spelled with `:` and `*`, falls out of the same rule.
 */
const UNPORTABLE_SEGMENT = /[\\/:*?"<>|]/;

/**
 * The DOS device names Windows still reserves, with or without an extension and whatever the case — so
 * `con`, `CON` and `Con.txt` are all the console. `mkdir` on one fails with `EINVAL`, naming a path the
 * author never wrote, which is why they are refused here with the rest.
 *
 * The list is Microsoft's, superscripts included: `CON PRN AUX NUL`, `COM0`–`COM9`, `COM¹ COM² COM³`, and
 * the same three suffixes for `LPT`. A documentation slug of `con` is a plausible thing to write and
 * builds fine on Linux today; refusing it everywhere is the same trade `:` and `*` already make — portable
 * or not at all, rather than a build that works on the author's machine and fails in CI on Windows.
 */
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/**
 * A trailing `.` or space, which Win32 **strips** rather than refusing: `docs/x.` is stored as `docs/x`, so
 * the page is written where no reader will look for it — "a page the build reports as prerendered and
 * nothing ever serves", which is the failure {@link ssgFilePath} exists to prevent. The silent half of this
 * rule, and the more important one: the reserved names above at least fail loudly.
 */
const TRAILING_STRIPPED = /[. ]$/;

/**
 * Decodes one path segment the way a URL does, treating a malformed escape as the literal text it is:
 * `decodeURIComponent('%')` throws, and a request path is whatever the client chose to send.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Whether one decoded segment can be a directory in the prerender tree, on every host rather than on this
 * one: not empty, not a relative-path marker, made only of characters a file name can hold
 * ({@link UNPORTABLE_SEGMENT}, plus the control characters, which a percent-escape is free to carry into a
 * path and no filesystem wants in a name), not a {@link RESERVED_DEVICE_NAME}, and not ending in a
 * character Win32 would {@link TRAILING_STRIPPED | strip}.
 *
 * The last two are Windows rules that no macOS or Linux build can discover for itself — which is exactly
 * why they belong in a check rather than in a caveat.
 */
function isStorableSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false;
  if (RESERVED_DEVICE_NAME.test(segment) || TRAILING_STRIPPED.test(segment)) return false;
  return !UNPORTABLE_SEGMENT.test(segment) && ![...segment].some((char) => char < ' ');
}

/**
 * Where a path's prerendered output lives, relative to the output root — or `null` for a path no single file
 * can answer.
 *
 * **The one canonical form**, shared by the build that writes the file and by every deploy target that reads
 * it back, because the two drifting apart is invisible: the build reports the page as prerendered and every
 * request afterwards falls through to SSR, forever. Each segment is stored *decoded*, so `/docs/café` is
 * `docs/café` whether the caller holds the path percent-encoded — the build, which interpolates `staticPaths`
 * values into a URL — or already decoded, as Hono's `c.req.path` is: it runs `decodeURI` over any path
 * containing a `%`. Decoded is also the form every other static file server addresses, so the tree stays
 * servable by something that is not this framework.
 *
 * Always `/`-separated: the same string addresses a file on a filesystem, which accepts forward slashes on
 * Windows too, and a key in an asset store, where a backslash would be the wrong character.
 *
 * `null` is everything that is not one file: a `.` or `..` segment — so traversal is a miss rather than a
 * lookup, which a store addressed by key, with no `resolve()` to fall back on, depends on — an empty segment,
 * and any segment {@link isStorableSegment} refuses as unportable.
 */
export function ssgFilePath(path: string, variant: PrerenderVariant = 'html'): string | null {
  const file = VARIANTS[variant].file;
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return file;

  const segments: string[] = [];
  for (const encoded of trimmed.split('/')) {
    const segment = decodeSegment(encoded);
    if (!isStorableSegment(segment)) return null;
    segments.push(segment);
  }
  return `${segments.join('/')}/${file}`;
}

/**
 * {@link ssgFilePath} as a URL path, for a store addressed by one rather than by key. Every segment is escaped
 * on the way out and the store decodes it back, so a page reached through a URL lands on the same file a
 * filesystem target opens by name.
 */
export function ssgAssetPath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/');
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
async function weakEtag(body: Uint8Array<ArrayBuffer>): Promise<string> {
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
