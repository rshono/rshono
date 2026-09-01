// `__RSHONO_CONFIG__` is a global const, and an `import` cannot bring one into scope — a path reference is
// the only way to reach it, which is the whole reason that file is separate. See its header.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../types/rshono-config.d.ts" />
/**
 * The request context: {@link getRequestContext} and the {@link RequestContext} it returns, the
 * {@link redirect} / {@link notFound} control-flow helpers, and the {@link onServerError} reporting
 * funnel — plus the `@internal` plumbing that binds a request to the async context.
 *
 * The public half is re-exported by `runtime/server.ts`, which is what `@rshono/core/server` resolves
 * to; an app imports that.
 */

import type { Context, Env } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import { AsyncLocalStorage } from 'node:async_hooks';
import { NotFoundSignal, RedirectSignal } from './control.js';

/**
 * HTTP status codes accepted by {@link redirect}.
 *
 * - `301` Moved Permanently, `308` Permanent Redirect — cacheable, permanent.
 * - `302` Found, `307` Temporary Redirect — temporary.
 * - `303` See Other — the default; forces a `GET` on the target, which is what you almost always want
 *   after a form action (post/redirect/get).
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status#redirection_messages | MDN — redirection status codes}
 */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

const contextStorage = new AsyncLocalStorage<Context>();

/** One {@link RequestContext} per Hono {@link Context}, so repeated `getRequestContext()` calls share its lazy getters. */
const wrappers = new WeakMap<Context, RequestContext>();

// Keyed on the Hono context rather than held as a field, so marking a request never forces the lazily
// built `RequestContext` wrapper into existence.
const rendering = new WeakSet<Context>();

/**
 * Marks the request as having entered its page render, which is what makes
 * {@link RequestContext.setHeader} and `ctx.cookies.set()` start throwing.
 *
 * @internal
 */
export function beginPageRender(c: Context): void {
  rendering.add(c);
}

/** The shared refusal for a response write that arrived too late — the message names where it belongs instead. */
function tooLateToWrite(call: string): never {
  throw new Error(
    `[rshono] ${call} was called while rendering a page, which is too late to affect the response. ` +
      'A page streams, so its response head is already committed by the time the component runs — the ' +
      'write would land on a full page load and be silently dropped on a soft navigation. Do it from a ' +
      "'use server' action instead; or, in middleware and { type: 'endpoint' } routes — which are handed " +
      "Hono's `c` directly and run outside the request context — with `c.header(…)` / `setCookie(c, …)`.",
  );
}

/** The shared refusal for a Hono `Context` member a page has no way to use. See the stubs on {@link RequestContext}. */
function notOnContext(call: string, instead: string): never {
  throw new Error(
    `[rshono] ctx.${call} does not exist. A page returns JSX and the framework builds the response from it, ` +
      `so Hono's response builders have nothing to return to. ${instead}`,
  );
}

// Snapshotted rather than spread per request: enumerating `process.env` crosses into the host
// environment (~20µs). Lazily, because `loadEnvFiles()` runs after this module is imported — so a
// mutation after the first `ctx.env` read is not picked up.
let envSnapshot: Record<string, string | undefined> | undefined;

function processEnv(): Record<string, string | undefined> {
  return (envSnapshot ??= typeof process !== 'undefined' && process.env ? { ...process.env } : {});
}

// Set by `build.ts` before it imports the app bundle, which inlines its own copy of this module — so
// `process.env` is what crosses that boundary rather than a module-level flag.
const prerendering = typeof process !== 'undefined' && !!process.env?.RSHONO_PRERENDER;

/**
 * Runs `fn` with `c` bound as the ambient request context, so {@link getRequestContext} resolves to it
 * anywhere in the call tree.
 *
 * @internal
 */
export function runWithContext<T>(c: Context, fn: () => T): T {
  return contextStorage.run(c, fn);
}

/**
 * The matched route params, or an empty object when there is no active match.
 *
 * @internal
 */
export function readParams(c: Context): Record<string, string> {
  try {
    return c.req.param();
  } catch {
    return {};
  }
}

/** A proxy chain appends to these headers, so the client-facing value is the first entry. */
function firstForwardedValue(header: string | undefined): string | undefined {
  const first = header?.split(',')[0]?.trim();
  return first || undefined;
}

// Read through `typeof`: DefinePlugin inlines this into the server bundle, but the module is also the
// public `@rshono/core/server` entry, which tooling can load without one. Absent means don't trust.
const trustProxy = typeof __RSHONO_CONFIG__ !== 'undefined' && __RSHONO_CONFIG__.trustProxy;

// Read the same way, for the same reason. Absent means the platform passes no bindings — see the getter.
const envBindings = typeof __RSHONO_CONFIG__ !== 'undefined' && __RSHONO_CONFIG__.envBindings;

/**
 * The browser-facing {@link URL} for a request, resolved from Hono's {@link Context} — a fresh
 * instance per call.
 *
 * `c.req.url` is the internal address the server was reached on, which is wrong behind a proxy;
 * `X-Forwarded-Host` / `-Proto` correct it, but only when `trustProxy` is enabled in
 * `rshono.config.ts` — they are client-supplied, so trusting them unconditionally would let anyone
 * dictate the origin of every absolute URL the app builds.
 *
 * This is the form for **middleware**, which is handed `c` and runs outside the request context — and
 * so the way to give Hono's own middleware the origin the browser actually used. In a server component
 * or action, prefer {@link RequestContext.url}, the same value cached per request.
 *
 * @param c - The Hono {@link Context} for the request.
 * @returns The browser-facing URL — proxy-corrected under `trustProxy`, `c.req.url` otherwise.
 *
 * @example
 * ```ts
 * // src/server.ts — a CSRF check that still works behind a proxy that rewrites Host
 * import { publicUrl } from '@rshono/core/server';
 * import { csrf } from 'hono/csrf';
 *
 * server.use(csrf({ origin: (origin, c) => origin === publicUrl(c).origin }));
 * ```
 *
 * @see {@link https://www.rshono.com/docs/configuration#proxy-headers | Docs — proxy headers}
 */
export function publicUrl(c: Context): URL {
  const url = new URL(c.req.url);
  if (!trustProxy) return url;

  const forwardedHost = firstForwardedValue(c.req.header('x-forwarded-host'));
  // Parsed, not assigned to `url.host`: that setter keeps the existing port when the new value has none.
  const forwarded = forwardedHost ? URL.parse(`http://${forwardedHost}`) : null;
  if (forwarded) {
    url.hostname = forwarded.hostname;
    url.port = forwarded.port;
  }

  // Only the two schemes a browser could have requested; anything else leaves the scheme alone.
  const forwardedProto = firstForwardedValue(c.req.header('x-forwarded-proto'));
  if (forwardedProto === 'http' || forwardedProto === 'https') url.protocol = forwardedProto;

  return url;
}

/**
 * The environment available to a request: Workers `Bindings` merged with process env vars. Values not
 * declared in `Bindings` are typed as `string | undefined`. See {@link RequestContext.env}.
 *
 * @see {@link https://hono.dev/docs/getting-started/cloudflare-workers#bindings | Hono — bindings}
 */
export type EnvVars<E extends Env> = E['Bindings'] & Record<string, string | undefined>;

/**
 * Read-mostly wrapper around Hono's {@link Context}, for server components and server actions.
 *
 * Obtain one with {@link getRequestContext}, or take it off a page's `ctx` prop — the same object.
 * Never construct it yourself. One instance is reused for the whole request, so its lazy getters
 * ({@link RequestContext.url}, {@link RequestContext.env}) are computed at most once.
 *
 * The eight members that only throw — `redirect`, `notFound`, `json`, `text`, `html`, `body`, `status`,
 * `header` — are **permanent, and exist to throw**. Every one of them is a silent no-op when reached through
 * {@link RequestContext.hono} from a page, so a stub that names the thing that does work is the difference
 * between a message and a page that renders while quietly ignoring half of what it was asked for. They carry
 * `@deprecated` for the strike-through an editor draws with it, not because they are on the way out: nothing
 * will un-deprecate or remove them, and dropping them would leave `ctx.redirect('/x')` as
 * "property does not exist", which says what is wrong and not what to do.
 *
 * @typeParam E - The Hono {@link Env} describing this app's `Bindings` and `Variables`, so
 *   {@link RequestContext.var} and {@link RequestContext.env} stay typed.
 *
 * @example
 * ```tsx
 * import { getRequestContext } from '@rshono/core/server';
 *
 * export default async function Whoami() {
 *   const ctx = getRequestContext();
 *   const session = ctx.cookies.get('session');
 *   return <p>{ctx.url.pathname} — {session ?? 'anonymous'}</p>;
 * }
 * ```
 *
 * @see {@link https://www.rshono.com/docs/api#rshonocoreserver | Docs — `@rshono/core/server`}
 * @see {@link https://hono.dev/docs/api/context | Hono — Context}, reachable in full via {@link RequestContext.hono}
 */
export class RequestContext<E extends Env = Env> {
  #raw: Context<E>;
  #url?: URL;
  #env?: EnvVars<E>;
  #params?: Record<string, string>;

  /**
   * One instance is created per request and handed out by {@link getRequestContext} or the `ctx` page
   * prop. Application code never calls this.
   *
   * @internal
   */
  constructor(c: Context<E>) {
    this.#raw = c;
  }

  /**
   * The underlying Hono {@link Context} — the escape hatch for what this wrapper does not expose, such
   * as `executionCtx.waitUntil()` on Workers.
   *
   * Its response builders (`redirect`, `json`, `body`, `status`, …) still do nothing from inside a
   * page: reaching them through here bypasses the errors the stubs on this class throw, it does not
   * make them work.
   *
   * @example
   * ```ts
   * getRequestContext().hono.executionCtx.waitUntil(logAsync()); // Workers
   * ```
   *
   * @see {@link https://hono.dev/docs/api/context | Hono — Context}
   */
  // Every member here is a getter or method so that none is *own enumerable*: React's "you cannot pass
  // this to a client component" diagnostic walks `Object.keys` recursively with no cycle guard, and the
  // Hono context graph reaches the socket through `req.raw`. `cookies` is the one own property, and it
  // is a shallow object of four functions.
  get hono(): Context<E> {
    return this.#raw;
  }

  /**
   * The parsed request — method, headers, path params, query and the body readers. Hono's
   * {@link Context.req}, unwrapped, so `ctx.req.header('authorization')` rather than
   * `ctx.hono.req.header(…)`.
   *
   * Reads only; setting a *response* header is {@link RequestContext.setHeader}, deliberately spelled
   * differently.
   *
   * @example
   * ```ts
   * const ctx = getRequestContext();
   * ctx.req.method;                     // 'GET'
   * ctx.req.header('authorization');    // string | undefined
   * ctx.req.query('tab');               // string | undefined
   * ```
   *
   * @see {@link https://hono.dev/docs/api/request | Hono — HonoRequest}
   */
  get req(): Context<E>['req'] {
    return this.#raw.req;
  }

  /**
   * Matched route params for this request, e.g. `{ id: '42' }` for `/profile/:id`. Empty when no route
   * matched.
   *
   * A page is handed the same record as its `params` prop, typed key-by-key from its route path, and
   * that is the better read where it exists. This is for everywhere else — a nested server component,
   * or a `'use server'` action.
   */
  get params(): Record<string, string> {
    return (this.#params ??= readParams(this.#raw as Context));
  }

  /**
   * The browser-facing request URL. Parsed once and cached, so every read within a request returns the
   * same instance — treat it as read-only.
   *
   * `X-Forwarded-Host` / `-Proto` are honoured only when `trustProxy` is enabled in
   * `rshono.config.ts`, since any client can send them.
   *
   * @example `const tab = getRequestContext().url.searchParams.get('tab');`
   *
   * @see {@link https://www.rshono.com/docs/configuration#proxy-headers | Docs — proxy headers}
   */
  get url(): URL {
    return (this.#url ??= publicUrl(this.#raw as Context));
  }

  /**
   * Typed variables set by middleware via `c.set('user', …)`, read here as `ctx.var.user`. Type them by
   * parameterising this class's {@link Env}.
   *
   * @example
   * ```ts
   * type AppEnv = { Variables: { user: { id: string } } };
   * const { user } = getRequestContext<AppEnv>().var; // typed, set by your middleware
   * ```
   *
   * @see {@link https://hono.dev/docs/api/context#var | Hono — c.var}
   * @see {@link https://www.rshono.com/docs/hono#typing-the-context | Docs — typing the context}
   */
  get var(): Readonly<E['Variables']> {
    return this.#raw.var;
  }

  /**
   * Environment for the request: process env vars, merged on a bindings platform with the bindings, which
   * win on conflict. Computed once and cached.
   *
   * Bindings are merged **only where the platform supplies them** — `deploy: 'cloudflare'`, today. Hono's
   * `c.env` is whatever the host passed as the second argument to `app.fetch`, and off Workers that is the
   * adapter's own private state: `{ incoming, outgoing }` on Node and Vercel, the entire invocation —
   * headers, cookies, `authorization` — on Lambda. Merging it would make `ctx.env` uncloneable on one and
   * a disclosure vector on the other, both behind names this type declares `string | undefined`. Reach for
   * {@link RequestContext.hono}`.env` if you really do want the adapter's argument.
   *
   * @example `const key = getRequestContext().env.STRIPE_SECRET_KEY;`
   *
   * @see {@link https://hono.dev/docs/api/context#env | Hono — c.env}
   * @see {@link https://www.rshono.com/docs/configuration#environment-and-secrets | Docs — environment and secrets}
   */
  get env(): EnvVars<E> {
    if (this.#env) return this.#env;
    const bindings = envBindings ? (this.#raw.env as Record<string, unknown> | undefined) : undefined;
    return (this.#env = (bindings ? { ...processEnv(), ...bindings } : processEnv()) as EnvVars<E>);
  }

  /**
   * Read and write request/response cookies.
   *
   * @example
   * ```ts
   * const ctx = getRequestContext();
   * ctx.cookies.get('session');                       // string | undefined
   * ctx.cookies.set('session', id, { httpOnly: true, sameSite: 'Lax', path: '/' });
   * ctx.cookies.delete('session', { path: '/' });
   * ```
   *
   * @see {@link https://hono.dev/docs/helpers/cookie | Hono — cookie helper}, which this wraps
   */
  cookies = {
    /** Reads a single cookie by name, or `undefined` if absent. Safe anywhere, a page included. */
    get: (name: string): string | undefined => getCookie(this.#raw, name),
    /** Reads every cookie as a `{ name: value }` record. Safe anywhere, a page included. */
    all: (): Record<string, string> => getCookie(this.#raw),
    /**
     * Sets a cookie on the response. See Hono's {@link CookieOptions} for `path`, `httpOnly`, `maxAge`
     * and the rest.
     *
     * **Throws inside a page render** — a `Set-Cookie` is a special case of
     * {@link RequestContext.setHeader}. Set cookies from a `'use server'` action, or with Hono's
     * `setCookie(c, …)` in middleware and endpoint routes.
     *
     * @throws If called while a page is rendering, where it could not reach the browser reliably.
     *
     * @see {@link https://hono.dev/docs/helpers/cookie#options | Hono — cookie options}
     */
    set: (name: string, value: string, options?: CookieOptions): void => {
      this.#assertWritable('ctx.cookies.set()');
      setCookie(this.#raw, name, value, options);
    },
    /**
     * Clears a cookie. Pass the same `path`/`domain` it was set with so the browser matches it.
     * Throws inside a page render, exactly as `set` does.
     *
     * @throws If called while a page is rendering.
     */
    delete: (name: string, options?: CookieOptions): void => {
      this.#assertWritable('ctx.cookies.delete()');
      deleteCookie(this.#raw, name, options);
    },
  };

  #assertWritable(call: string): void {
    if (rendering.has(this.#raw as Context)) tooLateToWrite(call);
  }

  /**
   * Sets a header on the response — from a `'use server'` action, which is the one place a request
   * context exists *and* the response is still open.
   *
   * From inside a page it throws: a page streams, so its response head is already committed by then,
   * and the write would land on a full page load but vanish on a soft navigation.
   *
   * Middleware and `{ type: 'endpoint' }` routes are handed Hono's `c` directly and use `c.header(…)`.
   * That is also where a header belonging to the *page* goes — `Cache-Control`, `X-Robots-Tag` — since
   * middleware runs before the render.
   *
   * @param name - Header name, case-insensitive.
   * @param value - Header value.
   * @param options - `{ append: true }` to add another value rather than replace.
   * @throws If called while a page is rendering, where it could not reach the browser reliably.
   *
   * @example
   * ```ts
   * 'use server';
   * export async function logout() {
   *   const ctx = getRequestContext();
   *   ctx.cookies.delete('session', { path: '/' });
   *   ctx.setHeader('clear-site-data', '"cache", "storage"');
   *   redirect('/');
   * }
   * ```
   */
  setHeader(name: string, value: string, options?: { append?: boolean }): void {
    this.#assertWritable('ctx.setHeader()');
    this.#raw.header(name, value, options);
  }

  // Hono's response builders, restated as errors naming what to use instead — through `ctx.hono` every
  // one of them is a silent no-op from a page. Permanent, deliberately: see the class doc. `@deprecated`
  // strikes them through in autocomplete; the unread `..._args` is so `ctx.redirect('/x')` reaches the
  // thrown message rather than an arity error.

  /** @deprecated Not available on a page's context — use `redirect()` from `@rshono/core/server`. */
  redirect(..._args: unknown[]): never {
    return notOnContext(
      'redirect(location, status?)',
      "Use `redirect()` from '@rshono/core/server', which throws a signal the framework turns into a real redirect.",
    );
  }

  /** @deprecated Not available on a page's context — use `notFound()` from `@rshono/core/server`. */
  notFound(..._args: unknown[]): never {
    return notOnContext('notFound()', "Use `notFound()` from '@rshono/core/server', which aborts the render and shows the app's not-found page.");
  }

  /** @deprecated A page renders JSX. For a JSON response, use an `{ type: 'endpoint' }` route. */
  json(..._args: unknown[]): never {
    return notOnContext('json(object)', "For a JSON response use an { type: 'endpoint' } route; to read the request body use `ctx.req.json()`.");
  }

  /** @deprecated A page renders JSX. For a text response, use an `{ type: 'endpoint' }` route. */
  text(..._args: unknown[]): never {
    return notOnContext('text(string)', "For a text response use an { type: 'endpoint' } route; to read the request body use `ctx.req.text()`.");
  }

  /** @deprecated A page renders JSX, which the framework turns into HTML for you. */
  html(..._args: unknown[]): never {
    return notOnContext('html(string)', "A page's JSX is already its HTML; for a hand-built HTML response use an { type: 'endpoint' } route.");
  }

  /** @deprecated Not available on a page's context. To read the request body, use `ctx.req`. */
  body(..._args: unknown[]): never {
    return notOnContext(
      'body(data, …)',
      "To read the *request* body use `ctx.req.json()` / `ctx.req.text()` / `ctx.req.formData()`; to build a response, use an { type: 'endpoint' } route.",
    );
  }

  /** @deprecated A page's status is set by the framework — use `notFound()`, or an endpoint route. */
  status(..._args: unknown[]): never {
    return notOnContext(
      'status(code)',
      "A page's status is the framework's: 200, 404 via `notFound()`, 500 when it throws. For any other code use an { type: 'endpoint' } route.",
    );
  }

  /** @deprecated Renamed — use `ctx.setHeader(name, value)`, which is valid from a `'use server'` action. */
  header(..._args: unknown[]): never {
    return notOnContext(
      'header(name, value)',
      "Use `ctx.setHeader(name, value)` from a 'use server' action, or `c.header(…)` in middleware — a page renders too late to set one.",
    );
  }
}

/**
 * The {@link RequestContext} for the current request — URL, cookies, params, env and middleware
 * variables — read from a server component or a server action. Memoised per request, so repeated calls
 * return the same instance.
 *
 * A page is handed that same object as its `ctx` prop, so this import is for everywhere else: a nested
 * server component, or a `'use server'` action module.
 *
 * @typeParam E - The app's Hono {@link Env}, to type {@link RequestContext.var} and {@link RequestContext.env}.
 * @throws If called at module load, where there is no ambient context to resolve.
 * @throws If called while prerendering a `render: 'static'` route, which has no
 *   per-request context at build time — mark the route `render: 'dynamic'` instead.
 *
 * @example
 * ```ts
 * 'use server';
 * import { getRequestContext, redirect } from '@rshono/core/server';
 *
 * export async function login(form: FormData) {
 *   getRequestContext().cookies.set('session', String(form.get('email')), { httpOnly: true });
 *   redirect('/dashboard');
 * }
 * ```
 *
 * @see {@link https://www.rshono.com/docs/api#rshonocoreserver | Docs — `@rshono/core/server`}
 */
export function getRequestContext<E extends Env = Env>(): RequestContext<E> {
  if (prerendering) {
    throw new Error(
      "[rshono] getRequestContext() was called while prerendering a `render: 'static'` route. A static page " +
        'is rendered once at build time, so it has no per-request context to read (URL, cookies, ' +
        "headers, env). Change this route to `render: 'dynamic'` so it renders per request, or remove " +
        'the getRequestContext() call.',
    );
  }
  const c = contextStorage.getStore();
  if (!c) {
    throw new Error(
      '[rshono] getRequestContext() was called outside a request. It only works inside a server component or a server action, not at module load.',
    );
  }
  let ctx = wrappers.get(c);
  if (!ctx) {
    ctx = new RequestContext(c);
    wrappers.set(c, ctx);
  }
  return ctx as unknown as RequestContext<E>;
}

/**
 * Redirects the request to `location`, by throwing a control signal the framework turns into an HTTP
 * redirect.
 *
 * Because it throws it never returns, so TypeScript narrows away everything after the call and there
 * is nothing to `return`. Don't wrap it in a `try/catch` that swallows the signal.
 *
 * @param location - Absolute path or URL to redirect to, e.g. `/dashboard`.
 * @param status - Redirect {@link RedirectStatus}; defaults to `303` (See Other), which is what makes
 *   the browser follow up with a `GET` after a form action.
 *
 * @example
 * ```ts
 * const session = getRequestContext().cookies.get('session');
 * if (!session) redirect('/login');
 * // session is defined below this line
 * ```
 */
export function redirect(location: string, status: RedirectStatus = 303): never {
  throw new RedirectSignal(location, status);
}

/**
 * Aborts the current render with a 404, rendering the app's `notFound` page.
 *
 * Like {@link redirect} it throws a control signal and never returns, so TypeScript narrows away
 * everything after the call. Don't catch-and-swallow it.
 *
 * @example
 * ```tsx
 * export default async function Page({ params }: PageProps<'/users/:id'>) {
 *   const user = await db.user.find(params.id);
 *   if (!user) notFound();
 *   return <Profile user={user} />; // user is non-null here
 * }
 * ```
 */
export function notFound(): never {
  throw new NotFoundSignal();
}

/**
 * Which stage of a request produced an error handed to a {@link ServerErrorHandler}.
 *
 * - `action` — a `'use server'` function threw. React sends the client an opaque marker with no
 *   message in production, so this is the only place the real error is visible.
 * - `render` — a server component threw while the flight payload was being produced.
 * - `ssr` — SSR failed before the HTML shell could be sent, so the `error` page was unreachable too.
 * - `request` — anything else that reached the top-level handler, a thrown endpoint route included.
 */
export type ServerErrorSource = 'action' | 'render' | 'ssr' | 'request';

/**
 * What an {@link ServerErrorHandler} is told about an error, beyond the error itself.
 *
 * @typeParam E - The app's Hono {@link Env}, to type {@link ServerErrorContext.hono}'s `var` and `env`.
 */
export interface ServerErrorContext<E extends Env = Env> {
  /** The stage that produced it — see {@link ServerErrorSource}. */
  source: ServerErrorSource;
  /** The request being served, for the URL, method and headers. */
  request: Request;
  /**
   * The Hono {@link Context} for this request — `hono.var` for whatever middleware put there, such as a
   * request id to correlate the report on, and `hono.env` for a platform that passes bindings.
   *
   * Handed over rather than left to {@link getRequestContext}, which a handler cannot reach: an error with
   * `source: 'request'` is reported from the top-level handler, which runs outside the ambient context.
   */
  hono: Context<E>;
  /**
   * Holds the invocation open until `promise` settles, where the platform has something to ask.
   *
   * Reporting is what this hook exists for, and on a serverless platform a report started here is cut off
   * the moment the response ends unless something keeps the invocation alive. On Cloudflare Workers that is
   * `executionCtx.waitUntil`, which this calls. On the `node` and `vercel` targets there is nothing to hold
   * open — the process outlives the response — so it is a no-op and the report finishes on its own. On
   * `aws-lambda` it is a no-op as well, because `hono/aws-lambda`'s streaming handler exposes no execution
   * context to ask; a slow report there is best-effort, so prefer a tracker that batches over one that
   * round-trips per error.
   *
   * A rejection is logged rather than propagated: reporting can never fail a request.
   */
  waitUntil: (promise: Promise<unknown>) => void;
}

/** Handler registered with {@link onServerError}. Called for the side effect; its return value is ignored. */
export type ServerErrorHandler<E extends Env = Env> = (error: unknown, context: ServerErrorContext<E>) => void;

let errorHandler: ServerErrorHandler | undefined;

/**
 * The platform's "keep this invocation alive" hook, or a no-op where there is none.
 *
 * `c.executionCtx` *throws* rather than answering `undefined` where a platform has no execution context, so
 * a handler that reached for it itself would have its report swallowed by the guard in
 * {@link reportServerError} — on exactly the platforms where nothing needed holding open.
 */
function keepAlive(c: Context, promise: Promise<unknown>): void {
  // Caught here rather than left to the platform: under `--unhandled-rejections=strict` a rejected report
  // would end the process, and a failed report must never be worse than no report.
  const settled = Promise.resolve(promise).catch((error) => {
    console.error('[rshono] a promise passed to the onServerError waitUntil rejected:', error);
  });
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // No execution context: nothing here cuts the work off, so there is nothing to hold open.
  }
}

/**
 * Errors already forwarded, so one fault is reported once however many stages it crosses.
 *
 * A thrown server action is reported where it is known to be an action and then re-thrown, which lands it in
 * the top-level handler as well — and a funnel that counts the same error twice, under two different
 * `source`s, is worse than one that only ever names the outer stage.
 */
const alreadyReported = new WeakSet<object>();

/**
 * Registers a handler for every error the framework catches, so they can reach an error tracker
 * (Sentry, Datadog, a log pipeline) instead of only `stderr`.
 *
 * Call it once, at the top level of `src/server.ts`, which is imported as the server starts.
 * Registering again replaces the previous handler. Errors still go to `stderr` either way, and a
 * handler that throws is caught and logged — reporting can never fail a request.
 *
 * @typeParam E - The app's Hono {@link Env}, to type the `hono` context the handler is given.
 *
 * @example
 * ```ts
 * // src/server.ts
 * import * as Sentry from '@sentry/node';
 * import { onServerError } from '@rshono/core/server';
 *
 * onServerError((error, { source, request, hono, waitUntil }) => {
 *   // `waitUntil` so a serverless invocation is not frozen before the report is sent.
 *   waitUntil(
 *     Sentry.captureException(error, {
 *       tags: { source, requestId: hono.var.requestId },
 *       extra: { url: request.url },
 *     }),
 *   );
 * });
 * ```
 *
 * @see {@link https://www.rshono.com/docs/hono#error-reporting | Docs — error reporting}
 */
export function onServerError<E extends Env = Env>(handler: ServerErrorHandler<E>): void {
  errorHandler = handler as unknown as ServerErrorHandler;
}

/**
 * Logs an error and forwards it to the registered {@link ServerErrorHandler} — the single funnel every
 * caught server-side error goes through.
 *
 * @internal
 */
export function reportServerError(error: unknown, info: { source: ServerErrorSource; hono: Context; message: string }): void {
  // The first stage to recognise it wins, since that is the one that knows what it was. A primitive throw
  // cannot be tracked and is reported wherever it is caught.
  if (typeof error === 'object' && error !== null) {
    if (alreadyReported.has(error)) return;
    alreadyReported.add(error);
  }
  console.error(info.message, error);
  if (!errorHandler) return;
  try {
    errorHandler(error, {
      source: info.source,
      request: info.hono.req.raw,
      // The handler was registered for the app's own `Env`, which `onServerError` erased to store it; this
      // puts the context back in the shape it was registered with. Same trade as {@link getRequestContext}.
      hono: info.hono as Context<Env>,
      waitUntil: (promise) => keepAlive(info.hono, promise),
    });
  } catch (handlerError) {
    console.error('[rshono] the onServerError handler threw:', handlerError);
  }
}
