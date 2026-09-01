<p align="center">
  <img src="https://raw.githubusercontent.com/rshono/rshono/main/logo.svg" alt="" width="72" height="72" />
</p>

<h1 align="center">@rshono/core</h1>

<p align="center">
  Minimalist web framework —
  <a href="https://hono.dev">Hono</a> +
  <a href="https://rspack.rs">Rspack</a> +
  <a href="https://react.dev/reference/rsc/server-components">React Server Components</a>.
</p>

One required file (`src/routes.ts`), one optional file (`src/server.ts`), and you get a dev server with HMR,
streaming SSR with RSC hydration, server actions with progressive enhancement, soft navigation, build-time
prerendering, and hard env/secret safety.

> **Release candidate.** The framework itself is covered end to end (see [Testing](#testing)) and its API is
> settled. What is not settled underneath it: Rspack's RSC support is an experimental API
> (`rspack.experiments.rsc`) and `react-server-dom-rspack` has not reached 1.0, so its own minor bumps are
> breaking by convention. Both are pinned to exact versions — in the manifests and in workspace overrides —
> and a release of rshono is what moves them, so an upstream change reaches you as a tested release rather
> than as a broken install. That is the whole of the caveat, and it is the reason to read the
> [changelog](../../CHANGELOG.md) before upgrading.

**Full documentation: [rshono.com/docs](https://www.rshono.com/docs).**

```bash
npx @rshono/create@latest my-app   # scaffold one, with a deploy target and tooling of your choosing
```

```bash
rshono dev     # dev server with HMR (default port 3000)
rshono build   # production build: client + server bundles + prerendered pages
rshono start   # run the production build
```

`--port` / `PORT` and `HOST` set where it listens; `--config <path>` points `build` at another config file.

## Project layout

```
rshono.config.ts   optional — every field has a default
public/            optional — served verbatim at the web root
src/
  routes.ts        required — the route table
  server.ts        optional — a Hono sub-app mounted ahead of the page routes
  …                everything else is yours to arrange
```

Only those two files under `src/` mean anything to the framework; no other name or directory carries a
convention. `@/…` resolves to `src/…` in both compilers, so add the matching `paths` to `tsconfig.json` if
you use it — relative, and with no `baseUrl`, which TypeScript 7 removed:

```json
{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
```

## The one required file: src/routes.ts

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

`routes.ts` only ever runs on the server, so importing server-only modules from it (inside `staticPaths`,
say) is safe. A plain array, with no special pages, is accepted as shorthand.
[Routing docs](https://www.rshono.com/docs/routing).

## Pages are server components

Every page module default-exports a server component — nothing else. It renders the whole document
(`<html>…</html>`), may be `async`, and awaits its data directly. Interactive parts are `'use client'`
components the page imports; only those ship JavaScript.

```tsx
import type { PageProps } from '@rshono/core';
import { db } from '../db';

export default async function Profile({ params, ctx }: PageProps<'/profile/:id'>) {
  const user = await db.getUser(params.id);
  const theme = ctx.cookies.get('theme') ?? 'light';
  return <Layout>…</Layout>;
}
```

- Pages receive `{ url, params, ctx }` — `PageProps<'/profile/:id'>` types `params.id`, and `url` is a real
  `URL`. The same pair reaches a `'use client'` component from `useNavigation()`, so a read moves across the
  boundary unchanged.
- **`ctx` is the request context** — `ctx.req`, cookies, env, middleware variables, the proxy-aware URL. It is
  the same object `getRequestContext()` returns from `@rshono/core/server`, handed over so a page needs no
  import. Reading it on a `render: 'static'` page throws: a page rendered once at build time has no request.
  A page can only _read_ it — `cookies.set` and `setHeader` throw there, because a page streams and its
  response head is already committed; set them from a `'use server'` action or from middleware instead.
- Page props are server-only and never serialized, and `ctx` cannot cross into a client component. Read what
  you need on the server and pass plain values down (`url.href`, not `url`).
- The framework injects Rspack's `'use server-entry'` directive for every component referenced with the
  inline `component: () => import('…')` thunk — that is what attaches the page's JS and CSS to it, so code
  splitting needs no asset manifest. Wire a component up some other way and you write the directive
  yourself; the framework throws a descriptive error when neither happened.

[Pages docs](https://www.rshono.com/docs/pages).

## Server actions

`'use server'` modules export functions callable from client components:

```ts
'use server';
export async function createUser(data: { name: string; email: string }) { … }
```

Call them directly from client code (typed args and result), or wire them to `<form action>` /
`useActionState` — forms keep working before hydration and with JavaScript disabled. Every action response
carries a fresh page payload, so server-rendered UI updates after a mutation.
**Every `'use server'` export is a public HTTP endpoint**, so authenticate, authorize and validate inside the
action. [Server actions docs](https://www.rshono.com/docs/pages#server-actions), and
[how to use them](https://www.rshono.com/docs/usage).

## Full Hono underneath

- `{ type: 'endpoint' }` routes export a Hono `handler` from a server module.
- `src/server.ts` may default-export a whole Hono sub-app: any method, streaming, cookies, middleware.
  `export type AppType = typeof server` gives end-to-end type safety with `hono/client`.
- It is mounted at `/` **ahead of the page routes**, so its middleware (auth, logging, trailing-slash) wraps
  page requests too. The flip side: a _terminal_ handler at the same path as a page route shadows the page.

[Hono docs](https://www.rshono.com/docs/hono).

## Styling

`import './styles.css'` from any component. Rspack's native CSS pipeline compiles it, and the import
attaches the stylesheet to the importing page — so CSS is code-split per route and `<link>`ed in the streamed
HTML rather than fetched after hydration. `*.module.css` gets a class map.

**There is no PostCSS in the framework**, so a stylesheet that needs a plugin brings one, through the
[`rspack` hook](#configuration-rshonoconfigts). Tailwind is exactly that and nothing else — four packages, a
`postcss.config.mjs` and one rule; `npx @rshono/create@latest --tailwind` writes all of it.
[Styling docs](https://www.rshono.com/docs/styling).

## Env & secret safety

The boundary is the RSC directives — `'use client'` and `'use server'` — not filenames, and `process.env`
follows it.

- In the **client bundle** `process.env` is _replaced at build time_ with a literal holding only `NODE_ENV`
  and `PUBLIC_`-prefixed variables. A stray `process.env.DATABASE_URL` in client code compiles to
  `undefined`; the value cannot ship. That is a build-time substitution, not tree-shaking, and it covers
  `node_modules` too.
- Your `'use client'` modules see the same `PUBLIC_`-only view **while being SSR'd**, so a secret read there
  renders empty instead of leaking into the HTML stream, and SSR output still agrees with hydration.
- Server components and `'use server'` actions read the real `process.env`. Anything a server component
  _renders_ is public by definition.
- `.env.local` and `.env` are loaded automatically; the real environment wins.

[Environment and secrets](https://www.rshono.com/docs/configuration#environment-and-secrets).

## Configuration: rshono.config.ts

Optional (`.js` / `.mjs` also work). Every field is optional; delete the file to accept all defaults.

```ts
import { defineConfig } from '@rshono/core';

export default defineConfig({
  deploy: 'node', // hosting platform to build for (--deploy or RSHONO_DEPLOY override)
  siteUrl: 'https://example.com', // public origin, baked into prerendered pages' absolute URLs
  trustProxy: false, // honour X-Forwarded-Host/-Proto — only behind a proxy you control
  rspack(config, { isServer, isDev }) {
    return config; // escape hatch: mutate the generated Rspack config
  },
});
```

That is the whole file. It holds what the **build** decides; per-request security is Hono middleware in
`src/server.ts`, which is mounted ahead of the page routes and so wraps renders and server actions too:

```ts
// src/server.ts
import { publicUrl } from '@rshono/core/server';
import { bodyLimit } from 'hono/body-limit'; // https://hono.dev/docs/middleware/builtin/body-limit
import { csrf } from 'hono/csrf'; // https://hono.dev/docs/middleware/builtin/csrf
import { NONCE, secureHeaders } from 'hono/secure-headers'; // https://hono.dev/docs/middleware/builtin/secure-headers

// Caps a body before anything buffers it — pages, actions and your own handlers alike. 413 over cap.
server.use(bodyLimit({ maxSize: 1024 * 1024 }));

// Rejects a cross-origin POST with 403 before it can reach a server action. `publicUrl(c)` rather
// than Hono's default, which compares against the address the server was *reached* on — the internal
// one behind any proxy. It honours `trustProxy`.
server.use(csrf({ origin: (origin, c) => origin === publicUrl(c).origin }));

// HSTS, COOP, CORP and the rest. `NONCE` in `scriptSrc` makes the CSP per-request: Hono mints the
// nonce, rshono stamps it onto the bootstrap scripts and the inlined flight payload.
server.use(secureHeaders({ contentSecurityPolicy: { scriptSrc: ["'self'", NONCE] } }));
```

`create-rshono` scaffolds the first two. Under `rshono dev` the framework widens `script-src` with
`'unsafe-eval'` for React Refresh — never in a build — so one policy serves both, and a route with a
nonce in play falls back to rendering per request. Everything else Hono ships works the same way:
`cors`, `basicAuth`, `jwt`, `timeout`, `requestId`, `ipRestriction`. A middleware that rejects by
throwing an `HTTPException` keeps its own status rather than becoming the 500 page.
[Middleware docs](https://www.rshono.com/docs/hono#security-middleware) · [Hono](https://hono.dev/docs).

`deploy` and `rspack` are consumed by the CLI; `trustProxy` is **compiled into the server bundle** at build
time, so changing it means a rebuild and there is no parallel env-var interface for it (environment
variables are for secrets). The port and bind address are deliberately not config fields — on every host
that runs this, the environment is what sets them. [Configuration docs](https://www.rshono.com/docs/configuration).

The defaults, in short: untrusted proxy headers, `nosniff` / `Referrer-Policy` / `X-Frame-Options` on
every response (a floor your own `secureHeaders()` overrides),
`private, no-cache` plus `Vary: RSC` on dynamic pages, `public, max-age=300` and a weak `ETag` on
prerendered ones, and errors redacted in production — with one `onServerError()` funnel for reporting them
and three fallbacks (a fatal client overlay, a visible 500 document, a reported bootstrap failure) so a
failure is never a blank screen.

## Prerendering (`render: 'static'`)

A static route is built once and served from disk in **both** representations — `index.html` for a hard load,
`index.rsc` for the flight payload a soft navigation asks for — each with a weak `ETag`. Set **`siteUrl`** if
those pages build absolute URLs: one set of bytes is handed to everyone, so the origin has to be decided at
build time (without it the build warns and uses `http://localhost`). A page that can't be prerendered — no
`staticPaths`, or it didn't render cleanly — is reported by the build and falls back to rendering per
request. [Static rendering docs](https://www.rshono.com/docs/routing#static-rendering).

## Deployment

`rshono build` targets one platform. Pick it with `deploy` in the config, `--deploy <name>` or
`RSHONO_DEPLOY`, in that precedence order; the default is `node`. `rshono dev` always runs the Node dev
server whatever you choose — the target is a property of the build, not of developing.

| `deploy`     | Handoff                          | Assets & prerendered pages                                      | After `build`                               |
| ------------ | -------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `node`       | binds a port                     | from `dist/` on disk                                            | `rshono start`                              |
| `cloudflare` | `{ fetch }` default export       | Workers Assets; prerendered pages read via the `ASSETS` binding | `wrangler deploy`                           |
| `vercel`     | web handler in a Node function   | CDN for assets; prerendered pages inside the function           | `vercel deploy --prebuilt`                  |
| `aws-lambda` | streaming handler (Function URL) | from the deployment package                                     | zip `dist/`, handler `dist/server/main.mjs` |

One target per _handoff_ — the thing an app cannot arrange for itself. Everything else about a platform sits
behind one `DeployRuntime` interface, and `node`, `vercel` and `aws-lambda` share a filesystem implementation.
Every target streams, which is the bar a new one has to clear.

- **`node` is not only Node.** Anything that runs a Node process runs this build — a VPS, a container, a PaaS.
  Bun (`bun dist/server/main.mjs`) and Deno (`deno run -A dist/server/main.mjs`) are expected to as well,
  since the listener is `@hono/node-server`; they had a target each, which held nothing beyond a default
  export. The suite runs on Node, so treat those two as an expectation rather than a guarantee.
- **Don't build a handler out of the `app` export.** The entry calls `runtime.serveApp(app)` at module scope,
  so importing a `node` build binds a port as a side effect. Build for the target you deploy to, and
  `rshono start` will refuse a build made for another platform.
- **Streaming is the fragile part of a serverless target, and it fails silently** — `supportsResponseStreaming`
  on Vercel, `streamifyResponse` plus a `RESPONSE_STREAM` Function URL on Lambda. Getting those right is what
  the presets are for.
- **Prerendered pages are never CDN-served**: one URL answers with a document or a flight payload depending on
  the `RSC` request header, and a path-keyed CDN cannot choose. `/_static` and `public/` do go straight to the
  CDN.
- **The serverless targets bundle your dependencies**; `node` bundles only the ones a `'use client'` component
  pulls in. A function is an uploaded directory with no `node_modules` to resolve against, so `vercel`,
  `aws-lambda` and `cloudflare` compile everything in. The cost is that a native addon — or a package that
  reads its own files off disk — fails the build on those targets rather than the deploy; reach for the
  `rspack` hook, or deploy to `node`.

  On `node` a server component's dependencies stay external and resolve from `node_modules`, but anything
  reachable from a `'use client'` component is compiled in on every target. It has to be: the `PUBLIC_`-only
  `process.env` view is applied by a loader, and a loader cannot run on a module the bundle only imports by
  name — an external third-party client component would be SSR'd against the real environment. Nothing is
  given up, since the same module is in the browser bundle and so was always required to be bundleable.

[Deployment docs](https://www.rshono.com/docs/deployment), including Cloudflare bindings and the AWS setup.

## Requirements & limitations

- **Node ≥ 22.18** (worker threads, `process.loadEnvFile`, `Promise.withResolvers`, `URL.parse`, and native
  TypeScript stripping, so a `.ts` config needs no loader) and **React ≥ 19.1** (the floor
  `react-server-dom-rspack` requires).
- No response compression, no base path (`siteUrl` is a bare origin), and wildcard, optional and regex
  params cannot be prerendered.
- **No link prefetching**, by choice: a link is one fetch at click time and nothing before it. Speculative
  fetching on hover spends every visitor's bandwidth to help some of them — so a navigation here costs a
  round trip that Next.js and TanStack Start have usually already paid.
- No incremental static regeneration: `render: 'static'` is decided at build time, and a static page changes
  when you rebuild.
- **Soft navigation needs the [Navigation API](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API)**
  — Chrome/Edge 135, Firefox 147, Safari 26.2, [Baseline](https://web.dev/blog/baseline-navigation-api) since
  January 2026. Where it is missing there is no interception at all and every link is a real browser load,
  which a server-rendered app answers correctly; only the soft part is gone. Scroll restoration, the fragment
  jump and the post-navigation focus reset are all the browser's.
- **`redirect()` and `notFound()` must be reached before the page shell is sent.** A page streams: the status
  line and the first bytes go out as soon as the shell is ready, and HTTP has no take-backs after that. Called
  from a `<Suspense>` boundary that resolves later, the signal can no longer be a 3xx or a 404 — the response
  is already committed as `200 text/html`. A browser with JavaScript still follows it (the signal rides the
  payload as a digest, and the client runtime navigates), but a visitor without JavaScript is left on the
  fallback under a 200, and a crawler indexes that 200 as a soft 404. The fix is app-side: decide in Hono
  middleware, or in the page component body above the boundary. `rshono dev` warns when it happens.
- **A page route answers `GET`, `POST` and `HEAD`.** Every other method is a 404 rather than a 405: the
  `Allow` header a 405 owes the client means tracking the methods registered per path, which is state on a hot
  path for a distinction nothing acts on differently here. An endpoint route is the way to answer a `PUT`,
  `PATCH`, `DELETE` or `OPTIONS`.
- **A page's `ctx` prop is non-enumerable**, so `<Child {...props} />` hands a *server* child
  `ctx: undefined` — silently, since a spread copies enumerables only, and the type still says it is there.
  It cannot be otherwise: an enumerable `ctx` would put `ctx.hono.env`, every binding and secret, into
  React's dev-only serialization of a server component's props. Nested server components are meant to call
  `getRequestContext()` rather than be handed the context.
- The dev proxy doesn't forward WebSocket upgrades to a custom sub-app; production is unaffected.
- Dev source maps embed the original source of `'use server'` modules (dev binds 127.0.0.1 only, and
  production ships no client source maps).

## Testing

`pnpm --filter @rshono/core test` builds the package and runs everything that needs no browser:

- **unit** — the parsers and path maths, against the built `dist/`, which also proves the published output
  loads in plain Node.
- **production e2e** — builds `apps/testbed`, boots the real production server, and asserts pages, the flight
  protocol, actions (client and no-JS), CSRF rejection, secret stripping in bundles _and_ rendered HTML, SSG
  output with `ETag`/304, cache and security headers, and error reporting. The hardened permutations — a
  nonce CSP, a CSRF allowlist, a small body cap — are middleware, so they run against that same build
  under a different environment; `trustProxy` is baked in and gets a fixture config.
- **the other deploy targets** — the `cloudflare` bundle driven as `fetch(request, env, ctx)` against a
  stand-in `ASSETS` binding, a real build per serverless target checked against the handoff its platform
  expects, and `rshono start`'s refusal to run a build made for another one.
- **minimal app**, a fixture with `src/routes.ts` and nothing else (everything the docs call optional, left
  out); **postcss**, the documented Tailwind wiring actually run; **dev**, a smoke test through the dev
  server's worker and proxy.

`pnpm --filter @rshono/core test:browser` runs the Playwright suite against a production build: hydration,
soft navigation, `useNavigation`, client-initiated actions, boundary fallbacks and the fatal overlay — the
client runtime, which no amount of asserting on HTML can reach.

## How it works

Two coordinated Rspack compilers, using native RSC support (`rspack.experiments.rsc`):

- **client** (`target: web`) → `dist/static`: hydration runtime, `'use client'` chunks, CSS.
- **server** (`target: node`) → `dist/server/main.mjs`: a Hono app assembled from your routes, rendered
  through two layers — the RSC layer, with the `react-server` condition, produces the flight payload; the SSR
  layer turns it into an HTML stream with the payload inlined for hydration.

In dev the CLI watches both bundles, runs the server bundle in a worker thread (restarted per rebuild,
requests gated on readiness so nothing drops), and fronts everything on one port with static serving and an
SSE channel: client edits hot-apply via react-refresh, server component edits re-fetch the payload in place,
and browser state survives both. In production `dist/server/main.mjs` has React, Hono and the framework
bundled in. On `node` your server-side dependencies still resolve from `node_modules` beside it; on the
serverless targets they are bundled too, because nothing installs them there. Whatever a `'use client'`
component reaches is bundled on every target, which is what lets the env shadow cover it.
