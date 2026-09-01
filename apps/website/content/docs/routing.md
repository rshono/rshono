---
title: Routing
description: src/routes.ts — the one file rshono requires, and the only place routes are declared.
---

Routes are an explicit table, not a directory scan. One file lists every page and endpoint, matched in
order.

```ts
import { defineRoutes } from '@rshono/core';

export const routes = defineRoutes({
  routes: [
    { path: '/', component: () => import('./components/home') },
    { path: '/profile/:id', component: () => import('./components/profile') },
    {
      path: '/docs/:slug',
      render: 'static',
      component: () => import('./components/documentation'),
      staticPaths: async () => [{ slug: 'getting-started' }, { slug: 'deployment' }],
    },
    { type: 'endpoint', path: '/api/health', server: () => import('./health') },
  ],
  notFound: { component: () => import('./components/404') },
  error: { component: () => import('./components/500') },
});
```

`routes.ts` only ever runs on the server, so importing server-only modules from it — inside
`staticPaths`, say — is safe. A plain array is shorthand when there are no `notFound` / `error` pages:

```ts
export const routes = defineRoutes([{ path: '/', component: () => import('./components/home') }]);
```

## Paths

Paths use Hono's syntax: `:id`, `:id{[0-9]+}` and `*` all work.

`PageProps<'/users/:id/posts/:postId'>` turns that literal into `{ id: string; postId: string }`, and
`defineRoutes` checks each page's props against the path it is mounted at. Out of step, and the
`component` field errors with `component props are not satisfied by PageProps<'/…'>` — at the route
definition, not at runtime.

## Page routes

`type` can be omitted; `'page'` is the default.

| Field         | Meaning                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `path`        | Hono-style pattern, e.g. `/`, `/profile/:id`, `/files/*`.                           |
| `component`   | Dynamic import of the page module; its default export is the page.                  |
| `render`      | `'static'` prerenders at build time; `'dynamic'` (the default) renders per request. |
| `staticPaths` | For a parameterised static route: the param sets to prerender, one file each.       |

Write `component` inline as `() => import('…')`. The framework detects that exact form and injects
Rspack's `'use server-entry'` directive for you, which is what attaches each page's client JS and CSS to
its component — per-route code splitting with no asset manifest. Wire a component up some other way
(variable indirection, barrel re-exports, computed specifiers) and the build throws a descriptive error
telling you to write the directive at the top of the page module yourself.

## Static rendering

`render: 'static'` builds a route once, at build time, in **both** the forms a page is asked for:
`index.html` for a hard load, and `index.rsc` — the flight payload — for a soft navigation. Both carry a
weak `ETag`, so a revalidation costs a 304 rather than the page.

A static route **with params** needs `staticPaths`. It runs at build time only, on the server, so it may
hit a database or the filesystem:

```ts
staticPaths: async () => (await db.docs.all()).map((d) => ({ slug: d.slug })),
```

`defineRoutes` checks the param sets against the route's own path, the same way it checks a page's props:
a set that does not carry every `:param` of the path is a type error where the route is declared, not a
build-time throw. Keys only — a `staticPaths` typed as returning `Record<string, string>` has none to
check, so it is accepted and the build reports the mismatch instead.

Rules worth knowing:

- **Reading `ctx` throws.** There is no request at build time. Use `params` and `url`, or make the route
  dynamic.
- **Set [`siteUrl`](/docs/configuration#siteurl)** if the page builds absolute URLs. Without it the
  origin is `http://localhost` and the build warns.
- **Wildcard, optional and regex params cannot be prerendered.** A parameterised static route without
  `staticPaths` falls back to per-request rendering, and the build warns. So does a page that did not
  render cleanly.
- **Under a [nonce-based CSP](/docs/configuration#csp)** the document is rendered per request — a
  prerendered file cannot carry a per-request nonce. The flight payload is still served from the
  prerender, and a policy with no nonce in it keeps its prerendered documents too.

## Endpoint routes

An endpoint route is served by a raw Hono handler instead of a component — JSON APIs, webhooks,
redirects, feeds. `method` defaults to `'all'`, takes one method or a list of them, and there is no
`'head'`: Hono dispatches a `HEAD` as a `GET` and strips the body off the response, so `'get'` already
answers both.

It is also how you answer a method a page does not. A page route is registered for `GET` and `POST` — plus
the `HEAD` that rides the `GET` — and anything else is a 404 rather than a 405, deliberately: the `Allow`
header a 405 owes the client would mean tracking the methods registered per path, for a distinction no client
here acts on differently.

```ts
{ type: 'endpoint', path: '/api/health', method: 'get', server: () => import('./health') }

// Two methods, one handler. Without the list this would be `'all'` plus a hand-rolled method check,
// which also answers every method you did not mean to. `'all'` inside a list is refused.
{ type: 'endpoint', path: '/api/session', method: ['get', 'delete'], server: () => import('./session') }
```

```ts
// src/health.ts
import type { Handler } from 'hono';

export const handler: Handler = (c) => c.json({ ok: true });
```

The module only ever loads on the server, so reading secrets from it is safe.

## notFound and error

Both are optional, and both are real server components with a page's contract minus a path of their own.

- **`notFound`** — rendered with a 404 for unmatched paths and for `notFound()` calls.
- **`error`** — rendered with a 500 when a request throws, and given an extra `error` prop: message-only
  in production, message plus stack in dev.

See [Configuration & security](/docs/configuration#no-blank-screens) for what happens when a failure is
bad enough that the `error` page itself cannot be reached.
