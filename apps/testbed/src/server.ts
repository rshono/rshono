import { onServerError, publicUrl } from '@rshono/core/server';
// A dependency outside the set the framework bundles unconditionally — so the serverless targets, which
// upload a directory rather than install one, have something real to prove they bundled. See the endpoint
// at the bottom of this file and `assertSelfContained` in packages/core/test/deploy-targets.test.mjs.
// Unscoped on purpose: the externals policy bundles anything under `@rshono/` unconditionally, so a
// scoped name here would be bundled whatever the preset decided and prove nothing.
import { EXTERNAL_DEP_MARKER } from 'rshono-test-external-dep';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { requestId } from 'hono/request-id';
import { NONCE, secureHeaders } from 'hono/secure-headers';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { fakeDB } from './db';

/**
 * What this app's middleware puts on the Hono context. Pass it to `PageProps<path, AppEnv>` (or
 * `getRequestContext<AppEnv>()`) and `ctx.var` is typed key-by-key instead of an open record — see
 * `components/dashboard.tsx`.
 *
 * `requestId` is declared here for the demonstration; `hono/request-id` also augments Hono's
 * `ContextVariableMap` with it globally, so this one is free either way. A variable of your own is
 * what actually needs the declaration.
 */
export type AppEnv = { Variables: { requestId: string }; Bindings: { DATABASE_URL: string } };

const server = new Hono<AppEnv>();
const startedAt = Date.now();

/**
 * How hard this instance is locked down. Every control below is Hono middleware rather than a
 * framework setting, so one build serves every profile and the suite picks one per start — which is
 * the point: these are request-time decisions, and nothing about them needs to be baked into a
 * bundle. A real app would pick once and delete the branching.
 */
const hardened = process.env.TESTBED_CSP === '1';
const csrfEnabled = process.env.TESTBED_CSRF !== 'off';
const maxBodyBytes = Number(process.env.TESTBED_BODY_LIMIT ?? 1024 * 1024);
/** Cross-origin hosts allowed to post actions, beyond this app's own origin. */
const allowedOrigins = (process.env.TESTBED_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);

// Where an error tracker goes. Registered at module load — src/server.ts is imported as the server
// starts — so every error the framework catches (a thrown action, a failed render, SSR falling
// over) reaches one place. A real app would call Sentry.captureException here instead of logging.
//
// `hono` and `waitUntil` are used deliberately rather than for the demonstration. `hono.var` is the only
// way to reach a request id from here — a `source: 'request'` error is reported from the top-level
// handler, outside the ambient context `getRequestContext()` needs — and `waitUntil` is what keeps a
// serverless invocation alive until an asynchronous report has actually been sent.
onServerError<AppEnv>((error, { source, request, hono, waitUntil }) => {
  const message = error instanceof Error ? error.message : String(error);
  waitUntil(
    Promise.resolve().then(() => {
      console.log(`[error-reporter] ${source} ${new URL(request.url).pathname} #${hono.var.requestId}: ${message}`);
    }),
  );
});

server.use(trimTrailingSlash({ alwaysRedirect: true }));

// A memory-exhaustion guard for everything downstream — pages and server actions, endpoint routes
// and the API handlers below alike, since anything that buffers a body (`.json()`, `.formData()`)
// is exposed. Rejects an over-cap `Content-Length` up front and otherwise counts the stream, so a
// chunked or under-reported body is cut off too.
if (maxBodyBytes > 0) {
  server.use(bodyLimit({ maxSize: maxBodyBytes }));
}

// CSRF: rejects a cross-origin POST with 403 before it can reach a server action. Hono checks
// `Sec-Fetch-Site` and `Origin` and only inspects the form-ish content types a browser can send
// cross-origin without a preflight — which is exactly what a server action arrives as, `text/plain`
// for a client-initiated call and `multipart/form-data` for a no-JS form post.
//
// `publicUrl(c)` rather than Hono's default same-origin comparison, which reads `c.req.url` — the
// address the server was *reached* on. Behind a proxy that terminates TLS or rewrites `Host` that is
// the internal one, and a legitimate post would be refused whenever the browser did not also send a
// `Sec-Fetch-Site` to settle it. `rshono dev` is exactly such a proxy, so this is not a
// production-only concern. Honours `trustProxy`, so it is still `c.req.url` where no proxy is declared.
if (csrfEnabled) {
  server.use(csrf({ origin: (origin, c) => origin === publicUrl(c).origin || allowedOrigins.includes(origin) }));
}

// A strict nonce-based CSP. `NONCE` is what makes it per-request: Hono mints a nonce, puts it on the
// context, and rshono stamps that value onto the bootstrap scripts and the `<meta>` React hydrates
// from. A `render: 'static'` route falls back to rendering per request while this is on, because a
// prerendered file is fixed bytes and cannot carry a fresh nonce.
//
// Nothing here mentions `'unsafe-eval'`: rshono widens `script-src` with it under `rshono dev`, where
// React Refresh needs it, and never in a build.
if (hardened) {
  server.use(
    secureHeaders({
      // Overridden because Hono's default is `no-referrer`, and the framework's floor — which this
      // replaces wherever both apply — is the friendlier `strict-origin-when-cross-origin`.
      referrerPolicy: 'strict-origin-when-cross-origin',
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", NONCE],
        // React writes inline styles, so this one cannot be tightened.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://images.example'],
        connectSrc: ["'self'"],
        // None of these are covered by default-src, and each closes an injection route of its own: a
        // stray <base> retargeting every relative URL, plugin content, framing, off-site form posts.
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
      },
    }),
  );
}

// The sub-app is mounted ahead of the page routes, so a variable set here is readable from a page as
// `ctx.var.requestId` — this is what typing `PageProps` with `AppEnv` buys. `hono/request-id` also
// echoes an inbound `X-Request-Id` back, so a trace id from a load balancer survives.
server.use(requestId());

server.use('*', async (c, next) => {
  const start = performance.now();
  await next();
  const end = performance.now();
  c.res.headers.set('X-Response-Time', `${(end - start).toFixed(2)} ms`);
});

/** Reads a value out of a real `node_modules` dependency — see the import at the top of this file. */
server.get('/api/external-dep', (c) => c.text(EXTERNAL_DEP_MARKER));

/**
 * The URL the request arrived as, which is a property of the *handoff* rather than of any route: a target
 * whose platform hands the app something other than a web `Request` has to build one, and this is what it
 * built. Deliberately `c.req.url` and not `publicUrl(c)`, so the assertion is about the request itself
 * rather than about the proxy correction layered on top of it.
 */
server.get('/api/request-url', (c) => c.text(c.req.url));

server.get('/api/health', (c) => {
  return c.json({ status: 'ok', uptime: (Date.now() - startedAt) / 1000, timestamp: Date.now() });
});

server.get('/api/users', async (c) => {
  const users = await fakeDB.listUsers();
  return c.json({ users });
});

server.post('/api/users', async (c) => {
  const body = await c.req.json<{ name: string; email: string }>();
  const user = await fakeDB.createUser(body);
  return c.json({ user }, 201);
});

server.get('/api/users/:id', async (c) => {
  const id = c.req.param('id');
  const user = await fakeDB.getUser(id);
  if (!user) {
    return c.json({ error: 'Not found' }, 404);
  }

  return c.json({ user });
});

export default server;
export type AppType = typeof server;
