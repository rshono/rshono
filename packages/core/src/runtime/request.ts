/**
 * The header that names the server action a client-initiated call wants to run, and so the header that
 * decides which of the two action branches a POST takes.
 *
 * That choice is a security boundary, not just a dispatch detail. It is deliberately *not* a CORS-safelisted
 * header: a page on another origin cannot send one without a successful preflight, and the framework answers
 * no preflight, so the `rsc-action` branch is unreachable cross-origin and carries no origin check of its
 * own. The `form-action` branch is the forgeable one — a form post needs no preflight — and that is the one
 * `refusesCrossSiteForm` stands in front of. See `SECURITY.md`.
 */
const HEADER_ACTION_ID = 'x-rsc-action';

/**
 * The header that asks a page URL for its flight payload rather than its HTML document, and the value it
 * carries. One URL answers as either, so this is what the response `Vary`s on.
 *
 * A header of its own rather than `Accept: text/x-component`, which is what this used to be. Content
 * negotiation was the more standards-shaped mechanism and it cost too much: a prerendered page is served
 * `public, max-age=300`, and `Vary: Accept` on a publicly cacheable response is close to a cache-disabling
 * header — real browsers send long `Accept` strings that differ by vendor and version, so a CDN keyed on it
 * stores a copy per variant of the same bytes, and some shared caches decline to store a `Vary` they consider
 * high-cardinality at all. This one has exactly two states.
 */
const HEADER_RSC = 'rsc';
const HEADER_RSC_VALUE = '1';

/**
 * The four shapes an incoming render request can take, as a discriminated union so that illegal
 * combinations — an action id on a GET — are unrepresentable.
 *
 * - `document` — a normal navigation; respond with a full SSR HTML document.
 * - `rsc` — a soft-navigation flight fetch (`RSC: 1`).
 * - `form-action` — a progressive-enhancement `<form>` POST (no JavaScript).
 * - `rsc-action` — a client-initiated server-action call carrying an action id.
 */
export type RenderRequest = { kind: 'document' } | { kind: 'rsc' } | { kind: 'form-action' } | { kind: 'rsc-action'; actionId: string };

/**
 * Builds the `Request` the client sends to ask a page for its flight payload, optionally carrying a server
 * action.
 *
 * `signal` is for a navigation, which a later one supersedes — an action is never abandoned that way, so its
 * caller passes none.
 */
export function createRscRequest(urlString: string, action?: { id: string; body: BodyInit }, signal?: AbortSignal): Request {
  const url = new URL(urlString, location.origin);
  const headers = new Headers({ [HEADER_RSC]: HEADER_RSC_VALUE });
  if (action) headers.set(HEADER_ACTION_ID, action.id);
  return new Request(url, {
    method: action ? 'POST' : 'GET',
    headers,
    body: action?.body,
    signal,
  });
}

/**
 * The two content types React writes a form action as, and so the two a POST must carry to be *decoded* as
 * one.
 *
 * Deliberately narrower than the set {@link isBrowserFormPost} refuses on. `decodeAction` reaches the body
 * through `request.formData()`, which throws on a `text/plain` one — so classifying that enctype as a
 * `form-action` would turn every same-origin `text/plain` POST into a 400 where the page used to render.
 * What the framework decodes and what it refuses are two different questions.
 */
const FORM_CONTENT_TYPES = /^(?:multipart\/form-data|application\/x-www-form-urlencoded)/i;

/** The third `enctype` a browser `<form>` can send, which React never writes and this never decodes. */
const PLAIN_TEXT_ENCTYPE = /^text\/plain/i;

/**
 * Whether a POST arrived in a shape a browser `<form>` could have produced: one of the three `enctype`
 * values, and no header of its own to need a preflight for.
 *
 * The framework's cross-site refusal runs on this rather than on the {@link RenderRequest} classification,
 * because what makes a form post forgeable from another site is its shape and not what happens to be in the
 * body. Keyed the other way, `text/plain` — the one enctype React never writes — was classified `document`
 * and never reached the refusal, while the README promised that a page route refuses *every* cross-site form
 * post. No action could run through it, since `decodeAction` is only called for the two above; what it cost
 * was a forced authenticated page render, and a claim about the boundary that was not true as written.
 *
 * `x-rsc-action` excludes the client-initiated shape, which needs no check of its own: that header is not
 * CORS-safelisted, so a cross-origin caller needs a preflight the framework never answers.
 */
export function isBrowserFormPost(request: Request): boolean {
  if (request.method !== 'POST' || request.headers.has(HEADER_ACTION_ID)) return false;
  const contentType = request.headers.get('content-type') ?? '';
  return FORM_CONTENT_TYPES.test(contentType) || PLAIN_TEXT_ENCTYPE.test(contentType);
}

export function parseRenderRequest(request: Request): RenderRequest {
  if (request.method === 'POST') {
    const actionId = request.headers.get(HEADER_ACTION_ID);
    if (actionId) return { kind: 'rsc-action', actionId };
    if (FORM_CONTENT_TYPES.test(request.headers.get('content-type') ?? '')) return { kind: 'form-action' };
    return { kind: 'document' };
  }
  return { kind: asksForRsc(request) ? 'rsc' : 'document' };
}

/** Whether the client asked for a flight payload. For GET paths that only need the boolean, without parsing. */
export function asksForRsc(request: Request): boolean {
  return request.headers.get(HEADER_RSC) === HEADER_RSC_VALUE;
}

/** The header a response has to `Vary` on, since one page URL answers as either representation. */
export const RSC_VARY_HEADER = 'RSC';

/** True when the response should be a flight payload rather than an HTML document. */
export function wantsRsc(renderRequest: RenderRequest): boolean {
  return renderRequest.kind === 'rsc' || renderRequest.kind === 'rsc-action';
}

/**
 * {@link wantsRsc} straight off the request, for the error and control-signal paths — reached from Hono's
 * `onError` / `notFound`, so they have no parsed {@link RenderRequest} to hand.
 */
export function requestWantsRsc(request: Request): boolean {
  return wantsRsc(parseRenderRequest(request));
}

/** True when the request carries a server action to run before rendering. */
export function isActionRequest(renderRequest: RenderRequest): renderRequest is Extract<RenderRequest, { kind: 'form-action' | 'rsc-action' }> {
  return renderRequest.kind === 'form-action' || renderRequest.kind === 'rsc-action';
}
