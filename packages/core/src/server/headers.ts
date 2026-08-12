/**
 * Header utilities shared by the response-header defaults and the prerendered-page cache. Their own module
 * because getting `Vary` and `ETag` comparison subtly wrong only shows up behind a CDN.
 */

/**
 * Adds `value` to the `Vary` header without discarding what is already there — a route, a middleware or a proxy
 * may have added its own entry, and a plain `set` would drop it, leaving a cache free to serve one variant in
 * place of another. `*` is left alone: it already means "never reuse this".
 */
export function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('vary');
  if (existing === null) {
    headers.set('vary', value);
    return;
  }
  if (existing.trim() === '*') return;
  const already = existing.split(',').some((entry) => entry.trim().toLowerCase() === value.toLowerCase());
  if (!already) headers.set('vary', `${existing}, ${value}`);
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
