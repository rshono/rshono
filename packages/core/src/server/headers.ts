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
 * already lists it, or because it is `*`, which means "never reuse this" and covers everything.
 *
 * What is already there is kept: a route, a middleware or a proxy may have added an entry of its own, and a
 * plain `set` would drop it, leaving a cache free to serve one variant in place of another.
 *
 * Pure, and separate from {@link appendVary}, because the two callers cannot write the same way. One holds a
 * `Response` it built itself; the response floor holds one the *app* may have returned, whose header bag can be
 * immutable — see the floor in `entry.rsc.tsx`, which writes this answer through `c.header()`.
 */
export function varyWith(existing: string | null, value: string): string | null {
  if (existing === null) return value;
  if (existing.trim() === '*') return null;
  const already = existing.split(',').some((entry) => entry.trim().toLowerCase() === value.toLowerCase());
  return already ? null : `${existing}, ${value}`;
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
