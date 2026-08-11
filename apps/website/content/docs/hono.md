---
title: Hono & middleware
description: src/server.ts is a Hono sub-app — middleware, endpoints, end-to-end types, error reporting.
---

There is a whole Hono app under the pages, and it is yours. `src/server.ts` may default-export a sub-app:
any method, streaming, cookies, middleware.

```ts
import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';

export type AppEnv = { Variables: { requestId: string } };

const server = new Hono<AppEnv>();

server.use(trimTrailingSlash({ alwaysRedirect: true }));

server.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});

server.get('/api/health', (c) => c.json({ status: 'ok', requestId: c.var.requestId }));

export default server;
export type AppType = typeof server;
```

The sub-app is mounted at `/` **ahead of the page routes**, so its middleware — auth, logging,
trailing-slash — wraps page requests too.

The flip side: a _terminal_ handler at the same path as a page route **shadows the page**. Middleware
that calls `next()` is fine; a handler that returns a response is not.

## Security middleware

Because the sub-app wraps page requests, this is also where the app's security controls go. The
framework ships none of its own — Hono's are better tested than anything rshono would write, and a
config field would only be a worse way to spell the same call. `create-rshono` puts the first two in
every new app.

### Request-body limit

Caps a body _before_ it is buffered into memory and answers `413`. Registered here it covers
everything downstream — pages, server actions and your own handlers — since any of them is exposed the
moment it calls `.json()` or `.formData()`:

```ts
import { bodyLimit } from 'hono/body-limit';

server.use(bodyLimit({ maxSize: 1024 * 1024 })); // 1 MiB
```

An over-cap `Content-Length` is refused up front; a chunked body is cut off mid-stream. Raise it on
one path rather than globally where you accept uploads:

```ts
server.use('/api/upload', bodyLimit({ maxSize: 50 * 1024 * 1024 }));
```

[Hono — Body Limit](https://hono.dev/docs/middleware/builtin/body-limit)

### CSRF

Rejects a cross-origin POST with 403 before it can reach a server action:

```ts
import { publicUrl } from '@rshono/core/server';
import { csrf } from 'hono/csrf';

server.use(csrf({ origin: (origin, c) => origin === publicUrl(c).origin }));
```

Use `publicUrl(c)` rather than Hono's default same-origin comparison, which reads `c.req.url` — the
address this server was _reached_ on, which is the internal one behind any proxy, `rshono dev`
included. It honours [`trustProxy`](/docs/configuration#proxy-headers), so it stays `c.req.url` where
no proxy is declared. To allow more origins:

```ts
server.use(
  csrf({
    origin: (origin, c) => origin === publicUrl(c).origin || origin === 'https://admin.example.com',
  }),
);
```

It only inspects the content types a browser can send cross-origin without a preflight — which is
exactly the shape a server action arrives in, so a JSON API route is unaffected.

[Hono — CSRF](https://hono.dev/docs/middleware/builtin/csrf)

### Security headers and CSP

`secureHeaders()` with no arguments sets a sensible set — HSTS, COOP, CORP, `nosniff`,
`X-Frame-Options` and more:

```ts
import { secureHeaders } from 'hono/secure-headers';

server.use(secureHeaders());
```

Add Hono's `NONCE` placeholder to `scriptSrc` and the CSP becomes per-request: Hono mints the nonce,
and rshono stamps that value onto the bootstrap scripts and the inlined flight payload.

```ts
import { NONCE, secureHeaders } from 'hono/secure-headers';

server.use(
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", NONCE],
      styleSrc: ["'self'", "'unsafe-inline'"], // React writes inline styles
    },
  }),
);
```

Nothing there mentions `'unsafe-eval'`: React Refresh needs it, so rshono widens `script-src` under
`rshono dev` and never in a build — one policy serves both. See [CSP](/docs/configuration#csp) for the
full policy and what a nonce costs a static route.

[Hono — Secure Headers](https://hono.dev/docs/middleware/builtin/secure-headers)

### Rejections keep their status

Middleware that refuses a request by throwing an `HTTPException` — `csrf()` with a 403, `bodyLimit()`
with a 413, your own guard — is handed straight back rather than rendered as the 500 page:

```ts
import { HTTPException } from 'hono/http-exception';

server.use('/admin/*', async (c, next) => {
  if (!c.req.header('authorization')) throw new HTTPException(401, { message: 'Unauthorized' });
  await next();
});
```

One gap: `/_static` assets are served before the sub-app is reached, so middleware never sees them. The
framework sets `nosniff`, `Referrer-Policy` and `X-Frame-Options` on
[every response](/docs/configuration#response-headers-and-caching) to cover them, and stands aside
wherever your own `secureHeaders()` set the same header.

## Other middleware worth knowing

Everything Hono ships works here, because this really is a Hono app. The ones that come up most:

| Middleware                                                                 | For                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`cors`](https://hono.dev/docs/middleware/builtin/cors)                    | Cross-origin access to your `{ type: 'endpoint' }` API routes       |
| [`basicAuth`](https://hono.dev/docs/middleware/builtin/basic-auth)         | Password-gating a staging deploy or an admin path                   |
| [`bearerAuth`](https://hono.dev/docs/middleware/builtin/bearer-auth)       | Static-token auth on an API route                                   |
| [`jwt`](https://hono.dev/docs/middleware/builtin/jwt)                      | Verifying a JWT and putting its payload on `c.var.jwtPayload`       |
| [`requestId`](https://hono.dev/docs/middleware/builtin/request-id)         | A trace id per request, readable from a page as `ctx.var.requestId` |
| [`logger`](https://hono.dev/docs/middleware/builtin/logger)                | Method, path, status and duration per request                       |
| [`timeout`](https://hono.dev/docs/middleware/builtin/timeout)              | Refusing a request that outruns a deadline                          |
| [`ipRestriction`](https://hono.dev/docs/middleware/builtin/ip-restriction) | Allow/deny lists in front of an internal route                      |
| [`trailingSlash`](https://hono.dev/docs/middleware/builtin/trailing-slash) | Keeping `/about` and `/about/` from being two pages                 |

Three exceptions, where the framework already owns the job or the two do not mix:

- **`etag`** digests the whole response before sending it, so it would buffer a streaming page render
  end to end. Prerendered pages already carry a weak `ETag` and answer `304`.
- **`serveStatic`** is unnecessary — `/_static` and `public/` are mounted for you.
- **`jsxRenderer`** is for Hono's own JSX; here React owns rendering.

The full list is in [Hono's docs](https://hono.dev/docs), alongside its helpers —
[`cookie`](https://hono.dev/docs/helpers/cookie), `proxy`, `streaming`, `testing` and the rest.

## Typing the context

The `Env` given to the Hono app is the same one that types `ctx` on a page. Pass it to `PageProps` and
`ctx.var` is typed key by key instead of being an open record:

```tsx
import type { PageProps } from '@rshono/core';
import type { AppEnv } from '../server';

export default function Home({ ctx }: PageProps<'/', AppEnv>) {
  return <p>Request {ctx.var.requestId}</p>; // typed
}
```

## Response headers and cookies

Middleware is where a page's response headers belong. A page renders too late to set one — its response
head is committed before the component runs, so [`ctx.setHeader()` throws
there](/docs/api#writes-happen-before-the-render). Middleware runs first, and gets Hono's `c` directly:

```ts
import { setCookie } from 'hono/cookie';

server.use('/blog/*', async (c, next) => {
  await next();
  c.header('cache-control', 'public, max-age=600, s-maxage=3600');
});

server.use('*', async (c, next) => {
  if (!c.req.header('cookie')?.includes('visitor=')) setCookie(c, 'visitor', crypto.randomUUID(), { path: '/' });
  await next();
});
```

Matching on a path pattern is deliberate: one middleware covers a group of routes, so caching policy
lives in one place rather than being repeated on every route that shares it.

`getRequestContext()` is **not** available in middleware or in `{ type: 'endpoint' }` routes — the
request context is bound around the render and the actions it runs, not around the whole Hono stack.
Neither needs it: both are handed `c`, which is a superset.

For a header that depends on a mutation rather than on the route — a session cookie after login — use a
[server action](/docs/pages#cookies-and-headers) instead.

## End-to-end types for a client

`export type AppType = typeof server` gives typed paths, params and responses with `hono/client`,
checked against the handlers themselves:

```ts
import { hc } from 'hono/client';
import type { AppType } from './server';

const client = hc<AppType>('/');
const res = await client.api.health.$get();
```

## Error reporting

One handler, registered at the top level of `src/server.ts`, catches every error the framework sees — a
thrown action, a failed render, SSR falling over, anything reaching the top-level handler:

```ts
import { onServerError } from '@rshono/core/server';

onServerError((error, { source, request }) => {
  Sentry.captureException(error, { tags: { source }, extra: { url: request.url } });
});
```

`source` is `'action' | 'render' | 'ssr' | 'request'`. Errors keep going to `stderr` either way, and a
handler that throws is caught rather than failing the request.
