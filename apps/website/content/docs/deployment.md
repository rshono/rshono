---
title: Deployment
description: The settings each platform asks for, four targets behind one interface, and the known limitations.
---

`rshono build` targets one platform. Pick it with `deploy` in the config, `--deploy <name>` or
`RSHONO_DEPLOY`, in that precedence order. The default is `node`. `rshono dev` always runs the Node dev
server whatever you choose.

Each platform below leads with the settings its dashboard asks for, which is what importing a Git
repository puts in front of you. Commands are written for npm — substitute your package manager
(`pnpm build`, `yarn build`, `bun run build`).

## The targets

| `deploy`     | Handoff                          | Assets & prerendered pages                                      | After `build`                               |
| ------------ | -------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `node`       | binds a port                     | from `dist/` on disk                                            | `rshono start`                              |
| `cloudflare` | `{ fetch }` default export       | Workers Assets; prerendered pages read via the `ASSETS` binding | `wrangler deploy`                           |
| `vercel`     | Node `(req, res)` listener       | CDN for assets; prerendered pages inside the function           | `vercel deploy --prebuilt`                  |
| `aws-lambda` | streaming handler (Function URL) | from the deployment package                                     | zip `dist/`, handler `dist/server/main.mjs` |

**Every target streams** — a page's HTML reaches the browser as it renders. That is the bar a new target
has to clear. Bun and Deno run the `node` build through their `node:` compatibility
(`bun dist/server/main.mjs`), so neither needs a preset of its own.

## Node

The default, and what any host that runs a Node process wants: a VPS, a container, or a PaaS such as
Render, Railway, Fly or App Platform. There is no single dashboard, but they all ask for the same four
things.

| Setting             | Value           |
| ------------------- | --------------- |
| Install Command     | `npm install`   |
| Build Command       | `npm run build` |
| Start Command       | `npm start`     |
| Development Command | `npm run dev`   |
| Node.js version     | 22.18 or newer  |

- The host has to hand the process a **`PORT`**, which rshono binds; `HOST` is honoured too and defaults
  to `0.0.0.0`. `PORT=0` means any free port rather than the default.
- `npm start` runs `rshono start`, which runs the build that already exists and never makes one. It
  refuses a build made for another target rather than starting a bundle with no listener in it.
- In a Dockerfile the same pair: `RUN npm run build`, then `CMD ["npm", "start"]`.

## Vercel

Import the repository, then set these under **Settings → Build and Deployment → Build & Development
Settings**. Only the first two need changing.

| Setting             | Value                                                     |
| ------------------- | --------------------------------------------------------- |
| Framework Preset    | **Other**                                                 |
| Build Command       | `npm run build` — Override **on**                         |
| Output Directory    | leave Override **off**                                    |
| Install Command     | leave Override **off** (auto-detected from your lockfile) |
| Development Command | leave empty                                               |
| Root Directory      | the app's directory — repo root unless this is a monorepo |
| Node.js Version     | 22.x or newer                                             |

- **Framework Preset has to be Other.** Vercel ships a Hono preset and detects `hono` in your
  dependencies, so the default guess is wrong for a rshono app and will fight the build.
- **Do not override Output Directory to an empty value.** That is Vercel's documented way to say _skip
  the build step_, and it would ship your repository instead of your app. The build writes
  `.vercel/output` — the function, the static assets and the routing table, a complete deployment — and
  that is what gets served.
- **There is no start command.** The platform invokes the function per request; nothing binds a port,
  and `rshono start` refuses this build.
- **Development Command** only affects `vercel dev`, which this target gains nothing from — run
  `npm run dev`. If you want `vercel dev` anyway it needs `npm run dev -- --port $PORT`, because the
  default under the Other preset is empty and `vercel dev` fails without one.
- **Node.js Version** decides the function's runtime, not just the build's: the build records the major
  it ran on so the app runs the runtime it was tested against.

Deploying from your machine or from CI instead of the Git integration:

```sh
npm run deploy
```

That is `rshono build && vercel deploy --prebuilt --prod`. `--prebuilt` uploads what the build
assembled, so the platform runs no build of its own; drop `--prod` for a preview URL. From CI it also
needs `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and a CLI token in the environment.

`npm run preview` answers the production build locally, but note what it is: a **Node** build run here,
because the platform is what runs its own prebuilt output and your machine cannot.

`ctx.url` is correct here without [`trustProxy`](/docs/configuration#proxy-headers) — see
[Vercel's request handoff](#vercels-request-handoff).

## Cloudflare

Deploy as a **Worker**, not a Pages project. Create the Worker, connect the repository, then set these
under **Settings → Builds**.

| Setting                              | Value                                                     |
| ------------------------------------ | --------------------------------------------------------- |
| Build command                        | `npm run build`                                           |
| Deploy command                       | `npx wrangler deploy` — the default                       |
| Non-production branch deploy command | `npx wrangler versions upload` — the default              |
| Root directory                       | the app's directory — repo root unless this is a monorepo |

- **There is no install command or output directory field.** Cloudflare installs dependencies from your
  lockfile, and `wrangler.jsonc` is what says where the build went.
- **Commit `wrangler.jsonc`.** The first build scaffolds one if the project has none — including
  `nodejs_compat`, which the request context needs for `AsyncLocalStorage` — and never touches it again,
  so it is yours to edit after that.
- **Bindings** (D1, KV, R2) arrive as `getRequestContext().env`. They are not available under
  `rshono dev`, which is plain Node — `npm run preview` builds and runs the app in workerd via
  `wrangler dev`, which is the only preview that executes the real thing.

`npm run deploy` does the build and the upload in one step from your machine.

## AWS Lambda

There is no settings page here; the upload is yours to script.

| Step        | Value                               |
| ----------- | ----------------------------------- |
| Install     | `npm ci`                            |
| Build       | `npm run build`                     |
| Package     | `dist/` and nothing else            |
| Handler     | `dist/server/main.mjs`              |
| Invoke mode | Function URL, **`RESPONSE_STREAM`** |

A buffered invoke mode deploys fine and then holds every page until its last byte has rendered, so
`RESPONSE_STREAM` is not optional. CloudFront usually sits in front for `/_static` and `public/`.

Your dependencies are compiled into the bundle for this target, so no `node_modules` is uploaded —
which also means a native addon fails the build here rather than the deploy.

`npm run preview` is the local check, and as on Vercel it is a **Node** build run here rather than an
emulation of the Lambda handler.

## Advanced

### How the build works

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

### Prerendered pages are never CDN-served

One URL answers with an HTML document or a flight payload depending on the `RSC` request header, and a
path-keyed CDN cannot choose. The app always handles page URLs. Assets under `/_static` and `public/` do go
straight to the CDN where there is one.

### Your dependencies, per target

In production `dist/server/main.mjs` always has React, Hono and the framework bundled in. What happens to
**your** dependencies is a property of the target:

- On **`node`** a server component's dependencies stay external and resolve from the `node_modules` beside the
  build, which is where the process runs.
- On **`cloudflare`, `vercel` and `aws-lambda`** they are bundled in too. A function is an uploaded directory
  rather than an installed one, so there is no `node_modules` at request time and an external
  `import 'some-package'` would be a cold start that dies on `ERR_MODULE_NOT_FOUND`.
- On **every target**, anything a `'use client'` component reaches is bundled. The `PUBLIC_`-only
  `process.env` view those modules are server-rendered against is applied by a loader, and a loader cannot run
  on a module the bundle only imports by name — left external, a third-party client component would be SSR'd
  against the real environment, leaking whatever it reads and disagreeing with hydration. This costs nothing:
  the same module ships in the browser bundle, so it was always required to be bundleable.

The cost on those three: a dependency that cannot be bundled — a native addon, or one that reads its own
files off disk relative to `__dirname` — fails the **build** rather than the deploy. Reach for the `rspack`
hook in `rshono.config.ts` to keep such a package external, or deploy it to `node`.

A Worker has a further constraint: it resolves no `node_modules` at runtime either way, and a dependency
needing a real `node:` API beyond `nodejs_compat` will not work there at all.

### Vercel's request handoff

The function is a Node `(req, res)` listener, because that is what the Build Output API's `Nodejs`
launcher calls — the whole of its Node contract. The `Request`/`Response` handler shape Vercel documents
elsewhere belongs to its `@vercel/node` builder, which compiles a source file and wraps it, and a
prebuilt upload never runs that. So the handoff converts the request itself.

TLS terminates at the edge and the function is reached over plain HTTP, so the socket reports `http` for
a request the browser made to `https`. `X-Forwarded-Proto` is what actually says which scheme was used,
and the request the app sees is built from it — otherwise `ctx.url` would carry a scheme the app then
redirects to and compares origins against. This needs no
[`trustProxy`](/docs/configuration#proxy-headers): on this target the header is not client-supplied,
since the function is only reachable through Vercel's edge.

### Cloudflare's compatibility date

The scaffolded `wrangler.jsonc` carries a fixed date behind the released wranglers, not the day it was
generated: wrangler bundles the workerd it shipped with, and that binary refuses a date newer than its
own, so a config dated today would deploy fine and break `wrangler dev`.

### Why Lambda@Edge is not a target

CloudFront returns the response as a value rather than a stream, caps a generated origin-request response
near 1 MB, and supports no environment variables, so `getRequestContext().env` would be empty there. All
three are deliberate exclusions rather than gaps.

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
