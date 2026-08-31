# Changelog

All notable changes to `@rshono/core` and `@rshono/create`, which are released together and share a version.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). Each release is tagged `v<version>` and published
from a maintainer's machine with `pnpm release` — see CONTRIBUTING.md.

Releases before `1.0.0-rc.14` predate this file and are not reconstructed here; `git log` is the record for
those.

## [Unreleased]

### Changed

- **`@rspack/core` 2.1.7 → 2.2.0 and `react-server-dom-rspack` 0.0.3 → 0.1.0.** The two move as a pair —
  `react-server-dom-rspack@0.1.0` declares a `@rspack/core: ^2.2.0-0` peer — and `0.1.0` is a minor on a
  pre-1.0 package, so treat it as a breaking upstream change and read this entry before upgrading.

  The manifests had already declared this pair since `6d8e3e4`, but the `pnpm-workspace.yaml` overrides and
  the lockfile were left on 2.1.7 / 0.0.3. Because a manifest pin is what a consumer resolves and an override
  is what this repo resolves, **the published versions had never been tested**: the suite, CI and every
  fixture ran against the old pair while `npm i @rshono/core` installed the new one. The overrides and the
  lockfile now name the same pair as the manifests, and the whole suite — including the scaffold job, which
  installs a generated app from a registry with no overrides in play — is green against it.

### Added

- **`pnpm check:pins`**, which asserts the exactly-pinned dependencies agree across both published manifests,
  the `pnpm-workspace.yaml` overrides, the lockfile and what is actually installed. It runs in CI before the
  gates that would otherwise report a false green, and again in `pnpm release`, where `--skip-tests` cannot
  skip it. Nothing compared those copies before, which is why the drift above lasted a month.

## [1.0.0-rc.17] - 2026-08-29

### Changed

- **Client-side routing is the [Navigation API](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API)
  now, and only that.** The runtime used to reconstruct a navigation from the outside: a delegated `click`
  listener that re-derived what the browser already knew about a link (origin, `target`, `download`, the
  modifier keys), `history.pushState` and `replaceState` patched in place to see the app's own navigations,
  a `popstate` listener for traversals, a sequence counter to order overlapping fetches, and hand-rolled
  scroll handling. All of it is one `navigate` listener now — about 165 lines deleted for 45 — and every
  navigation, from a link click to `router.refresh()`, reaches the same code by the same route.

  Two things get better rather than merely smaller. **Focus now resets after a navigation**
  (`focusReset: 'after-transition'`), so a soft navigation announces itself to a screen reader; the old
  runtime left focus on the link that was clicked and had no equivalent. And **scroll restoration on a
  traversal actually works**: it was previously left to `history.scrollRestoration = 'auto'`, which restores
  at `popstate` — before the payload for that entry has been asked for, against the page being left.
  The browser now waits for React to commit before it scrolls or moves focus.

  A `GET` form submission soft-navigates too, which it did not before. `POST` forms, downloads, fragment
  jumps, cross-origin links and `data-native` are all still left to the browser.

### Removed

- **Soft navigation on browsers without the Navigation API.** The floor is Chrome/Edge 135, Firefox 147 and
  Safari 26.2 — [Baseline](https://web.dev/blog/baseline-navigation-api) since January 2026. Below it the
  runtime intercepts nothing and every navigation is a real browser load, which a server-rendered app answers
  correctly on its own; `router.push` / `replace` / `back` / `forward` / `refresh` all keep working, as
  full page loads. The feature test is `sourceElement`, not `navigation`: Chrome shipped the event in 102 and
  that property only in 135, and without it a `data-native` link cannot be told from any other.

### Security

- **The tested and scaffolded `hono` is now `^4.13.5`**, which carries three fixes: a query parser that did
  not stop at the URL fragment, so a `?` after a `#` became a query string the app read and a proxy, WAF or
  cache in front of it did not (GHSA-crvj-82cr-hjcx); an incomplete fix for CVE-2026-39408, where `toSSG()`
  could still write outside its output directory (GHSA-gqvv-2mrq-wpjv); and unbounded dot-notation nesting in
  `parseBody()` (GHSA-g6gw-c38x-mqfc). rshono itself calls none of the three — it does not use
  `parseBody()`, `toSSG()` or the cache middleware — so this reaches an app through its own `hono`, not
  through the framework.

  **Updating rshono does not update hono for an existing app.** `hono` is a peer dependency the app owns and
  resolves; only a newly scaffolded app picks `^4.13.5` up from the pin. An app on `4.13.4` or below wants
  its own `pnpm up hono` — particularly if it sits behind a proxy or WAF that inspects query strings, or
  calls `parseBody({ dot: true })`.

## [1.0.0-rc.16] - 2026-08-20

### Added

- **`router.back()` and `router.forward()` on `useNavigation()`.** History traversal was left to
  `history.back()` / `history.forward()` on the grounds that the router added nothing to them; having the
  whole client-side routing API in one object is worth more than that. They are soft navigations like the
  rest — the runtime already picked a back-button press up through `popstate` — so `router.pending` covers
  them too.

### Changed

- **`@hono/node-server` is now `^2.1.1`**, which the dev server, the `node` target and the `vercel` runtime
  all sit on — it is the one dependency bump in this release that reaches an already-installed app.
- **A newly scaffolded app pins `hono@^4.13.1`**, with `@types/node@^26.2.0` and `@types/react@^19.2.18`
  alongside it. These are the versions rshono is tested against, copied out of its own manifest by the
  scaffolder's codegen; an existing app is unaffected, since its manifest is its own from the moment it is
  generated.

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
