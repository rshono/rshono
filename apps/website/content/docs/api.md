---
title: API reference
description: Every export of @rshono/core, @rshono/core/server and @rshono/core/client, in one place.
---

Three entry points, and which one an import comes from tells you where the code runs. That is most of
what there is to know about the surface.

| Import                | Runs                                 | Holds                                                                      |
| --------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `@rshono/core`        | build time, server                   | route and config declaration, and the types pages are written against      |
| `@rshono/core/server` | per request, server only             | the request context, `redirect` / `notFound`, error reporting, `publicUrl` |
| `@rshono/core/client` | browser, from `'use client'` modules | the navigation hook and the boundaries                                     |

`@rshono/core` pulls in no runtime machinery — importing it from server code is free. `@rshono/core/server`
from a `'use client'` module is a mistake: those run in the browser, where no request is bound. Read what
you need on the server and pass it down as props.

These three are the whole public surface — the package's `exports` map lists only them, so there is no
deeper path to import. Everything else is framework plumbing.

## `@rshono/core`

### Functions

| Signature                            | What it does                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defineRoutes(config): RouteConfig`  | Declares the app's route table in `src/routes.ts`. Also accepts a bare `Route[]` as shorthand. Cross-checks every page's props against its own `path`. |
| `defineConfig(config): RshonoConfig` | Types `rshono.config.ts`. Identity function — it exists for the autocomplete.                                                                          |

See [Routing](/docs/routing) and [Configuration](/docs/configuration).

### Types

| Type                   | What it describes                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `PageProps<Path, E>`   | What every page receives: `url`, `params`, `ctx`. Pass the route's path to type `params` key-by-key.            |
| `PageComponent<P>`     | A page: a server component returning `ReactNode` or `Promise<ReactNode>`.                                       |
| `PathParams<P>`        | The `params` record a path pattern implies — `'/users/:id'` → `{ id: string }`. `PageProps` applies it for you. |
| `PageRoute`            | A path rendered by a server component: `path`, `component`, and optional `render` / `staticPaths`.              |
| `EndpointRoute`        | A path served by a Hono handler: `type: 'endpoint'`, `path`, `server`, optional `method` (one or a list). |
| `EndpointServerModule` | What an endpoint's module must export — a single named `handler`.                                               |
| `Route`                | `PageRoute \| EndpointRoute`.                                                                                   |
| `RouteConfig<TRoutes>` | The object `defineRoutes` takes: `routes`, plus optional `notFound` and `error`.                                |
| `FallbackPage`         | The `notFound` / `error` page shape — a `component` with no path of its own.                                    |
| `ErrorPageProps<E>`    | `PageProps` plus `error`, for the page declared as `error`.                                                     |
| `ErrorPageInfo`        | `{ message, stack? }`. Redacted in production: a generic message, no stack.                                     |
| `HTTPMethod`           | `'get'` \| `'post'` \| `'put'` \| `'patch'` \| `'delete'` \| `'options'` \| `'all'`. A `HEAD` reaches `'get'`.  |
| `RshonoConfig`         | Every field of `rshono.config.ts`. All optional.                                                                |
| `RspackHookContext`    | `{ isServer, isDev }`, handed to the `rspack` config hook.                                                      |
| `DeployTarget`         | `'node'` \| `'cloudflare'` \| `'vercel'` \| `'aws-lambda'`.                                                     |

## `@rshono/core/server`

Server-only, and request-scoped. See [Pages](/docs/pages) and [Usage](/docs/usage).

### Functions

| Signature                                   | What it does                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `getRequestContext<E>(): RequestContext<E>` | The current request's context. Memoised per request. Throws at module load, and while prerendering a `render: 'static'` route.  |
| `redirect(location, status?): never`        | Throws a control signal the framework turns into a redirect. `status` defaults to `303`.                                        |
| `notFound(): never`                         | Aborts the render with a 404 and the app's not-found page.                                                                      |
| `onServerError(handler): void`              | Registers one handler for every error the framework catches. Call it once, at the top level of `src/server.ts`.                 |
| `publicUrl(c): URL`                         | The browser-facing URL for a Hono `Context` — proxy-corrected under `trustProxy`. For middleware, which has no request context. |

`publicUrl` is the one export here meant for `src/server.ts` rather than a component: middleware is
handed Hono's `c` and reads `c.req.url`, the address the server was reached on. Give Hono's own
middleware the browser's origin instead — `csrf({ origin: (origin, c) => origin === publicUrl(c).origin })`.
In a server component or an action, `getRequestContext().url` is the same value, cached per request.

`redirect` and `notFound` never return, so TypeScript narrows away the code after them and you don't
need to `return` the call. Don't wrap either in a `try/catch` that swallows the signal.

Both have to be reached **before the page shell is sent**. A page streams, so the status line goes out as
soon as the shell is ready and HTTP has no take-backs after that: called from a `<Suspense>` boundary that
resolves later, neither can still be a 3xx or a 404. The response is committed as `200 text/html`, a browser
with JavaScript follows the signal through the payload, and a visitor without it stays on the fallback.
Decide in middleware or in the page component body, above the boundary — `rshono dev` warns when a signal
arrives too late.

```tsx
import { getRequestContext, redirect } from '@rshono/core/server';

export default async function Dashboard() {
  const session = getRequestContext().cookies.get('session');
  if (!session) redirect('/login');
  return <Layout>Signed in as {session}</Layout>; // session is defined here
}
```

### `RequestContext`

What `getRequestContext()` returns, and the very same object a page gets as its `ctx` prop. Exported as a type
only — one instance exists per request and application code never constructs it.

Reads are safe anywhere. Writes are not — see [Writes happen before the render](#writes-happen-before-the-render).

| Member                               | What it is                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `url`                                | The browser-facing `URL`, proxy-header aware. Parsed once and cached.                                                    |
| `req`                                | Hono's `HonoRequest` — method, headers, query, body readers.                                                             |
| `params`                             | Matched route params. A page gets these typed as its `params` prop; this is for everywhere else.                         |
| `env`                                | Process env merged with runtime bindings (bindings win). See [Environment](/docs/configuration#environment-and-secrets). |
| `var`                                | Typed variables a middleware set with `c.set(…)`.                                                                        |
| `cookies.get(name)`                  | One cookie, or `undefined`.                                                                                              |
| `cookies.all()`                      | Every cookie as `{ name: value }`.                                                                                       |
| `cookies.set(name, value, options?)` | Sets a cookie on the response. **Throws in a page.**                                                                     |
| `cookies.delete(name, options?)`     | Clears one. Pass the `path`/`domain` it was set with. **Throws in a page.**                                              |
| `setHeader(name, value, options?)`   | Sets a response header. **Throws in a page.**                                                                            |
| `hono`                               | The underlying Hono `Context` — the escape hatch for everything not above.                                               |

What this adds over Hono's own `Context` is a proxy-aware cached URL, an env that merges runtime
bindings over process env, cookies without a second import, and writes that tell you when they cannot
work. The long tail — `executionCtx.waitUntil()` and whatever Hono adds next — is `ctx.hono`.

Hono's response builders (`redirect`, `notFound`, `json`, `text`, `html`, `body`, `status`, `header`)
are present as stubs that throw and name the right API, because a page returns JSX and the framework
builds the response from it — reaching them through `ctx.hono` bypasses the error without making them
work.

`ctx` cannot be handed to a `'use client'` component — it wraps the live request. Reading it on a
[`render: 'static'`](/docs/routing#static-rendering) page throws, because there is no request at build
time.

### Writes happen before the render

A page streams. By the time its component runs the response head is already committed — on a soft
navigation the flight response is built before the page's first line executes. A header set from there
would land on a full page load and vanish on a soft navigation, so `cookies.set`, `cookies.delete` and
`setHeader` throw inside a page render rather than work half the time.

Set them from a `'use server'` action, which runs before the render:

```ts
'use server';
import { getRequestContext, redirect } from '@rshono/core/server';

export async function login(form: FormData) {
  const ctx = getRequestContext();
  ctx.cookies.set('session', await createSession(form), { httpOnly: true, sameSite: 'Lax', path: '/' });
  redirect('/dashboard');
}
```

Or from middleware, for anything belonging to the page rather than to one mutation — `Cache-Control`,
`X-Robots-Tag`. Middleware and `{ type: 'endpoint' }` routes run **outside** the request context, so
`getRequestContext()` is not available in them; they are handed Hono's `c` instead, which is all they
need:

```ts
// src/server.ts
server.use('/blog/*', async (c, next) => {
  await next();
  c.header('cache-control', 'public, max-age=600, s-maxage=3600');
});
```

| Where                           | Reads   | Writes                                       |
| ------------------------------- | ------- | -------------------------------------------- |
| Pages, nested server components | ✅      | ❌ throws                                    |
| `'use server'` actions          | ✅      | ✅ `ctx.cookies.set(…)` / `ctx.setHeader(…)` |
| Middleware in `src/server.ts`   | via `c` | ✅ `c.header(…)` / `setCookie(c, …)`         |
| `{ type: 'endpoint' }` routes   | via `c` | ✅ same, on the `c` the handler is passed    |

### Types

| Type                 | What it describes                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `RequestContext<E>`  | The request context above. `E` is the app's Hono `Env`, which types `var` and `env`.      |
| `EnvVars<E>`         | What `ctx.env` resolves to: `Bindings` merged with `Record<string, string \| undefined>`. |
| `RedirectStatus`     | `301 \| 302 \| 303 \| 307 \| 308`.                                                        |
| `ServerErrorHandler` | `(error, context) => void` — what `onServerError` takes.                                  |
| `ServerErrorContext` | `{ source, request, hono, waitUntil }`, the second argument to that handler.               |
| `ServerErrorSource`  | `'action' \| 'render' \| 'ssr' \| 'request'` — which stage produced the error.            |

An `'action'` error is the one worth wiring up: React sends the client an opaque marker with no message
in production, so a handler is the only place the real error is visible.

`hono` is the request's Hono context, for `hono.var` and `hono.env` — handed over because
`getRequestContext()` is not reachable from the handler. `waitUntil` holds a serverless invocation open
until the report has been sent; see [error reporting](/docs/hono#error-reporting) for what it does per
target.

## `@rshono/core/client`

Every export is itself a `'use client'` module, so a server component can render `AsyncBoundary` directly.
The hook needs a client component.

### Hook

| Signature                          | What it returns                                                   |
| ---------------------------------- | ----------------------------------------------------------------- |
| `useNavigation(): NavigationState` | `{ url, params, router }` — the current location, and the router. |

`url` and `params` are computed on the server and travel in the flight payload, so they are right during
SSR and update on every navigation. In a server component, read the same data from `getRequestContext()`.

```tsx
'use client';
import { useNavigation } from '@rshono/core/client';

export function NextPage() {
  const { url, router } = useNavigation();
  const page = Number(url.searchParams.get('page') ?? '1');
  return (
    <button disabled={router.pending} onClick={() => router.push(`${url.pathname}?page=${page + 1}`)}>
      Next
    </button>
  );
}
```

`router` holds `push(href)`, `replace(href)`, `back()`, `forward()`, `refresh()` and the `pending` flag.
Every one is a **soft** navigation: the page's flight payload is fetched and applied in place, so client
state outside the changed subtree survives. Off-site hrefs, and a traversal that leaves the app, fall back
to a full load.

### Components

| Component         | Props                                      | What it does                                                                                     |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `<AsyncBoundary>` | `loading`, `error`, `onError`, `resetKeys` | A Suspense fallback and an error fallback in one wrapper — the common case for an async section. |
| `<CatchBoundary>` | `fallback`, `onError`, `resetKeys`         | Error boundary alone. Omit `fallback` to report and re-throw to the next boundary out.           |

`loading` on `AsyncBoundary` is required — a loading state is the reason to reach for it over
`CatchBoundary`, so showing nothing while loading is an explicit `loading={null}`. `error` is optional:
omit it and throws propagate to the next boundary out or the global error page. A `redirect()` is never
absorbed by either boundary — it's navigation, not failure.

### Types

| Type                 | What it describes                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `NavigationState`    | `{ url, params, router }` — what `useNavigation()` returns.                                               |
| `NavigationRouter`   | The imperative actions plus `pending`.                                                                    |
| `AsyncBoundaryProps` | Props of `<AsyncBoundary>`.                                                                               |
| `CatchBoundaryProps` | Props of `<CatchBoundary>`.                                                                               |
| `ErrorFallback`      | `ReactNode`, or `(error, reset) => ReactNode`. The function form only works from a `'use client'` module. |
