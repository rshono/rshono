import type { Env, Handler } from 'hono';
import type { ParamKeys, ParamKeyToRecord } from 'hono/types';
import type { ReactNode } from 'react';
// Type-only, so importing `@rshono/core` pulls in none of `context.ts`'s runtime machinery.
import type { RequestContext } from './runtime/context.js';

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/**
 * The `params` record implied by a route path pattern — one required `string` key per `:param`
 * segment, `Record<string, never>` for a path with none. Paths use Hono's syntax, so `:id`,
 * `:id{[0-9]+}` and `*` all work.
 *
 * You rarely name this directly; {@link PageProps} applies it for you.
 *
 * @typeParam P - The literal route path, e.g. `'/users/:id/posts/:postId'`.
 *
 * @example
 * ```ts
 * type P = PathParams<'/users/:id/posts/:postId'>; // { id: string; postId: string }
 * ```
 *
 * @see {@link https://hono.dev/docs/api/routing#path-parameter | Hono — path parameters}
 */
export type PathParams<P extends string> =
  ParamKeys<P> extends never ? Record<string, never> : Simplify<UnionToIntersection<ParamKeyToRecord<ParamKeys<P>>>>;

/**
 * Props every page component receives. Pass the route's path as the type argument to get `params`
 * typed key-by-key; without it `params` falls back to an open `Record<string, string>`.
 *
 * `defineRoutes` checks each page's props against `PageProps<path>`, so a mismatched path literal is
 * a type error at the route definition. `url` and `params` mirror what `useNavigation()` gives a
 * `'use client'` component, so a read moves across the server/client line unchanged.
 *
 * @typeParam Path - The literal path this page is mounted at, e.g. `'/profile/:id'`.
 * @typeParam E - The app's Hono {@link Env}, to type {@link RequestContext.var} and
 *   {@link RequestContext.env} on {@link PageProps.ctx}.
 *
 * @example
 * ```tsx
 * import type { PageProps } from '@rshono/core';
 *
 * export default async function Profile({ params, url }: PageProps<'/profile/:id'>) {
 *   const user = await db.getUser(params.id); // params.id is string
 *   const tab = url.searchParams.get('tab') ?? 'overview';
 *   return <Layout>{user.name} — {tab}</Layout>;
 * }
 * ```
 *
 * @see {@link https://www.rshono.com/docs/pages#page-props | Docs — page props}
 */
export interface PageProps<Path extends string = string, E extends Env = Env> {
  /**
   * The absolute browser-facing request {@link URL}, proxy-header aware (`X-Forwarded-Host` /
   * `-Proto`). A fresh instance per request, so mutating it is local to the page; it is not
   * serializable, so hand a `'use client'` component `url.href` rather than `url`.
   *
   * On a `render: 'static'` route this is the build-time URL — rendered once against `siteUrl`, so
   * `url.searchParams` is always empty. Read the query from `useNavigation().url` in a `'use client'`
   * component instead, or mark the route `render: 'dynamic'`.
   */
  url: URL;
  /** Matched route params for this request, e.g. `{ id: '42' }` for `/profile/:id`. */
  params: string extends Path ? Record<string, string> : PathParams<Path>;
  /**
   * The request context — the object `getRequestContext()` returns, handed to the page so cookies,
   * headers, env and middleware variables are reachable without an import.
   *
   * Server-only, non-enumerable (a `{...props}` spread and `JSON.stringify` both skip it) and never
   * serialized. Passing it to a `'use client'` component fails the render, because it wraps the live
   * request — read what you need here and pass plain values down.
   *
   * Non-enumerable is the one place this API breaks a JavaScript expectation, and it is unavoidable: an
   * enumerable `ctx` would put `ctx.hono.env` — every binding and secret — into React's dev-only
   * serialization of a server component's props, which walks own enumerable properties. So `<Child
   * {...props} />` hands a **server** child `ctx: undefined` with no error, while the type says otherwise.
   * Nested server components are meant to call `getRequestContext()` for the same object rather than
   * receive it, which is also the fix if a spread has already cost you an afternoon.
   *
   * Reading it on a `render: 'static'` route throws: a prerendered page has no per-request context.
   * Mark the route `render: 'dynamic'`, or use the `url` / `params` props.
   *
   * @example
   * ```tsx
   * export default function Dashboard({ ctx }: PageProps) {
   *   const session = ctx.cookies.get('session');
   *   if (!session) redirect('/login');
   *   return <Layout>Signed in as {session}</Layout>;
   * }
   * ```
   */
  ctx: RequestContext<E>;
}

/**
 * A page: a React **server component** rendering the entire document (`<html>…</html>`), usually via
 * a shared layout. It may be `async` and await data directly.
 *
 * Each page module default-exports exactly one. Interactive parts belong in `'use client'` components
 * the page imports — only those ship JS.
 *
 * @typeParam P - The component's props; for a page these are {@link PageProps}.
 *
 * @see {@link https://react.dev/reference/rsc/server-components | React — Server Components}
 * @see {@link https://www.rshono.com/docs/pages | Docs — pages}
 */
// `any`, not `unknown`: this default is what an unparameterised `PageComponent` means in a user's own
// annotation, and `unknown` props would reject every component that declares the props it actually takes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PageComponent<P = any> = (props: P) => ReactNode | Promise<ReactNode>;

/**
 * The shape an `{ type: 'endpoint' }` route's server module must have: a single named `handler`
 * export. It only ever loads on the server, so importing a database client or reading secrets from it
 * is safe.
 *
 * @example
 * ```ts
 * // src/health.ts
 * import type { Handler } from 'hono';
 *
 * export const handler: Handler = (c) => c.json({ ok: true });
 * ```
 *
 * @see {@link https://www.rshono.com/docs/routing#endpoint-routes | Docs — endpoint routes}
 */
export interface EndpointServerModule {
  /**
   * A Hono {@link Handler} for every request the route matches. It is passed Hono's `Context`, so the
   * request, the response builders (`c.json`, `c.text`, `c.body`) and middleware variables are all
   * reached through it.
   *
   * @see {@link https://hono.dev/docs/api/context | Hono — Context}
   */
  handler: Handler;
}

/**
 * A page route — a path rendered by a server component. This is the default
 * route kind, so `type` can be omitted.
 *
 * @example
 * ```ts
 * { path: '/profile/:id', component: () => import('./components/profile') }
 * ```
 */
export interface PageRoute {
  /** Discriminates a page from an endpoint; optional because `'page'` is the default. */
  type?: 'page';
  /**
   * Hono-style path pattern, e.g. `/`, `/profile/:id`, `/files/*`. Routes are matched in
   * declaration order.
   *
   * @see {@link https://hono.dev/docs/api/routing | Hono — routing}
   */
  path: string;
  /**
   * Dynamic import of the page module, whose default export is the {@link PageComponent}.
   *
   * Write it inline as `() => import('…')`: the framework detects that exact form and injects the
   * `'use server-entry'` directive that attaches the page's client JS and CSS. Wire the component up
   * any other way — a variable, a barrel re-export, a computed specifier — and you have to put
   * `'use server-entry'` on the page module's first line yourself.
   *
   * @example
   * ```ts
   * component: () => import('./components/profile')
   * ```
   *
   * @see {@link https://www.rshono.com/docs/pages#the-use-server-entry-directive | Docs — the `'use server-entry'` directive}
   */
  component: () => Promise<{ default: PageComponent }>;
  /** `'static'` prerenders the route at build time; `'dynamic'` (the default) renders per request. */
  render?: 'static' | 'dynamic';
  /**
   * For a `render: 'static'` route with params: the param sets to prerender, one page each. Runs at
   * build time on the server, so it may hit a database or read the filesystem.
   *
   * A parameterised static route without this falls back to rendering per request, with a build
   * warning. Wildcard (`*`), optional and regex params cannot be prerendered.
   *
   * @example
   * ```ts
   * {
   *   path: '/docs/:slug',
   *   render: 'static',
   *   component: () => import('./components/documentation'),
   *   staticPaths: async () => (await db.docs.all()).map((d) => ({ slug: d.slug })),
   * }
   * ```
   *
   * @see {@link https://www.rshono.com/docs/routing#static-rendering | Docs — static rendering}
   */
  staticPaths?: () => Array<Record<string, string>> | Promise<Array<Record<string, string>>>;
}

/**
 * An endpoint route — a path served by a raw Hono handler instead of a React
 * component. Use it for JSON APIs, webhooks, redirects, feeds, or anything that
 * isn't an HTML page.
 *
 * @example
 * ```ts
 * { type: 'endpoint', path: '/api/health', server: () => import('./health') }
 * ```
 *
 * @see {@link https://www.rshono.com/docs/routing#endpoint-routes | Docs — endpoint routes}
 */
export interface EndpointRoute {
  /** Marks this route as an endpoint rather than a page. Required. */
  type: 'endpoint';
  /**
   * Hono-style path pattern, e.g. `/api/health`, `/api/users/:id`.
   *
   * @see {@link https://hono.dev/docs/api/routing | Hono — routing}
   */
  path: string;
  /**
   * HTTP method to match, or a list of them. Defaults to `'all'` — every method.
   *
   * There is no `'head'`: Hono dispatches a `HEAD` as a `GET` and strips the body off the response, so a
   * `HEAD` is already answered by the `'get'` handler (and by `'all'`), and a route registered for `HEAD`
   * alone would never be reached.
   *
   * A list is how a two-method endpoint says so; `'all'` inside one is refused, since it is either the
   * whole thing or a mistake. A method the route does not name gets Hono's 404 rather than the handler.
   *
   * @example
   * ```ts
   * { type: 'endpoint', path: '/api/session', method: ['get', 'delete'], server: () => import('./session') }
   * ```
   */
  method?: HTTPMethod | readonly HTTPMethod[];
  /** Dynamic import of the {@link EndpointServerModule} exporting `handler`. */
  server: () => Promise<EndpointServerModule>;
}

/**
 * HTTP methods an {@link EndpointRoute} can match. `'all'` matches every method.
 *
 * No `'head'`, deliberately — see {@link EndpointRoute.method}. A `HEAD` reaches the `'get'` handler.
 */
export type HTTPMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'all';

/** Any entry in the `routes` array: a {@link PageRoute} or an {@link EndpointRoute}. */
export type Route = PageRoute | EndpointRoute;

/**
 * Narrows a {@link Route} to a {@link PageRoute} — `type` is optional on page routes, so anything not
 * explicitly `'endpoint'` is one.
 *
 * @internal
 */
export function isPageRoute(route: Route): route is PageRoute {
  return route.type !== 'endpoint';
}

/**
 * A page the framework falls back to rather than routes to — `notFound` and `error` in
 * {@link RouteConfig}. Same contract as a {@link PageRoute} `component`, without a path of its own.
 */
export interface FallbackPage {
  /** Dynamic import of the page module; its default export is the {@link PageComponent}. */
  component: () => Promise<{ default: PageComponent }>;
}

/**
 * The error detail handed to the `error` page. Redacted in production — a generic
 * `'Internal Server Error'` and no `stack`; in dev, the real message and stack.
 */
export interface ErrorPageInfo {
  /** The thrown error's message in dev; `'Internal Server Error'` in production. */
  message: string;
  /**
   * The stack trace — **dev only**, and `undefined` in every build. Optional for that reason rather than
   * because some errors lack one, so a page that renders it should guard on it, not on a mode flag.
   */
  stack?: string;
}

/**
 * Props for the `error` page declared in {@link RouteConfig.error} — the usual {@link PageProps} plus
 * the redaction-aware {@link ErrorPageInfo}.
 *
 * In a build `error.message` is the generic `'Internal Server Error'` and `error.stack` is `undefined`, so
 * the page below guards on the stack rather than on a mode flag — there is no mode flag to guard on.
 *
 * @typeParam E - The app's Hono {@link Env}, forwarded to {@link PageProps.ctx}.
 *
 * @example
 * ```tsx
 * import type { ErrorPageProps } from '@rshono/core';
 *
 * export default function ServerError({ error }: ErrorPageProps) {
 *   return (
 *     <html>
 *       <body>
 *         <h1>Something went wrong</h1>
 *         <p>{error.message}</p>
 *         {error.stack && <pre>{error.stack}</pre>}
 *       </body>
 *     </html>
 *   );
 * }
 * ```
 */
export type ErrorPageProps<E extends Env = Env> = PageProps<string, E> & {
  /** The error that failed the request, redacted in production — see {@link ErrorPageInfo}. */
  error: ErrorPageInfo;
};

/**
 * The object form accepted by {@link defineRoutes}: the route table plus the two
 * optional framework-owned pages.
 *
 * @typeParam TRoutes - Inferred tuple of route literals, which is what makes the
 *   per-route `path` → props check possible.
 *
 * @see {@link https://www.rshono.com/docs/routing#notfound-and-error | Docs — notFound and error pages}
 */
export interface RouteConfig<TRoutes extends readonly Route[] = readonly Route[]> {
  /** Every page and endpoint in the app, matched in order. */
  routes: TRoutes;
  /** Page rendered with a 404 status for unmatched paths and for `notFound()` calls. */
  notFound?: FallbackPage;
  /** Page rendered with a 500 status when a request throws. Receives {@link ErrorPageProps}. */
  error?: FallbackPage;
}

/**
 * The same check for `staticPaths`, whose param sets have to fill the route's own path: a key that does not
 * is otherwise a build-time throw from `interpolatePath` rather than a type error.
 *
 * Keys only, not full assignability, because the declared field type is `Record<string, string>` and a
 * `staticPaths` annotated as returning exactly that has to stay accepted — an index signature carries no
 * key to check, so it passes. Skipped where the path has no params, because `staticPaths` is not called for
 * such a route at all and an error there would be about the wrong thing.
 */
type ValidateStaticPaths<R, P extends string> =
  ParamKeys<P> extends never
    ? R
    : R extends { staticPaths: () => infer Sets }
      ? Awaited<Sets> extends ReadonlyArray<infer Set>
        ? [keyof PathParams<P>] extends [keyof Set]
          ? R
          : R & { staticPaths: `every param set staticPaths returns needs the params of '${P}'` }
        : R
      : R;

// `PageProps<P, any>`, not `PageProps<P>`: only the *path* is being checked, and pinning the Env would
// fail every page that declares its own (`PageProps<'/x', MyEnv>`, to type `ctx.var`).
type ValidateRoute<R> = R extends {
  path: infer P extends string;
  component: () => Promise<{ default: PageComponent<infer CP> }>;
}
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Env is deliberately unpinned; see above.
    [PageProps<P, any>] extends [CP]
    ? ValidateStaticPaths<R, P>
    : R & { component: `component props are not satisfied by PageProps<'${P}'>` }
  : R;

type ValidateRoutes<TRoutes extends readonly Route[]> = { [K in keyof TRoutes]: ValidateRoute<TRoutes[K]> };

/**
 * Declares the app's route table. Export the result as `routes` from `src/routes.ts` — the one file
 * rshono requires. It only ever runs on the server, so importing server-only modules from it (inside
 * `staticPaths`, say) is safe.
 *
 * Beyond typing the config, every page is cross-checked against its own path: props not satisfied by
 * `PageProps<'<its path>'>` make the `component` field a type error. A bare {@link Route} array is
 * accepted as shorthand — see the second overload.
 *
 * @param config - A {@link RouteConfig}: the `routes` array plus the optional `notFound` and `error`
 *   pages.
 * @returns The config, unchanged and fully typed.
 *
 * @example
 * ```ts
 * // src/routes.ts
 * import { defineRoutes } from '@rshono/core';
 *
 * export const routes = defineRoutes({
 *   routes: [
 *     { path: '/', component: () => import('./components/home') },
 *     { path: '/profile/:id', component: () => import('./components/profile') },
 *     {
 *       path: '/docs/:slug',
 *       render: 'static',
 *       component: () => import('./components/documentation'),
 *       staticPaths: async () => [{ slug: 'getting-started' }, { slug: 'deployment' }],
 *     },
 *     { type: 'endpoint', path: '/api/health', server: () => import('./health') },
 *   ],
 *   notFound: { component: () => import('./components/404') },
 *   error: { component: () => import('./components/500') },
 * });
 * ```
 *
 * @see {@link https://www.rshono.com/docs/routing | Docs — routing}
 */
export function defineRoutes<const TRoutes extends readonly Route[]>(
  config: RouteConfig<TRoutes> & { routes: ValidateRoutes<TRoutes> },
): RouteConfig<TRoutes>;
/**
 * Array shorthand for {@link defineRoutes} — equivalent to `defineRoutes({ routes })`, for an app
 * with no `notFound` or `error` page.
 *
 * @param routes - The {@link Route} array; each page is checked against its own `path`.
 * @returns A {@link RouteConfig} wrapping them.
 *
 * @example
 * ```ts
 * export const routes = defineRoutes([{ path: '/', component: () => import('./components/home') }]);
 * ```
 *
 * @see {@link https://www.rshono.com/docs/routing | Docs — routing}
 */
export function defineRoutes<const TRoutes extends readonly Route[]>(routes: TRoutes & ValidateRoutes<TRoutes>): RouteConfig<TRoutes>;
export function defineRoutes(input: readonly Route[] | RouteConfig): RouteConfig {
  return Array.isArray(input) ? { routes: input } : (input as RouteConfig);
}
