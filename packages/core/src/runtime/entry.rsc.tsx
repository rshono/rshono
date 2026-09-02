import type { Context, Handler } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
// Type-only side effect: augments Hono's `ContextVariableMap` with `secureHeadersNonce`, read in `cspNonce`.
import type {} from 'hono/secure-headers';
import type { ContentfulStatusCode, RedirectStatusCode } from 'hono/utils/http-status';
import type React from 'react';
import type { ReactFormState } from 'react-dom/client';
// Called directly rather than as `<Page {...props} />`: a spread would drop the non-enumerable `ctx`
// prop. See `pageProps`.
import { jsx } from 'react/jsx-runtime';
// The bare specifier, not `/server.node`: the RSC layer's `conditionNames` picks the build for the
// deploy target being compiled for.
import {
  createTemporaryReferenceSet,
  decodeAction,
  decodeFormState,
  decodeReply,
  loadServerAction,
  renderToReadableStream,
  type ServerEntry,
  type TemporaryReferenceSet,
} from 'react-server-dom-rspack/server';
// Aliased at build time to the selected preset's runtime — the one place this file knows where it runs.
import { runtime } from '@rshono/deploy';
// @ts-expect-error — resolved by the '@rshono/routes' alias to the app's routes.ts
import { routes as userRoutes } from '@rshono/routes';
// @ts-expect-error — resolved by the '@rshono/server-app' alias (src/server.ts or the empty fallback)
import * as serverAppModule from '@rshono/server-app';
import { isPageRoute, type ErrorPageInfo, type FallbackPage, type PageComponent, type PageProps, type Route } from '../router.js';
import { appendVary, etagMatches } from '../server/headers.js';
import { PRERENDER_NONCE_HEADER } from '../server/prerendered.js';
import { beginPageRender, getRequestContext, publicUrl, readParams, reportServerError, runWithContext } from './context.js';
import { isControlSignal, RedirectSignal, type ControlSignal } from './control.js';
import { renderHTML } from './entry.ssr.js';
// Type-only, so it is erased — the RSC layer does not take its own instance of the SSR layer's module.
import type { CancellableTransformer } from './flight-inject.js';
import { RouterProvider } from './navigation.js';
import { asksForRsc, isActionRequest, parseRenderRequest, requestWantsRsc, RSC_VARY_HEADER, wantsRsc } from './request.js';
import { assertEndpointModule, assertPageModule, assertRouteModules, validateRoutesModule, validateServerApp } from './validate-entries.js';

const serverApp = validateServerApp(serverAppModule);

// Compiled into the bundle from rshono.config.ts by DefinePlugin; there is no runtime env-var interface.
const { isDev } = __RSHONO_CONFIG__;

/**
 * How long a prerendered page may be reused before revalidating. Also what `public/` files get.
 *
 * Not a config field, deliberately: it is a per-response header, and `rshono.config.ts` is compiled into the
 * bundle — a cache policy you cannot change without a rebuild is the wrong shape. An app that wants a longer
 * `max-age`, or a `stale-while-revalidate`, sets it from middleware **after `await next()`**:
 *
 * ```ts
 * server.use('/docs/*', async (c, next) => {
 *   await next();
 *   c.res.headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
 * });
 * ```
 *
 * After, because the response below is built with `cache-control` in the bag it hands `c.body(...)`, and
 * that replaces a header prepared with `c.header(...)` before the handler ran. The `ETag` is untouched
 * either way, so revalidation still costs a 304 rather than the page.
 */
const SSG_CACHE_CONTROL = 'public, max-age=300';

/**
 * What a page response gets when nothing else set one: without it a shared cache is free to store a logged-in
 * user's page and hand it to someone else. `private, no-cache` forbids that without blocking bfcache, which
 * `no-store` would.
 */
const PAGE_CACHE_CONTROL = 'private, no-cache';

/** The two content types a page can be served as, from the same URL — which is what makes `Vary` non-optional. */
const PAGE_CONTENT_TYPE = /^(?:text\/html|text\/x-component)\b/;

runtime.loadEnv();

// Checked rather than cast: these two modules are the app's, and a mistake in either used to surface as a
// `TypeError` from somewhere else entirely — or, for a duplicated path, as nothing at all.
const routeConfig = validateRoutesModule(userRoutes);
export const routes: readonly Route[] = routeConfig.routes;

/** The result of a server action, as a `Result<T, E>` rather than an `ok` flag over one field. */
export type ActionResult = { ok: true; value: unknown } | { ok: false; error: unknown };

export type RscPayload = {
  root: React.ReactNode;
  returnValue?: ActionResult;
  formState?: ReactFormState;
  redirect?: string;
  notFound?: boolean;
};

/**
 * The result of an action that has already run, for the request whose *render* then failed.
 *
 * The action and the page it answers with are one response: an action returns its value through the payload
 * of the page rendered after it. So when that render throws — a page module that will not load, most
 * plausibly a chunk that went away mid-deploy — `onError` renders the `error` page in its place, and without
 * this the reply carries no `returnValue` at all. The caller of an action that ran, and may well have
 * written something, would be told only that a field was missing.
 *
 * Keyed on the Hono context the way `beginPageRender` keys its own marker, and weakly, so nothing outlives
 * the request it belongs to.
 */
const actionResults = new WeakMap<Context, ActionResult>();

/**
 * Whether this process is `rshono build`'s prerender pass rather than a server answering requests.
 *
 * Set by `build.ts` before it imports the app bundle, which inlines its own copy of the module graph — so
 * `process.env` is what crosses that boundary, the same channel `runtime/context.ts` and the `node` runtime
 * already read. Unforgeable from outside: it is an environment variable of the build process, and a deployed
 * server never has one.
 */
const prerendering = typeof process !== 'undefined' && !!process.env?.RSHONO_PRERENDER;

/**
 * The per-request CSP nonce, if the app asked for one.
 *
 * The framework never mints it: `secureHeaders()` does, when its policy contains the `NONCE`
 * placeholder, and stores it here — so all the framework does is stamp the value into the render. It is
 * readable from a route handler because `secureHeaders` resolves its directives before `next()`.
 *
 * Always `undefined` while prerendering, because a nonce is per request and a prerendered file is not. The
 * pass renders through the app's full middleware, so `secureHeaders()` mints one at *build* time and it was
 * stamped into the document that ships — frozen, and identical in every copy. Which of two bad things that
 * caused depended on the app's policy: under a global nonce policy the file was never served (the request
 * has a nonce of its own, so `mustRenderForNonce` renders it fresh) and the build reported prerendering
 * pages the deployment would never read; under a policy scoped to some other path, `secureHeaders` never ran
 * on this one, nothing forced a re-render, and the stale build-time nonce shipped — picked up by the client
 * as `__webpack_nonce__`. Asking for the document without a nonce is what the flight variant already gets,
 * and it settles both.
 */
function cspNonce(c: Context): string | undefined {
  return prerendering ? undefined : c.get('secureHeadersNonce');
}

/**
 * The build-time half of `mustRenderForNonce`, as a header on the document the prerender pass asked for —
 * {@link PRERENDER_NONCE_HEADER}, where the contract is written down.
 *
 * {@link cspNonce} masks the nonce so none is stamped into a file, but *whether one was minted* is exactly
 * what decides that file's fate: a request for this path will mint its own, so the document is re-rendered
 * per request and the copy on disk is never read. Read here rather than through `cspNonce` for that reason —
 * this is the one place the unmasked value is the answer.
 *
 * Empty on a deployed server: `prerendering` is an environment variable of the build process.
 */
function prerenderNonceHeader(c: Context): Record<string, string> | null {
  return prerendering && c.get('secureHeadersNonce') !== undefined ? { [PRERENDER_NONCE_HEADER]: '1' } : null;
}

/**
 * Whether a `<form action={serverAction}>` post came from another site, and so must not be allowed to run one.
 *
 * This is not CSRF policy — that is `csrf()` from Hono, registered in `src/server.ts`, which runs ahead of
 * every page route and covers far more than this. It is the framework declining to run *its own* action
 * mechanism for a request that mechanism cannot legitimately produce, in the one place the two action shapes
 * are not equally exposed:
 *
 * - A client-initiated action carries `x-rsc-action`, which is not a CORS-simple header. A cross-origin caller
 *   needs a preflight it will not be given, so that shape cannot be forged from a browser at all.
 * - A form post is `multipart/form-data` or `application/x-www-form-urlencoded` with no header of its own —
 *   the content types that need no preflight. It is forgeable, and an app with no `src/server.ts` has nothing
 *   standing in front of it.
 *
 * Both halves are required, because either alone refuses something real:
 *
 * - `Sec-Fetch-Site` is the browser's own statement of provenance, unforgeable by page script, and every
 *   browser that can post a form to a server action sends it. `cross-site` and `same-site` are the two labels
 *   that mean "not from this origin" — `same-site` is what a *sibling subdomain* gets, which is a user-content
 *   host, a stale CNAME or a subdomain takeover, so leaving it to `csrf()` meant an app without one could have
 *   any `'use server'` export driven from next door. An absent header means a non-browser client, which cannot
 *   be a CSRF victim. `same-origin` and `none` settle it on their own, and are what a genuine post carries
 *   however many proxies rewrote `Host` on the way in.
 * - An `Origin` that is the app's own contradicts either label — a browser calls a post from the app's own pages
 *   `same-origin` — so the pair is a shape no browser produces, and refusing it would only catch a proxy or a
 *   test client setting the label by hand while posting from the app itself. Nothing else clears the label:
 *   an `Origin` of `null` (a sandboxed iframe, a `data:` URL, `Referrer-Policy: no-referrer`) and no `Origin`
 *   at all are both refused. A browser attaches one to every non-GET request, so neither is a shape it
 *   produces — but a security predicate that says "not proven foreign" rather than "proven local" fails open
 *   the day something does produce it.
 *
 * `publicUrl(c)` rather than `c.req.url`, so it honours `trustProxy` and compares against the origin the
 * browser actually used — which behind a proxy, `rshono dev`'s included, is not the one the server was reached
 * on.
 *
 * **The cost is wider than "an action you meant to allow".** This runs on content type alone, before the body
 * is read — `parseRenderRequest` calls any form-content-type POST with no `x-rsc-action` header a
 * `form-action`, because deciding otherwise would mean buffering an untrusted body to look for a `$ACTION_*`
 * field. So a **page route cannot accept any cross-site form post at all**, whether or not an action is in
 * it: a SAML ACS callback, OIDC `response_mode=form_post`, and most payment-gateway returns all arrive in
 * exactly this shape and are all refused, `csrf()`'s allowlist included. Refusing before parsing is the right
 * trade — the alternative is reading a body from anyone who asks — but it is a real limitation and the 403
 * and the README both say so. An `{ type: 'endpoint' }` route is the way to accept one: those call the app
 * handler directly and never reach `renderPage`, so they never reach this.
 */
function refusesCrossSiteForm(c: Context): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site !== 'cross-site' && site !== 'same-site') return false;
  return c.req.header('origin') !== publicUrl(c).origin;
}

/** A browser navigation or a crawler, as opposed to a fetch that would rather have plain text. */
function acceptsHtml(c: Context): boolean {
  return c.req.header('accept')?.includes('text/html') ?? false;
}

/**
 * The 404 for an app with no `notFound` page, and for a client that wanted neither HTML nor a flight
 * payload. It carries the `Vary` too: this is one of the answers a page URL gives depending on the `RSC` request header.
 */
function plainNotFound(c: Context): Response {
  // `cache-control` explicitly, because the default above is applied to page *content types* and this is
  // `text/plain`. A 404 is heuristically cacheable under RFC 9111, so without it a shared cache may store
  // this one — while the rendered HTML 404 next to it, the same answer to the same request from a client
  // that asked for HTML, is correctly private.
  return c.text('Not Found', 404, { vary: RSC_VARY_HEADER, 'cache-control': PAGE_CACHE_CONTROL });
}

/** A lazy once-cell: runs `load` at most once, but clears a rejection so a later call can retry. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => {
    if (!promise) {
      const pending = (promise = load());
      pending.catch(() => {
        if (promise === pending) promise = undefined;
      });
    }
    return promise;
  };
}

/**
 * Passes `stream` through untouched, calling `done` however it ends — for the flight-only response
 * path, which has no transform of its own to hang a completion hook off. `done` must be idempotent.
 */
function releaseWhenDone(stream: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush: done,
      cancel: done,
    } as CancellableTransformer<Uint8Array, Uint8Array>),
  );
}

/**
 * A macrotask boundary: `setImmediate` where there is one — the current turn's check phase rather than a
 * timer — and `setTimeout` as the portable fallback, for a runtime without it. `flight-inject.ts` has the
 * same two lines and the same reason; they are not shared because that module belongs to the SSR layer, and
 * importing it here would give the RSC layer its own instance of it.
 */
const deferTask: (run: () => void) => void =
  typeof setImmediate === 'function'
    ? setImmediate
    : (run) => {
        setTimeout(run, 0);
      };

/**
 * Dev-only: says that a control signal arrived too late to be one.
 *
 * The root fix is in app code, so authoring time is where this has to be said, and a docs paragraph is not
 * where anyone reads it. `isDev` is the baked build flag, so a production server pays one boolean check on a
 * path that has already gone wrong — and says nothing.
 */
function warnLateControlSignal(c: Context, signal: ControlSignal): void {
  const isRedirect = signal instanceof RedirectSignal;
  console.warn(
    `[rshono] ${isRedirect ? `redirect(${JSON.stringify(signal.location)})` : 'notFound()'} was called from a boundary that ` +
      `resolved after the page shell had already been sent (${c.req.method} ${c.req.path}), so it cannot become a real ` +
      `${isRedirect ? '3xx' : '404'}: the response is committed as 200 text/html. A browser with JavaScript follows the ` +
      `digest that rides the payload; one without stays on the Suspense fallback, and a crawler indexes the 200.${
        isRedirect
          ? ''
          : ' A JavaScript client asks for the page once more, in case the signal comes early enough that time to be a real 404 — and shows a plain "Page not found" panel when it does not, rather than reloading into the same response forever.'
      }` +
      ' Decide before the render starts streaming — in Hono middleware, or in the page component body above the boundary.',
  );
}

interface ComponentRenderOptions {
  status?: number;
  isRsc: boolean;
  formState?: ReactFormState;
  returnValue?: RscPayload['returnValue'];
  temporaryReferences?: TemporaryReferenceSet;
  /** Passed when the page being rendered is the `error` page, which takes it as an extra prop. */
  errorInfo?: ErrorPageInfo;
  /** Marks the payload as the not-found page, so a soft navigation can tell it apart from the page it asked for. */
  notFound?: boolean;
}

/**
 * Builds the props a page component is called with.
 *
 * `ctx` is *defined* rather than assigned, and both halves are load-bearing:
 *
 * - **A getter**, so nothing is built for the pages that never read it, and a `render: 'static'` page
 *   that does gets {@link getRequestContext}'s prerendering error rather than a bare `undefined`.
 * - **Non-enumerable**, so React's dev-only serialization of a server component's props skips it. That
 *   walks own enumerable properties, and `ctx.hono.env` holds the runtime's bindings — an enumerable
 *   `ctx` would ship every secret to the browser in dev.
 *
 * The cost: the element is created by handing this object to `jsx()` by reference, since a
 * `<Page {...props} />` spread would silently drop `ctx`.
 */
function pageProps(c: Context, errorInfo: ErrorPageInfo | undefined): PageProps & { error?: ErrorPageInfo } {
  const props = { url: publicUrl(c), params: readParams(c), ...(errorInfo ? { error: errorInfo } : null) };
  Object.defineProperty(props, 'ctx', { get: getRequestContext, enumerable: false, configurable: true });
  return props as PageProps & { error?: ErrorPageInfo };
}

async function renderComponent(c: Context, Page: ServerEntry<PageComponent>, opts: ComponentRenderOptions): Promise<Response> {
  // React's renderers must never be handed `c.req.raw.signal`: they add an `abort` listener and only
  // remove it if the abort fires, so on the happy path it stays on a request-lifetime signal and pins the
  // whole rendered tree. The render gets its own controller and the request signal forwards into it —
  // `release` detaches on the normal path. Not `AbortSignal.any()`, whose composite signals Node holds in
  // a process-lifetime set until they abort.
  const requestSignal = c.req.raw.signal;
  const renderAbort = new AbortController();
  const signal = renderAbort.signal;
  const forwardAbort = () => renderAbort.abort(requestSignal.reason);
  if (requestSignal.aborted) renderAbort.abort(requestSignal.reason);
  else requestSignal.addEventListener('abort', forwardAbort, { once: true });
  const release = () => requestSignal.removeEventListener('abort', forwardAbort);

  // Documents only: the nonce goes on the bootstrap scripts and the `<meta>` React hydrates from, and a
  // flight payload has neither — which is what keeps a prerendered one servable under a nonce-based CSP.
  const nonce = opts.isRsc ? undefined : cspNonce(c);
  const props = pageProps(c, opts.errorInfo);
  const root = (
    <>
      {nonce && <meta property="csp-nonce" nonce={nonce} />}
      {Page.entryCssFiles?.map((href) => (
        <link key={href} rel="stylesheet" href={href} precedence="default" />
      ))}
      {/* `href`, not the `URL`: these props cross into a client component, so they have to be serializable. */}
      <RouterProvider href={props.url.href} params={props.params}>
        {jsx(Page, props)}
      </RouterProvider>
    </>
  );

  // `notFound` only when true, so an ordinary page's payload doesn't carry the key.
  const rscPayload: RscPayload = { root, formState: opts.formState, returnValue: opts.returnValue, ...(opts.notFound ? { notFound: true } : null) };

  // The last thing before the render: past here the response head is the framework's, so `ctx.setHeader()`
  // starts throwing — while the action `renderPage` just ran, and the middleware around it, legitimately wrote.
  beginPageRender(c);

  let controlSignal: ControlSignal | undefined;
  /** Set once `renderHTML` has returned, which is where the response head stops being changeable. */
  let shellFlushed = false;
  const rscStream = renderToReadableStream(rscPayload, {
    temporaryReferences: opts.temporaryReferences,
    signal,
    onError(error) {
      if (isControlSignal(error)) {
        controlSignal = error;
        if (shellFlushed) {
          if (isDev) warnLateControlSignal(c, error);
          // Past the shell the status line, the headers and the first bytes are on the wire, so the digest
          // React writes into the payload is the only path left — and everything still rendering is for a
          // page the browser is about to navigate away from. Winding it down stops those boundaries, runs
          // `flight-inject`'s cancel/flush, and fires the `release()` above now rather than whenever the
          // doomed render happens to finish.
          //
          // One macrotask later rather than from inside `onError`, where React is still handling the error
          // that produced the digest — the row carrying it is the only recovery the client has, and an abort
          // that re-entered React there could cut the render off before it is written. Measured to survive
          // either way on react-server-dom-rspack 0.1.0; deferred anyway, because that ordering is an
          // internal the `^19.1.0` peer range does not promise, and the cost is one macrotask on a render
          // that is already doomed. The reason is the signal itself, so every boundary the abort errors
          // carries the digest rather than a bare AbortError the client would paint as a fault.
          if (!signal.aborted) deferTask(() => renderAbort.abort(error));
        }
        return error.digest;
      }
      if (!signal.aborted) reportServerError(error, { source: 'render', hono: c, message: '[rshono] render error:' });
    },
  });

  if (opts.isRsc) {
    return c.body(releaseWhenDone(rscStream, release), (opts.status ?? 200) as ContentfulStatusCode, {
      'content-type': 'text/x-component;charset=utf-8',
    });
  }

  let ssrResult: Awaited<ReturnType<typeof renderHTML>>;
  try {
    ssrResult = await renderHTML(rscStream, {
      bootstrapScripts: Page.entryJsFiles,
      formState: opts.formState,
      signal,
      nonce,
      onDone: release,
      onShellError: (error) => reportServerError(error, { source: 'ssr', hono: c, message: '[rshono] SSR shell error:' }),
      onError: (error) => reportServerError(error, { source: 'ssr', hono: c, message: '[rshono] SSR error:' }),
    });
  } catch (error) {
    release();
    if (controlSignal) throw controlSignal;
    throw error;
  }
  // `renderHTML` returns at *shell ready*, so from here the response is the one that ships. Set before the
  // check below rather than after it, so nothing lands in the window between the two: a signal that arrives
  // in it is handled there *and* schedules an abort, and aborting an aborted controller is a no-op.
  shellFlushed = true;
  if (controlSignal) {
    // The shell resolved, so this response is live: React is being pumped into the payload-injecting
    // transform, and a `redirect()` that surfaced from a boundary settling just before the shell was ready
    // lands here. Nothing will read that stream now — the signal becomes a redirect instead — so it is stopped
    // rather than left to render to completion for a response that was replaced.
    //
    // Both calls, because they stop different halves. `abort` reaches the two renders through the signal they
    // were handed; cancelling the response readable propagates back through the transform to release the teed
    // flight branch it holds a reader on, which `abort` alone does not.
    renderAbort.abort();
    void ssrResult.stream.cancel().catch(() => {
      // Already errored or locked — there is nothing left to release either way.
    });
    release();
    throw controlSignal;
  }
  return c.body(ssrResult.stream, (ssrResult.status ?? opts.status ?? 200) as ContentfulStatusCode, {
    'content-type': 'text/html;charset=utf-8',
    ...prerenderNonceHeader(c),
  });
}

/**
 * The answer to an action request whose body could not be read or decoded — a malformed request, the same
 * class of thing as the unknown-action-id 400 beside it, and answered the same way.
 *
 * Deliberately silent. Action ids are public — they are bare string literals in the client chunks — so
 * anyone can post a valid id with a body that will not decode, and while that reached `reportServerError` it
 * was an unauthenticated way to page whoever owns the error tracker, once per request. Nothing here is the
 * server being wrong, so there is nothing to report; the status is the whole message.
 *
 * The text says no more than that on purpose: which of `text()`, `formData()`, `decodeReply` or
 * `decodeAction` gave up is React's or undici's internal shape, and repeating it back would describe the
 * framework's decoding to a caller who cannot act on it.
 */
function malformedAction(c: Context): Response {
  return c.text('Bad Request: malformed server action request', 400);
}

async function renderPage(c: Context, loadPage: () => Promise<ServerEntry<PageComponent>>): Promise<Response> {
  const request = c.req.raw;
  const renderRequest = parseRenderRequest(request);

  let returnValue: ActionResult | undefined;
  let formState: ReactFormState | undefined;
  let temporaryReferences: TemporaryReferenceSet | undefined;
  let actionStatus: number | undefined;
  if (isActionRequest(renderRequest)) {
    if (renderRequest.kind === 'rsc-action') {
      // Before the body is decoded, so an unknown id costs nothing to reject. `hasOwn` so `__proto__`
      // does not resolve to a manifest entry.
      if (!Object.hasOwn(__rspack_rsc_manifest__.serverManifest, renderRequest.actionId)) {
        return c.text('Bad Request: unknown server action', 400);
      }
      let args: unknown[];
      try {
        const contentType = request.headers.get('content-type');
        const body = contentType?.startsWith('multipart/form-data') ? await request.formData() : await request.text();
        temporaryReferences = createTemporaryReferenceSet();
        args = await decodeReply<unknown[]>(body, { temporaryReferences });
      } catch {
        return malformedAction(c);
      }

      // Outside that guard, deliberately. Everything inside it reads or decodes the *body*, which is the
      // caller's to get wrong; loading the action is not. The id is one `hasOwn` above proved the manifest
      // holds, so no client can steer this — what is left is the bundle being incomplete: a chunk
      // `__webpack_require__` cannot find after a partial deploy, or a module that throws as it evaluates.
      // A 400 there would tell the one caller in that guard who is *not* at fault that they are, and tell
      // the operator who needs paging nothing at all.
      let action: (...actionArgs: unknown[]) => Promise<unknown>;
      try {
        action = loadServerAction(renderRequest.actionId);
      } catch (error) {
        // Attributed to the action rather than left to the top-level handler's `source: 'request'`: the
        // request was fine, the deployment is not. Then re-thrown, so the app's `error` page answers 500 —
        // `reportServerError` de-duplicates, so `onError` reporting it again is a no-op.
        reportServerError(error, { source: 'action', hono: c, message: '[rshono] server action could not be loaded:' });
        throw error;
      }
      try {
        returnValue = { ok: true, value: await action(...args) };
      } catch (error) {
        if (isControlSignal(error)) throw error;
        // In production React sends a thrown action error to the client as an opaque marker, so this is
        // the only place the real one is visible.
        reportServerError(error, { source: 'action', hono: c, message: '[rshono] server action error:' });
        returnValue = { ok: false, error };
        actionStatus = 500;
      }
      // The action is done and its result is the caller's, whatever becomes of the render below. See
      // {@link actionResults}.
      actionResults.set(c, returnValue);
    } else {
      // A `<form action={serverAction}>` post, which is the path that runs before hydration and with
      // JavaScript off. Unlike the client-initiated one it carries no custom header, so it is also the only
      // action shape a browser can be made to send from another site: see `refusesCrossSiteForm`.
      if (refusesCrossSiteForm(c)) {
        // Named for what was actually refused. The check runs before the body is read — it has to, since
        // knowing whether a post carries an action means buffering an untrusted body — so "to a server
        // action" claimed something this code cannot know, and said it to a caller whose post very often
        // has no action in it at all.
        return c.text(
          "Forbidden: cross-site form post to a page route — a page route cannot accept one, because a form post to a page is how a server action is called. Use an { type: 'endpoint' } route.",
          403,
          { vary: RSC_VARY_HEADER },
        );
      }
      let formData: FormData;
      let decodedAction: (() => Promise<unknown>) | null;
      try {
        formData = await request.formData();
        decodedAction = await decodeAction(formData);
      } catch {
        return malformedAction(c);
      }
      if (decodedAction) {
        let result: unknown;
        try {
          result = await decodedAction();
        } catch (error) {
          if (isControlSignal(error)) throw error;
          // Reported here so a no-JS form post is attributed to the action that threw, exactly as the
          // client-initiated path is — the top-level handler would call it a `request`. Then re-thrown,
          // because this path has no client boundary and no `useActionState` to hand the error to, so the
          // app's `error` page is the honest answer. `reportServerError` de-duplicates, so the re-throw
          // reaching `onError` does not report it a second time.
          reportServerError(error, { source: 'action', hono: c, message: '[rshono] server action error:' });
          throw error;
        }
        try {
          formState = (await decodeFormState(result, formData)) ?? undefined;
        } catch (error) {
          // The action has already run, and may well have written something, so this cannot be refused the
          // way an undecodable body *before* it is — the guard above answers 400 precisely because nothing
          // has happened yet. What failed here is rebuilding the `useActionState` key from the body's
          // `$ACTION_REF_` metadata, and a body React wrote always carries it: this is reachable only from a
          // hand-made one, which pairs a `$ACTION_ID_` React took for the call with `$ACTION_REF_`/
          // `$ACTION_KEY` fields it did not write. So the page is rendered with no form state, which is
          // exactly what a form without `useActionState` gets.
          //
          // Silent for the same reason `malformedAction` is: action ids are public, so anyone can post one,
          // and reporting from here would put an unauthenticated caller back in touch with whoever owns the
          // error tracker — for a request that has already had its effects. In dev it is worth a line, since
          // there the likely cause is a React or bundler version whose form fields this does not understand.
          if (isDev) console.warn('[rshono] a form post carried form-state fields that could not be decoded; rendering without them:', error);
        }
      }
    }
  }

  const Page = await loadPage();
  return renderComponent(c, Page, {
    status: actionStatus,
    isRsc: wantsRsc(renderRequest),
    formState,
    returnValue,
    temporaryReferences,
  });
}

function buildApp(): Hono {
  const app = new Hono();

  // A floor, not a policy: an app wanting the full set registers `secureHeaders()` in src/server.ts, and
  // because this is registered first it unwinds last, so the "only if unset" checks stand aside for it.
  // Owned by the framework so that an app with no src/server.ts at all still gets it.
  app.use(async (c, next) => {
    await next();
    const headers = c.res.headers;
    if (!headers.has('x-content-type-options')) headers.set('x-content-type-options', 'nosniff');
    if (!headers.has('referrer-policy')) headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    if (!headers.has('x-frame-options')) headers.set('x-frame-options', 'SAMEORIGIN');

    // React Refresh compiles updates with `eval`, so a dev build cannot run under a production CSP.
    // Widened here so one policy in src/server.ts serves both.
    if (isDev) {
      const csp = headers.get('content-security-policy');
      if (csp?.includes('script-src ')) {
        headers.set('content-security-policy', csp.replace('script-src ', "script-src 'unsafe-eval' "));
      }
    }

    // Page responses only from here down.
    if (!PAGE_CONTENT_TYPE.test(headers.get('content-type') ?? '')) return;
    appendVary(headers, RSC_VARY_HEADER);
    if (!headers.has('cache-control')) headers.set('cache-control', PAGE_CACHE_CONTROL);
  });

  // First, so the app's own middleware (`csrf()`, `bodyLimit()`, auth, logging) wraps everything registered
  // below: the page routes, and the asset handlers too. Assets used to be mounted ahead of this, which left
  // `/_static/*` answered by a terminal handler nothing of the app's ever saw — no `secureHeaders()`, and so
  // no HSTS on exactly the requests a downgrade attack lands on. The flip side is the same one it always had,
  // one path wider: a *terminal* handler in src/server.ts shadows a page at the same path, and unscoped
  // middleware now also runs for `/_static`, which is a reserved prefix an app should not be matching on
  // purpose anyway.
  if (serverApp) {
    app.route('/', serverApp);
  }

  runtime.mountStaticAssets(app);

  const memoizePage = (page: FallbackPage, label: string) => once(async () => assertPageModule(await page.component(), label));
  const loadNotFoundPage = routeConfig.notFound ? memoizePage(routeConfig.notFound, 'the notFound page') : null;

  /** Turns a thrown `redirect()` / `notFound()` into the response it stands for. */
  const respondToControlSignal = async (c: Context, signal: ControlSignal): Promise<Response> => {
    const isRsc = requestWantsRsc(c.req.raw);
    if (signal instanceof RedirectSignal) {
      if (isRsc) {
        // No `signal`: two fields and no component tree, so there is nothing worth aborting.
        return c.body(renderToReadableStream({ root: null, redirect: signal.location } satisfies RscPayload), 200, {
          'content-type': 'text/x-component;charset=utf-8',
        });
      }
      // Both page defaults by hand: `c.redirect` builds a bodiless response with no content type, so the
      // middleware that would apply them skips it on `PAGE_CONTENT_TYPE`. They are not decoration here —
      // `301` and `308` are cacheable with no explicit `Cache-Control` at all, so a session-gated permanent
      // redirect could otherwise be stored by a shared cache and replayed to another visitor, and without
      // `Vary` this document redirect could answer an `RSC: 1` fetch that needs the payload above.
      const redirected = c.redirect(signal.location, signal.status as RedirectStatusCode);
      appendVary(redirected.headers, RSC_VARY_HEADER);
      if (!redirected.headers.has('cache-control')) redirected.headers.set('cache-control', PAGE_CACHE_CONTROL);
      return redirected;
    }
    if (loadNotFoundPage) {
      try {
        return await renderComponent(c, await loadNotFoundPage(), { status: 404, isRsc, notFound: true });
      } catch (error) {
        // The `notFound` page is already the answer to a request that went wrong, so a failure here has
        // nowhere to escalate to: this runs from `onError` as well as from the page handler, and Hono calls
        // `onError` inside its own catch — a throw from there rejects `app.fetch`, which
        // `@hono/node-server` turns into a bodiless 500 with nothing in the log. So it is answered here, the
        // way a failing `error` page is answered below.
        //
        // A `redirect()` from the page is the exception: nothing is committed yet, the branch above cannot
        // fail, and this is what the same page does when `app.notFound` renders it — so it is honoured, and
        // recurses exactly once.
        if (error instanceof RedirectSignal) return respondToControlSignal(c, error);
        reportServerError(error, { source: 'render', hono: c, message: '[rshono] the notFound page failed to render:' });
      }
    }
    return plainNotFound(c);
  };

  for (const route of routes) {
    if (isPageRoute(route)) {
      // Both fixed for the life of the process, so resolved once rather than per request.
      const servesPrerendered = !isDev && route.render === 'static';
      const loadPage = once(async () => assertPageModule(await route.component(), `"${route.path}"`));

      /** Everything the route answers, before a HEAD has its body taken off it. */
      const respond = async (c: Context): Promise<Response> => {
        try {
          // A HEAD takes the GET path, prerendered bytes included: the headers it promises are the ones a
          // GET would send, `etag` and `content-length` among them.
          if (servesPrerendered && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
            const isRsc = asksForRsc(c.req.raw);
            // One fixed set of bytes cannot carry a per-request nonce, so a document has to be rendered
            // where the app's CSP has one. Decided per request, so an app whose policy carries no `NONCE`
            // keeps its prerendered documents. A flight payload never carries a nonce either way.
            const mustRenderForNonce = !isRsc && cspNonce(c) !== undefined;
            if (!mustRenderForNonce) {
              const page = await runtime.readPrerendered(c, isRsc ? 'flight' : 'html');
              // Request-independent by construction, so it is safe to cache publicly; the ETag turns the
              // revalidation that follows into a 304. Answered outside `runWithContext` — no app code runs
              // on this path, so there is no `getRequestContext()` to serve.
              if (page !== null) {
                const headers = {
                  'cache-control': SSG_CACHE_CONTROL,
                  etag: page.etag,
                  vary: RSC_VARY_HEADER,
                  'content-type': isRsc ? 'text/x-component;charset=utf-8' : 'text/html;charset=utf-8',
                };
                if (etagMatches(c.req.header('if-none-match'), page.etag)) return c.body(null, 304, headers);
                return c.body(page.body, 200, { ...headers, 'content-length': page.contentLength });
              }
            }
          }
          return await runWithContext(c, () => renderPage(c, loadPage));
        } catch (error) {
          if (isControlSignal(error)) return runWithContext(c, () => respondToControlSignal(c, error));
          throw error;
        }
      };

      const handler: Handler = async (c) => {
        const response = await respond(c);
        // Hono dispatches a HEAD to the GET route and then rebuilds the response as `new Response(null, res)`,
        // which drops the body without reading it — so for a rendered page nothing ever consumes the stream:
        // `flight-inject`'s `cancel` never runs, and neither does the `release()` that detaches the abort
        // forwarder from the request signal. Cancelling here is what ends the render nobody asked to read.
        if (c.req.method === 'HEAD' && response.body !== null) {
          void response.body.cancel().catch(() => {
            // Already errored or locked, and there is nothing left to release either way.
          });
          return new Response(null, response);
        }
        return response;
      };
      app.on(['GET', 'POST'], route.path, handler);
    } else {
      // Checked on the way out of the thunk rather than at the call site, so `once`'s cache holds a handler
      // that has already been proven to be one — and a rejection clears, so the message repeats per request.
      const loadEndpoint = once(async () => assertEndpointModule(await route.server(), `"${route.path}"`));
      const handler: Handler = async (c, next) => {
        const endpointHandler = await loadEndpoint();
        // Hono's `Handler` leaves its return parameter defaulted to `any`, so this hands back exactly what
        // the app's own handler is declared to return — there is nothing narrower to assert here.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return endpointHandler(c, next);
      };
      // De-duplicated, because `app.on(['GET', 'GET'], …)` registers the path twice. Validation refuses
      // `'all'` inside a list, so a list that reaches here is concrete methods only.
      const methods = [...new Set([route.method ?? 'all'].flat())];
      if (methods.includes('all')) app.all(route.path, handler);
      else {
        app.on(
          methods.map((method) => method.toUpperCase()),
          route.path,
          handler,
        );
      }
    }
  }

  runtime.mountPublicFallback(app);

  app.notFound(async (c) => {
    const isRsc = requestWantsRsc(c.req.raw);
    if (loadNotFoundPage && (isRsc || acceptsHtml(c))) {
      // `notFound: true` here as well as on the signal path: the two produce the same page for the same
      // status, and a payload that says so from one route and not the other is a wire contract with a hole
      // in it. The client reads it to tell "this is the 404 page" from "this is the page you asked for".
      return runWithContext(c, async () => renderComponent(c, await loadNotFoundPage(), { status: 404, isRsc, notFound: true }));
    }
    return plainNotFound(c);
  });

  const loadErrorPage = routeConfig.error ? memoizePage(routeConfig.error, 'the error page') : null;
  app.onError(async (error, c) => {
    if (isControlSignal(error)) return runWithContext(c, () => respondToControlSignal(c, error));
    // Registering an `onError` replaces Hono's default handler, which is what turns an `HTTPException`
    // into the response it carries — without this, `csrf()`'s 403 and `bodyLimit()`'s 413 would both
    // surface as a 500 error page. Rebuilt through `c`, as Hono's default does, so headers middleware
    // already prepared survive.
    if (error instanceof HTTPException) {
      const res = error.getResponse();
      return c.newResponse(res.body, res);
    }
    reportServerError(error, { source: 'request', hono: c, message: '[rshono] request error:' });
    const isRsc = requestWantsRsc(c.req.raw);
    if (loadErrorPage && (isRsc || acceptsHtml(c))) {
      const errorInfo: ErrorPageInfo = isDev
        ? {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }
        : { message: 'Internal Server Error' };
      try {
        return await runWithContext(c, async () =>
          renderComponent(c, await loadErrorPage(), { status: 500, isRsc, errorInfo, returnValue: actionResults.get(c) }),
        );
      } catch (renderError) {
        reportServerError(renderError, { source: 'request', hono: c, message: '[rshono] the error page failed to render:' });
      }
    }
    const detail = isDev ? `\n\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}` : '';
    // Same reason as `plainNotFound`, minus the urgency: a 500 is not heuristically cacheable, so this half
    // is consistency — the framework's own answers should not differ in what they promise about caching.
    return c.text(`Internal Server Error${detail}`, 500, { vary: RSC_VARY_HEADER, 'cache-control': PAGE_CACHE_CONTROL });
  });

  return app;
}

/**
 * Resolves and checks every route's own module — page and endpoint alike, `notFound` and `error` included.
 * Called by `rshono build` once this bundle is imported for the prerender pass, so a route that could never
 * serve a request fails the build rather than answering 500 in production. Exported from here rather than
 * driven from the CLI because the fallback pages are on `routeConfig`, which does not leave this module.
 */
export const checkRouteModules = (): Promise<void> => assertRouteModules(routeConfig);

export const app = buildApp();

/**
 * The app, handed to whatever is hosting it: this binds a port and exports nothing where rshono owns the
 * process, and *is* the export the platform looks for where the host owns it — so one entry serves both.
 *
 * `app` and `routes` stay named exports either way, because `rshono build` imports them to prerender
 * `render: 'static'` routes.
 */
export default runtime.serveApp(app);
