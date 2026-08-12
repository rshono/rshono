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

export function parseRedirectDigest(digest: string): { location: string; status: number } | null {
  if (!digest.startsWith(REDIRECT_PREFIX)) return null;
  const rest = digest.slice(REDIRECT_PREFIX.length);
  const sep = rest.indexOf(';');
  if (sep === -1) return null;
  const status = Number(rest.slice(0, sep));
  const location = decodeURIComponent(rest.slice(sep + 1));
  return { location, status: Number.isFinite(status) ? status : 307 };
}
