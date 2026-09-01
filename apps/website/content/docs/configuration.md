---
title: Configuration & security
description: rshono.config.ts — every field, the secret boundary, and what is hardened by default.
---

An optional `rshono.config.ts` (`.js` / `.mjs` also work) at the project root tunes the framework. Every
field is optional; delete the file to accept all defaults.

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

That is the whole file, and deliberately so: it holds only what the **build** decides. Everything that
is a per-request concern — CSRF, CSP, the request-body cap — is Hono middleware in
[`src/server.ts`](/docs/hono), because Hono already ships all of it and a config field would only be a
worse way to spell the same call. See [security middleware](#security-middleware) below.

`trustProxy` is resolved at build time and **compiled into the server bundle**, so changing it means a
rebuild. Two deployment-conventional exceptions stay env-overridable: `--port` / `PORT` and `HOST`, each
winning over the file, which wins over the default. Point a build at a different file with
`--config <path>`.

## `siteUrl`

The public origin the site is served from. Used only when prerendering
[`render: 'static'`](/docs/routing#static-rendering) routes, where there is no request to read a `Host`
from. The origin is what's used; a path is **rejected** rather than silently dropped, because a base
path is not supported.

## The `rspack` hook

Mutate the generated Rspack config just before it is compiled:

```ts
rspack(config, { isServer, isDev }) {
  config.module!.rules!.push({ test: /\.md$/i, type: 'asset/source' });
}
```

Called **once per compiler** — `isServer` tells the `target: node` bundle from the `target: web` one,
`isDev` tells `rshono dev` from `rshono build`. Mutate in place and return nothing, or return a
replacement. This is how [Tailwind](/docs/styling#tailwind) is wired up.

## Environment and secrets

The client/server boundary is the RSC directives — `'use client'` and `'use server'` — not filenames,
and `process.env` follows it.

In client code `process.env` is **replaced at build time** with a literal containing only `NODE_ENV` and
`PUBLIC_`-prefixed variables. A stray `process.env.DATABASE_URL` compiles to `undefined`. That is a hard
guarantee rather than tree-shaking, and it covers `node_modules` too.

`'use client'` modules are also rendered on the server, and there they see the same `PUBLIC_`-only view,
so SSR output agrees with hydration and a secret cannot leak into the HTML stream. One boundary on that:
the SSR-side shadowing is scoped to your own `src/`, so a **third-party** client component reading
`process.env` during SSR sees the real environment.

Server components and `'use server'` actions read the **real** `process.env`. They run only on the
server, so a secret read there never reaches the browser. Read secrets in server code and pass derived
data down.

`.env.local` and `.env` are loaded automatically, and the real environment wins over both. Commit `.env`
with safe defaults; keep `.env.local` gitignored.

`getRequestContext().env` is that same environment, plus the platform's own runtime bindings where it has
them — `deploy: 'cloudflare'`, where a KV namespace or a Worker secret arrives per request and wins over a
process variable of the same name. On every other target it is `process.env` alone: Hono's `c.env` there is
the adapter's private state rather than your bindings, so the framework does not merge it. `ctx.hono.env`
still reaches it if you need it.

Two things worth remembering:

- **Anything a server component renders is public.** Whatever is in the tree ships in the flight
  payload. The boundary protects `process.env`, not your JSX.
- **Keeping a server-only module out of the client bundle is the module graph's job.** For a hard
  failure if that slips, add React's `server-only` package — the RSC layer resolves its `react-server`
  condition, so importing it from client code throws.

## Security middleware

The framework runs no CSRF check, body cap or CSP of its own. All three are Hono middleware you
register in `src/server.ts`, which is mounted **ahead of the page routes** — so anything registered
there wraps page renders and server actions, not just your own handlers.

`create-rshono` scaffolds the first two into every new app. An app written by hand down to
`src/routes.ts` has neither until it adds them.

```ts
// src/server.ts
import { publicUrl } from '@rshono/core/server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';

const server = new Hono();

server.use(bodyLimit({ maxSize: 1024 * 1024 }));
server.use(csrf({ origin: (origin, c) => origin === publicUrl(c).origin }));

export default server;
```

**[`bodyLimit`](https://hono.dev/docs/middleware/builtin/body-limit)** caps a request body _before_ it is
buffered into memory and answers `413`. Registered here it covers every route, not just actions —
endpoint routes and your own handlers are equally exposed the moment they call `.json()` or
`.formData()`. An over-cap `Content-Length` is refused up front; a chunked body is cut off mid-stream.

**[`csrf`](https://hono.dev/docs/middleware/builtin/csrf)** rejects a cross-origin POST with 403 before it
can reach a server action. It layers `Sec-Fetch-Site` over `Origin`, and only inspects the content types
a browser can send cross-origin without a preflight — which is exactly the shape a server action arrives
in: `text/plain` for a client-initiated call, `multipart/form-data` for a no-JS form post. A JSON API
route is unaffected.

Pass `publicUrl(c)` rather than relying on the default same-origin comparison, which reads `c.req.url` —
the address the server was _reached_ on. Behind a proxy that terminates TLS or rewrites `Host` that is
the internal address, and a legitimate post would then be riding on `Sec-Fetch-Site` alone. `publicUrl`
honours [`trustProxy`](#proxy-headers), so it stays `c.req.url` where no proxy is declared. To allow
another origin:

```ts
server.use(
  csrf({
    origin: (origin, c) => origin === publicUrl(c).origin || origin === 'https://admin.example.com',
  }),
);
```

The check proves a request came from your own site. It says nothing about _who_ sent it — every
[`'use server'` export is a public endpoint](/docs/pages#every-action-is-a-public-endpoint).

Everything else Hono ships works the same way — `cors`, `basicAuth`, `jwt`, `ipRestriction`, `timeout`,
`requestId`, and [`secureHeaders`](#csp) below. A middleware that rejects by throwing an `HTTPException`
keeps its own status, rather than being rendered as the 500 page. See
[Hono & middleware](/docs/hono#security-middleware) for worked examples and
[Hono's docs](https://hono.dev/docs) for the full set.

## Proxy headers

`X-Forwarded-Host` and `X-Forwarded-Proto` are client-supplied and **not trusted by default**. Honouring
them blindly lets anyone who can reach the server dictate the origin of every absolute URL the app
builds, poisoning canonical tags, emails, redirects and any shared cache in front. Set
`trustProxy: true` only when a proxy you control sets them. `rshono dev` forces it on for its own
localhost-bound proxy.

It governs the browser-facing URL the framework builds — a page's `url` prop and
`getRequestContext().url`. Middleware is handed Hono's `c` and reads `c.req.url` on its own, so where a
middleware needs the public origin, give it `publicUrl(c)` from `@rshono/core/server`.

Leave it off on [`vercel`](/docs/deployment#vercels-request-handoff), where the request already arrives with the scheme
and host the browser used — that platform's edge sets them, and the function cannot be reached around
it. To be precise about that target: the **scheme** is taken from `X-Forwarded-Proto` whether or not
`trustProxy` is set, because there it is not client-supplied. The `Host` header is not part of the
exception. The setting is for a proxy you put in front yourself, which the framework cannot vouch for.

## Response headers and caching

A floor, on every response — including `/_static` assets, which your middleware never sees because they
are served before it:

```
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: SAMEORIGIN
```

Each is set only if nothing already did, so
[`secureHeaders()`](https://hono.dev/docs/middleware/builtin/secure-headers) in `src/server.ts` wins
wherever both apply. That is the way to add the rest — HSTS, COOP, CORP, `Permissions-Policy`.

A **dynamic page** is answered `Cache-Control: private, no-cache` — a page is request-specific by
default, and with no directives a shared cache is free to store one user's page and serve it to the
next. Set your own value from middleware and it is left alone. **Prerendered pages** keep
`public, max-age=300` and a weak `ETag`.

Those two values are not config fields: a cache policy is a per-response header, and `rshono.config.ts`
is compiled into the bundle, so a value you cannot change without a rebuild would be the wrong shape.
Middleware is the interface — and for a **prerendered** page it has to run **after `await next()`**:

```ts
// src/server.ts — a documentation site's prerendered tree, cached for a day
server.use('/docs/*', async (c, next) => {
  await next();
  c.res.headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
});
```

After, because the prerendered response is built with `cache-control` in the header bag, which replaces
anything `c.header(...)` prepared before the handler ran. A dynamic page is the easier case: its default
is applied only if nothing else set one, so `c.header(...)` before `await next()` works there. Editing
`c.res.headers` after works for both, leaves the `ETag` alone, and so keeps revalidation at a 304.

Every page response carries `Vary: RSC`, because one URL answers with either an HTML document or a flight
payload depending on that request header — the client runtime sends `RSC: 1` to ask for a payload. A header
of its own rather than `Accept`: a browser's `Accept` string differs by vendor and version, so a CDN keyed on
it would store a copy of a prerendered page per variant, and some shared caches refuse to store such a
response at all.

## CSP

A `Content-Security-Policy` comes from
[`secureHeaders()`](https://hono.dev/docs/middleware/builtin/secure-headers) in `src/server.ts`. With no
arguments it sets the rest of the usual set — HSTS, COOP, CORP, `nosniff`, `X-Frame-Options` — and no
CSP at all:

```ts
// src/server.ts
import { secureHeaders } from 'hono/secure-headers';

server.use(secureHeaders());
```

Put Hono's `NONCE` placeholder in `scriptSrc` and the policy becomes per-request: Hono mints a nonce and
rshono stamps that value onto the bootstrap scripts, the inlined flight payload and dynamically loaded
chunks.

```ts
// src/server.ts
import { NONCE, secureHeaders } from 'hono/secure-headers';

server.use(
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", NONCE],
      styleSrc: ["'self'", "'unsafe-inline'"], // React writes inline styles
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      // Not covered by default-src, and each closes an injection route of its own.
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  }),
);
```

Two things the framework does for you. React Refresh compiles updates with `eval`, so `script-src` is
widened with `'unsafe-eval'` under `rshono dev` and never in a build — one policy serves both. And while
a nonce is in play the document for a static route is
[rendered per request](/docs/routing#static-rendering), since a prerendered file is fixed bytes and
cannot carry a fresh one. That is decided per request: a policy with no `NONCE` in it keeps its
prerendered documents. The flight payload never carries a nonce and is served from the build either way.

Every directive, `Permissions-Policy` and the reporting headers are in
[Hono — Secure Headers](https://hono.dev/docs/middleware/builtin/secure-headers).

## Errors and redaction

Every error the framework catches goes through [`onServerError`](/docs/hono#error-reporting) and to
`stderr`. Thrown server-action errors are redacted in the production payload — React sends no message or
digest — so return values, not throws, for anything the user should see. The `error` page's `error` prop
is message-only in production, message plus stack in dev.

## No blank screens

Three fallbacks behind the `error` page, so a failure is always readable:

- An **uncaught client-side render error** makes React tear down its root — which here is the whole
  document. The runtime paints a fatal overlay instead: full stack in dev, a generic notice plus a
  reload button in production.
- If **SSR fails before the shell is sent**, the `error` page cannot be reached either, so the framework
  answers with its own visible 500 document. It attaches no client runtime deliberately: the flight
  payload came from the same failed render, and hydrating it would blank the message.
- A **client bootstrap failure** — a truncated or malformed initial payload — is reported and surfaced
  rather than becoming a silent unhandled rejection.
