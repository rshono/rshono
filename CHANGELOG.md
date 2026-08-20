# Changelog

All notable changes to `@rshono/core` and `@rshono/create`, which are released together and share a version.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). Each release is tagged `v<version>` and published
from a maintainer's machine with `pnpm release` — see CONTRIBUTING.md.

Releases before `1.0.0-rc.14` predate this file and are not reconstructed here; `git log` is the record for
those.

## [Unreleased]

### Added

- **`router.back()` and `router.forward()` on `useNavigation()`.** History traversal was left to
  `history.back()` / `history.forward()` on the grounds that the router added nothing to them; having the
  whole client-side routing API in one object is worth more than that. They are soft navigations like the
  rest — the runtime already picked a back-button press up through `popstate` — so `router.pending` covers
  them too.

## [1.0.0-rc.15] - 2026-08-13

### Fixed

- **Every request to a `vercel` deployment failed with `e.headers.get is not a function`.** The target handed
  the app off with `hono/vercel`'s `handle`, a pass-through that forwards its argument straight to `app.fetch`
  — but the Build Output API's `Nodejs` launcher invokes a function with `(IncomingMessage, ServerResponse)`
  rather than a web `Request`, so the app was given a Node request object and every page 500'd, an
  `onServerError` hook reading `new URL(request.url)` then failing on the bare `'/'` path. The
  `Request`/`Response` handler shape Vercel documents elsewhere belongs to its `@vercel/node` builder, which a
  `--prebuilt` upload never runs, so the handoff now converts the request itself. It reads `X-Forwarded-Proto`
  while doing so: TLS terminates at the edge, so the socket reports `http` for a request the browser made to
  `https`, and `ctx.url` would otherwise carry a scheme the app redirects to and compares origins against.
  This needs no `trustProxy` — on this target the header is set by an edge the function cannot be reached
  around.

## [1.0.0-rc.14] - 2026-08-13

### Fixed

- **`vercel` and `aws-lambda` produced deployments that could not boot.** Both targets upload a directory
  rather than install one, but the server bundle kept importing the app's dependencies from `node_modules` —
  so any app with a runtime dependency died at cold start on `ERR_MODULE_NOT_FOUND`. Both presets now bundle
  dependencies, as `cloudflare` already did. Native addons and packages that read their own files off disk
  cannot be bundled and now fail the build on these targets rather than the deploy.
- **A soft navigation could render the wrong page.** Two overlapping navigations were two unordered fetches:
  a slow first response landing after a fast second one repainted the page the user had left, under the URL of
  the one they asked for. Navigations are now sequenced, the superseded fetch is aborted, and only the
  navigation that settled the screen performs its scroll. A server action's payload is likewise no longer
  applied if a navigation moved on while it was in flight.
- **Production server stack traces were unmappable.** The server bundle is minified and shipped no source
  map, so everything reaching the `onServerError` funnel was minified frames. It now ships one, and the
  runtime enables Node's mapping itself so Vercel and Lambda need no flag. Client source maps stay off in a
  build.
- **A `'use client'` component from `node_modules` was SSR'd against the real `process.env`** while the browser
  bundle saw the `PUBLIC_`-only view — a hydration mismatch on anything the host sets, and a leak of anything
  secret straight into the HTML stream. Two separate things were wrong: the substitution was scoped to the app's
  own `src/`, and on the `node` target such a module was left external, so it was never compiled and no loader
  could reach it whatever the scope. The substitution now covers every module in the SSR layer, and those modules
  are compiled into the server bundle on every target — see **Changed** for what that means for a `node` build.
- **A thrown `redirect()` or `notFound()` from inside a bare `<Suspense>` left its abandoned render running.**
  The response was already being streamed when the signal arrived, and the correct redirect was sent, but the
  superseded render was neither aborted nor cancelled and ran to completion for a response nobody received.
- **The generated `aws-lambda` README told you to upload `node_modules`.** That target now compiles your
  dependencies into the bundle, so the deployment package is `dist/` and nothing else.
- **A thrown no-JS form action was reported as a `request` rather than an `action`**, so the progressive
  enhancement path attributed its errors to the wrong stage. It is now reported as an action, and
  `onServerError` de-duplicates, so one fault is reported once however many stages it crosses.
- **The prerendered page cache was bounded by entry count, not size** — 128 entries of half-megabyte pages
  retained ~64 MB with nothing about the number to suggest it. It now holds a byte budget (32 MB).
- **`rshono build` could truncate its own output**, since a piped stdout is asynchronous and the process
  exited without draining it. In CI that dropped the lines saying what was built.

### Added

- **A build-time check that `react` and `react-dom` resolve to the same version.** RSC couples them across
  bundles, so a split resolution fails inside minified React at render time; the build now refuses it by name
  and points at the override key. A different minor than the framework was tested with is a warning.
- **A cross-site form post can no longer reach a server action.** A `<form action={serverAction}>` post is the
  only action shape a browser can be made to send from another site — the client-initiated one carries a
  header that forces a preflight — so the framework refuses it whether or not `csrf()` is registered. This is
  not a CSRF policy; `csrf()` in `src/server.ts` remains that, and covers everything else.
- **A build warning when `src/server.ts` is absent**, naming the CSRF check and the body cap the app has
  therefore opted out of.
- `SECURITY.md`, `CONTRIBUTING.md`, this changelog, issue templates, Dependabot, and a tag-triggered release
  workflow that publishes with npm provenance.

### Changed

- **The licence is MIT**, with the text shipped at the repo root and inside both published packages. The
  manifests declared ISC up to and including `rc.13` and carried no licence text anywhere, so no release has
  ever actually stated ISC terms. MIT is what the frameworks this one is compared against use, and the one a
  corporate review recognises on sight.
- **On the `node` target, anything reachable from a `'use client'` component is now compiled into the server
  bundle** rather than left external. It has to be for the env substitution above to apply at all — a loader
  cannot rewrite a module the bundle only imports by name. A server component's dependencies still resolve from
  `node_modules`, so a native addon on the server is unaffected. Nothing is given up on the client side: those
  same modules are in the browser bundle already, so they were always required to be bundleable.
- **`public/` is no longer copied inside the Vercel function.** It goes to the static output, which the
  platform's filesystem handler answers before the function is invoked, so the second copy was upload size and
  cold-start unpack time that nothing could ever read.
- **The flight-payload discriminator is now an `RSC: 1` request header, and page responses `Vary: RSC`.** It
  was `Accept: text/x-component` with `Vary: Accept` — correct content negotiation, and close to a
  cache-disabling header on the prerendered pages served `public, max-age=300`, because browsers send long
  `Accept` strings that differ by vendor and version. The new header has two states. This is internal to the
  client runtime and the server, which ship together; a client outside the framework asking for a payload by
  `Accept` needs updating.
- `.vc-config.json`'s Node runtime is derived from the Node the build ran on, rather than pinned to
  `nodejs22.x` — which would have started failing on a date the framework does not control.
- `rshono start` runs the build in its own process instead of spawning a child. The child only ever existed to
  pass `--enable-source-maps`, which the CLI already enables in-process.
- The generated `eslint.config.mjs` explains why an ESLint app pins TypeScript below the version rshono builds
  with, and that `lint:fix` therefore wants a `typecheck` after it.
