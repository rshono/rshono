# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub's
[security advisories](https://github.com/rshono/rshono/security/advisories/new), or by email to
lasse@lassetange.com.

A useful report says what an attacker can do, and how you know. If you have one, a minimal app that
reproduces it is worth more than anything else — `npx @rshono/create@latest` plus the smallest diff that
shows the problem. Include the rshono version, the Node version and the deploy target: several of the
framework's boundaries are implemented per platform, so `cloudflare` and `node` can differ.

You will get an acknowledgement within **3 working days** and an assessment within **7**. If a report is
valid, you will hear what the fix is and when it ships before it does, and you will be credited in the
advisory and the changelog unless you would rather not be.

## Supported versions

The latest published release of `@rshono/core` gets security fixes. There are no long-term support
branches: rshono pins `@rspack/core` and `react-server-dom-rspack` to exact versions and a release is what
moves them, so a fix backported onto an older pin has not been tested against anything.

## What is in scope

The framework owns four boundaries, and a defect in any of them is a vulnerability rather than a bug:

- **The env split.** A `PUBLIC_`-prefixed variable is meant to be the only thing that can reach the browser,
  in the client bundle and in SSR'd output alike. Anything that gets a non-prefixed variable into either is
  in scope. The one route the framework cannot cover is a read through the global object —
  `globalThis.process.env`, `global.process.env` — because the SSR-side shadow replaces the `process`
  _binding_, which `globalThis.process` goes around. The build warns when a module under `src/` does that;
  read `process.env` directly and the shadow applies.
- **Server action dispatch.** Every `'use server'` export is a public HTTP endpoint by design — that is
  documented, and authenticating inside the action is the app's job. What is _not_ by design: running an
  action the request did not name, running one from a form post made by another origin, or leaking a thrown
  action's message to the client in production.
- **The request context.** `getRequestContext()` resolves per request through `AsyncLocalStorage`. Anything
  that makes one request see another's context, cookies or env is in scope.
- **Prerendered page serving and the response defaults.** Path traversal into the prerender store, a `Vary`
  or `Cache-Control` that lets a shared cache hand one user's page to another, or a redacted error surfacing
  its real message in a production build.

## What is not in scope

- **An app's own middleware, or its absence.** Per-request security is Hono middleware in `src/server.ts` —
  `csrf()`, `bodyLimit()`, `secureHeaders()` — and `create-rshono` scaffolds it. An app that removed it is
  not a framework vulnerability. (The one exception the framework does enforce is a form post to a **page
  route** from another origin — a sibling subdomain included, since `Sec-Fetch-Site: same-site` is what a
  browser labels that — which it refuses whether or not `csrf()` is registered. All of them, in every
  `enctype` a browser form can send: a form post to a page is how a server action is called, and which posts
  carry one cannot be known without reading the body.)

  The _other_ action shape has no such rule and needs none, which is worth writing down because it is
  load-bearing: a client-initiated action call is selected by the `x-rsc-action` request header, and that is
  not a CORS-safelisted header. A page on another origin cannot send one without a successful preflight, and
  the framework answers no preflight, so that shape cannot be forged from a browser at all. An app that adds
  `cors()` middleware permissive enough to allow `x-rsc-action` from another origin has taken that defence
  away and is asking for exactly what it asked for; `csrf()` is what should still be standing behind it.

- **Anything reachable only with `trustProxy: true` and no proxy stripping the headers.** That setting is
  documented as "only behind a proxy you control".
- **Dev-server behaviour.** `rshono dev` binds `127.0.0.1`, serves unminified source and widens `script-src`
  with `'unsafe-eval'` for React Refresh. It is not a production server and is not hardened as one.
- **Upstream defects in React, Rspack, Hono or `react-server-dom-rspack`.** Report those to their projects;
  tell us too, and the pin will move once a fix is out.
