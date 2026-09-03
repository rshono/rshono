/**
 * Header utilities shared by the response-header defaults and the prerendered-page cache. Their own module
 * because getting `Vary` and `ETag` comparison subtly wrong only shows up behind a CDN.
 */

/**
 * What a 404 under the `/_static` mount must carry, on every deploy target.
 *
 * A 404 is heuristically cacheable under RFC 9111, and the miss this answers is the one a **rolling deploy**
 * produces: an old instance 404s a content-hashed chunk the new one has. Without this a shared cache may
 * store that answer against a URL that is about to become valid, and then serve it to everyone.
 *
 * Shared by the two mounts — `createStaticAssetsApp` for the filesystem targets and `mountStaticAssets` in
 * `deploy/cloudflare/runtime.ts` — because it was written down in one of them and inherited by accident in
 * the other, which is how the Workers mount came to have no terminal 404 at all. Here rather than in either,
 * since `server/static.ts` reaches for `@hono/node-server` and a Worker bundle cannot import it.
 *
 * The same string as a page response's default (`PAGE_CACHE_CONTROL` in `entry.rsc.tsx`) and a separate
 * constant on purpose: that one is about a logged-in user's page, this one about a hash that is about to
 * resolve, and a change to either must not move the other.
 */
export const ASSET_MISS_CACHE_CONTROL = 'private, no-cache';

/**
 * The `Vary` a response needs in order to carry `value`, or `null` when there is nothing to write — because it
 * already lists it, or because it lists `*`, which means "never reuse this" and covers everything.
 *
 * What is already there is kept, spelling and all: a route, a middleware or a proxy may have added an entry of
 * its own, and a plain `set` would drop it, leaving a cache free to serve one variant in place of another.
 *
 * The header is parsed into entries rather than tested as a string, because both of the questions it is asked
 * are about the *list* and neither is about the text. `*` counts wherever it sits, not only alone — a cache
 * told never to reuse a response is not told it harder by another field name. And an existing header with no
 * entries in it (`vary: ''`, which an app writing one from a list that came out empty can produce, and which
 * Hono keeps verbatim) is nothing to append to: `, RSC` is an empty list element, which RFC 9110 tells a
 * sender not to generate, and a cache strict enough to reject the malformed header would drop the `Vary` that
 * is the only thing keeping a page URL's two representations apart. That is the failure this header exists to
 * prevent, reached through the header itself.
 *
 * Pure, and separate from {@link appendVary}, because the two callers cannot write the same way. One holds a
 * `Response` it built itself; the response floor holds one the *app* may have returned, whose header bag can be
 * immutable — see the floor in `entry.rsc.tsx`, which writes this answer through `c.header()`.
 */
export function varyWith(existing: string | null, value: string): string | null {
  if (existing === null) return value;
  const entries = existing.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry === '*' || entry.toLowerCase() === value.toLowerCase())) return null;
  // Appended to the original text, not to the parsed entries, so a header this has nothing to say about comes
  // back exactly as its author wrote it.
  return entries.some(Boolean) ? `${existing}, ${value}` : value;
}

/** {@link varyWith}, written straight back — for a `Headers` the caller knows it can write to. */
export function appendVary(headers: Headers, value: string): void {
  const vary = varyWith(headers.get('vary'), value);
  if (vary !== null) headers.set('vary', vary);
}

/**
 * True when an `If-None-Match` matches `etag` — the client already holds this body and can be answered with a
 * 304. The header carries a list, and the weak prefix is ignored on both sides: a CDN that gzips on the way out
 * changes the bytes without changing the representation, and may weaken the validator when it does.
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, '');
  const wanted = normalize(etag);
  return ifNoneMatch.split(',').some((entry) => {
    const candidate = normalize(entry);
    return candidate === '*' || candidate === wanted;
  });
}
