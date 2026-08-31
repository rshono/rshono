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
import { beginPageRender, getRequestContext, publicUrl, readParams, reportServerError, runWithContext } from './context.js';
import { isControlSignal, RedirectSignal, type ControlSignal } from './control.js';
import { renderHTML } from './entry.ssr.js';
// Type-only, so it is erased — the RSC layer does not take its own instance of the SSR layer's module.
import type { CancellableTransformer } from './flight-inject.js';
import { RouterProvider } from './navigation.js';
import { asksForRsc, isActionRequest, parseRenderRequest, requestWantsRsc, RSC_VARY_HEADER, wantsRsc } from './request.js';
import { validateRoutesModule, validateServerApp } from './validate-entries.js';

const serverApp = validateServerApp(serverAppModule);

// Compiled into the bundle from rshono.config.ts by DefinePlugin; there is no runtime env-var interface.
const { isDev } = __RSHONO_CONFIG__;

/** How long a prerendered page may be reused before revalidating. Also what `public/` files get. */
const SSG_CACHE_CONTROL = 'public, max-age=300';

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
 * The per-request CSP nonce, if the app asked for one.
 *
 * The framework never mints it: `secureHeaders()` does, when its policy contains the `NONCE`
 * placeholder, and stores it here — so all the framework does is stamp the value into the render. It is
 * readable from a route handler because `secureHeaders` resolves its directives before `next()`.
 */
function cspNonce(c: Context): string | undefined {
  return c.get('secureHeadersNonce');
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
 *   test client setting the label by hand while posting from the app itself.
 *
 * `publicUrl(c)` rather than `c.req.url`, so it honours `trustProxy` and compares against the origin the
 * browser actually used — which behind a proxy, `rshono dev`'s included, is not the one the server was reached
 * on. The cost is that an app deliberately accepting *form* posts to an action from another origin of its own
 * cannot, `csrf()`'s allowlist included; that is what an `{ type: 'endpoint' }` route is for.
 */
function refusesCrossSiteForm(c: Context): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site !== 'cross-site' && site !== 'same-site') return false;
  const origin = c.req.header('origin');
  return origin !== undefined && origin !== publicUrl(c).origin;
}

async function loadPageModule(load: () => Promise<{ default: PageComponent }>, label: string): Promise<ServerEntry<PageComponent>> {
  const mod = await load();
  const Page = mod.default as ServerEntry<PageComponent> | undefined;
  if (typeof Page !== 'function') {
    throw new Error(`[rshono] The page module for ${label} must default-export a server component.`);
  }
  if (!Page.entryJsFiles) {
    throw new Error(
      `[rshono] The page component for ${label} is missing its client-asset info ('use server-entry'). ` +
        "The directive is added automatically for inline `component: () => import('…')` thunks in routes.ts. " +
        "If this page is wired up another way, put 'use server-entry' on the first line of the page module yourself — " +
        "and make sure the page is a server component (a 'use client' page must be wrapped by a server component instead).",
    );
  }
  return Page;
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
  return c.text('Not Found', 404, { vary: RSC_VARY_HEADER });
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
  const rscStream = renderToReadableStream(rscPayload, {
    temporaryReferences: opts.temporaryReferences,
    signal,
    onError(error) {
      if (isControlSignal(error)) {
        controlSignal = error;
        return error.digest;
      }
      if (!signal.aborted) reportServerError(error, { source: 'render', request: c.req.raw, message: '[rshono] render error:' });
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
      onShellError: (error) => reportServerError(error, { source: 'ssr', request: c.req.raw, message: '[rshono] SSR shell error:' }),
      onError: (error) => reportServerError(error, { source: 'ssr', request: c.req.raw, message: '[rshono] SSR error:' }),
    });
  } catch (error) {
    release();
    if (controlSignal) throw controlSignal;
    throw error;
  }
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
  });
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
      const contentType = request.headers.get('content-type');
      const body = contentType?.startsWith('multipart/form-data') ? await request.formData() : await request.text();
      temporaryReferences = createTemporaryReferenceSet();
      const args = await decodeReply<unknown[]>(body, { temporaryReferences });
      const action = loadServerAction(renderRequest.actionId);
      try {
        returnValue = { ok: true, value: await action(...args) };
      } catch (error) {
        if (isControlSignal(error)) throw error;
        // In production React sends a thrown action error to the client as an opaque marker, so this is
        // the only place the real one is visible.
        reportServerError(error, { source: 'action', request, message: '[rshono] server action error:' });
        returnValue = { ok: false, error };
        actionStatus = 500;
      }
    } else {
      // A `<form action={serverAction}>` post, which is the path that runs before hydration and with
      // JavaScript off. Unlike the client-initiated one it carries no custom header, so it is also the only
      // action shape a browser can be made to send from another site: see `refusesCrossSiteForm`.
      if (refusesCrossSiteForm(c)) {
        return c.text('Forbidden: cross-site form post to a server action', 403, { vary: RSC_VARY_HEADER });
      }
      const formData = await request.formData();
      const decodedAction = await decodeAction(formData, __rspack_rsc_manifest__.serverManifest);
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
          reportServerError(error, { source: 'action', request, message: '[rshono] server action error:' });
          throw error;
        }
        formState = (await decodeFormState(result, formData, __rspack_rsc_manifest__.serverManifest)) ?? undefined;
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
    // Without a default a shared cache is free to store a logged-in user's page and hand it to someone
    // else. `private, no-cache` forbids that without blocking bfcache, which `no-store` would.
    if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-cache');
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

  const memoizePage = (page: FallbackPage, label: string) => once(() => loadPageModule(page.component, label));
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
      return c.redirect(signal.location, signal.status as RedirectStatusCode);
    }
    if (loadNotFoundPage) {
      return renderComponent(c, await loadNotFoundPage(), { status: 404, isRsc, notFound: true });
    }
    return plainNotFound(c);
  };

  for (const route of routes) {
    if (isPageRoute(route)) {
      // Both fixed for the life of the process, so resolved once rather than per request.
      const servesPrerendered = !isDev && route.render === 'static';
      const loadPage = once(() => loadPageModule(route.component, `"${route.path}"`));

      const handler: Handler = async (c) => {
        try {
          if (servesPrerendered && c.req.method === 'GET') {
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
      app.on(['GET', 'POST'], route.path, handler);
    } else {
      const loadEndpoint = once(() => route.server());
      const handler: Handler = async (c, next) => {
        const { handler: endpointHandler } = await loadEndpoint();
        // Hono's `Handler` leaves its return parameter defaulted to `any`, so this hands back exactly what
        // the app's own handler is declared to return — there is nothing narrower to assert here.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return endpointHandler(c, next);
      };
      const method = route.method ?? 'all';
      if (method === 'all') app.all(route.path, handler);
      else app.on(method.toUpperCase(), route.path, handler);
    }
  }

  runtime.mountPublicFallback(app);

  app.notFound(async (c) => {
    const isRsc = requestWantsRsc(c.req.raw);
    if (loadNotFoundPage && (isRsc || acceptsHtml(c))) {
      return runWithContext(c, async () => renderComponent(c, await loadNotFoundPage(), { status: 404, isRsc }));
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
    reportServerError(error, { source: 'request', request: c.req.raw, message: '[rshono] request error:' });
    const isRsc = requestWantsRsc(c.req.raw);
    if (loadErrorPage && (isRsc || acceptsHtml(c))) {
      const errorInfo: ErrorPageInfo = isDev
        ? {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }
        : { message: 'Internal Server Error' };
      try {
        return await runWithContext(c, async () => renderComponent(c, await loadErrorPage(), { status: 500, isRsc, errorInfo }));
      } catch (renderError) {
        reportServerError(renderError, { source: 'request', request: c.req.raw, message: '[rshono] the error page failed to render:' });
      }
    }
    const detail = isDev ? `\n\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}` : '';
    return c.text(`Internal Server Error${detail}`, 500, { vary: RSC_VARY_HEADER });
  });

  return app;
}

export const app = buildApp();

/**
 * The app, handed to whatever is hosting it: this binds a port and exports nothing where rshono owns the
 * process, and *is* the export the platform looks for where the host owns it — so one entry serves both.
 *
 * `app` and `routes` stay named exports either way, because `rshono build` imports them to prerender
 * `render: 'static'` routes.
 */
export default runtime.serveApp(app);
