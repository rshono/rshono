---
title: Deployment
description: Four targets behind one interface, how the build produces them, and the known limitations.
---

`rshono build` targets one platform. Pick it with `deploy` in the config, `--deploy <name>` or
`RSHONO_DEPLOY`, in that precedence order. The default is `node`. `rshono dev` always runs the Node dev
server whatever you choose.

## The targets

| `deploy`     | Handoff                          | Assets & prerendered pages                                      | After `build`                               |
| ------------ | -------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `node`       | binds a port                     | from `dist/` on disk                                            | `rshono start`                              |
| `cloudflare` | `{ fetch }` default export       | Workers Assets; prerendered pages read via the `ASSETS` binding | `wrangler deploy`                           |
| `vercel`     | web handler in a Node function   | CDN for assets; prerendered pages inside the function           | `vercel deploy --prebuilt`                  |
| `aws-lambda` | streaming handler (Function URL) | from the deployment package                                     | zip `dist/`, handler `dist/server/main.mjs` |

**Every target streams** — a page's HTML reaches the browser as it renders. That is the bar a new target
has to clear. Bun and Deno run the `node` build through their `node:` compatibility
(`bun dist/server/main.mjs`), so neither needs a preset of its own.

`rshono start` refuses a build made for another platform rather than starting a bundle with no listener
in it.

## Cloudflare

A Worker resolves no `node_modules` at runtime, so the build bundles **all** dependencies; one that
needs a real `node:` API beyond `nodejs_compat` will not work. The build scaffolds a `wrangler.jsonc` if
the project has none — including `nodejs_compat`, which the request context needs for
`AsyncLocalStorage` — and never touches it again.

Its `compatibility_date` is a fixed date behind the released wranglers, not the day it was generated: wrangler
bundles the workerd it shipped with, and that binary refuses a date newer than its own, so a config dated today
would deploy fine and break `wrangler dev`.

Bindings (D1, KV, R2) arrive as `getRequestContext().env`. They are not available under `rshono dev`,
which is plain Node.

## AWS

A Lambda Function URL with the invoke mode set to `RESPONSE_STREAM`, usually with CloudFront in front for
`/_static` and `public/`. **Lambda@Edge is deliberately not a target**: CloudFront returns the response
as a value rather than a stream, caps a generated origin-request response near 1 MB, and supports no
environment variables, so `getRequestContext().env` would be empty there.

## Prerendered pages are never CDN-served

One URL answers with an HTML document or a flight payload depending on the `RSC` request header, and a
path-keyed CDN cannot choose. The app always handles page URLs. Assets under `/_static` and `public/` do go
straight to the CDN where there is one.

## How the build works

Two coordinated Rspack compilers, using native RSC support (`rspack.experiments.rsc`):

- **client** (`target: web`) → `dist/static`: hydration runtime, `'use client'` chunks, CSS.
- **server** (`target: node`) → `dist/server/main.mjs`: a Hono app assembled from your routes, rendered
  through two layers — the RSC layer, with the `react-server` condition, produces the flight payload;
  the SSR layer turns it into an HTML stream with the payload inlined for hydration.

Everything in that bundle that depends on _where_ it runs — binding a port, serving `/_static` and
`public/`, reading a prerendered page, loading `.env` — sits behind a single interface the build resolves
per target. The request-handling code has no platform in it.

In development the CLI watches both bundles and runs the server bundle **in a worker thread**, restarted
per rebuild, with requests gated on readiness so nothing drops across a restart. Client edits hot-apply
via react-refresh; server component edits re-fetch the payload in place. Browser state survives both.

In production `dist/server/main.mjs` is self-contained — React, Hono and the framework are bundled in;
your other dependencies resolve from `node_modules`.

## Limitations

- **No compression.** It belongs in a proxy, a load balancer or a CDN, and every hosted target already
  does it. `hono/compress` in `src/server.ts` if you need it in-process — read its docs on streaming
  first, because a buffering compressor undoes streamed SSR.
- **No base path.** `siteUrl` must be a bare origin.
- **Wildcard, optional and regex params cannot be prerendered.**
- **The dev-mode proxy does not forward WebSocket upgrades** to a custom sub-app. Production is
  unaffected.
- **Dev source maps embed the original source of `'use server'` modules.** Dev binds to 127.0.0.1 only,
  and production ships no client source maps.
