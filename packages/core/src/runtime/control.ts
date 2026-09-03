/**
 * `redirect()` and `notFound()` as thrown errors, and the `digest` string that carries them.
 *
 * The digest is the only part that survives React — a server component's error reaches the browser as a
 * digest with no message — so the redirect target is encoded into it. The server matches the class, the
 * client matches the string.
 */
const REDIRECT_PREFIX = 'RSHONO_REDIRECT;';
const NOT_FOUND_DIGEST = 'RSHONO_NOT_FOUND';

export class RedirectSignal extends Error {
  readonly digest: string;
  constructor(
    readonly location: string,
    readonly status: number,
  ) {
    super(`[rshono] redirect to ${location}`);
    this.name = 'RedirectSignal';
    this.digest = `${REDIRECT_PREFIX}${status};${encodeURIComponent(location)}`;
  }
}

export class NotFoundSignal extends Error {
  readonly digest = NOT_FOUND_DIGEST;
  constructor() {
    super('[rshono] notFound');
    this.name = 'NotFoundSignal';
  }
}

export type ControlSignal = RedirectSignal | NotFoundSignal;

export function isControlSignal(error: unknown): error is ControlSignal {
  return error instanceof RedirectSignal || error instanceof NotFoundSignal;
}

export function isControlDigest(digest: unknown): digest is string {
  return typeof digest === 'string' && (digest === NOT_FOUND_DIGEST || digest.startsWith(REDIRECT_PREFIX));
}

/**
 * Whether an error is React's stand-in for one that came out of a flight payload, rather than one that
 * started life where it was caught. Here, beside {@link isControlDigest}, because both are the same
 * question — what a `digest` tells you about where an error has been.
 *
 * A `digest` is what React puts on the far side of a payload boundary in place of the real error, so its
 * presence *is* the provenance: the layer that wrote the payload met the original and reported it in full.
 * Reporting the stand-in as well tags one fault with a second `source`, and in a build the copy carries no
 * message at all — React redacts it — so the second line says nothing the first did not.
 *
 * `reportServerError` cannot see this for itself: it de-duplicates on object identity, and a stand-in is a
 * different object. Every place a payload error can be reported a second time makes this test — the SSR
 * shell path, the top-level handler, and the `error` page's own catch.
 */
export function cameFromPayload(error: unknown): boolean {
  return typeof (error as { digest?: unknown } | null)?.digest === 'string';
}

export function parseRedirectDigest(digest: string): { location: string; status: number } | null {
  if (!digest.startsWith(REDIRECT_PREFIX)) return null;
  const rest = digest.slice(REDIRECT_PREFIX.length);
  const sep = rest.indexOf(';');
  if (sep === -1) return null;
  const status = Number(rest.slice(0, sep));
  const location = decodeURIComponent(rest.slice(sep + 1));
  return { location, status: Number.isFinite(status) ? status : 307 };
}
