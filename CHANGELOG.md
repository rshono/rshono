# Changelog

All notable changes to `@rshono/core` and `@rshono/create`, which are released together and share a version.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). Each release is tagged `v<version>` and published
from a maintainer's machine with `pnpm release` — see CONTRIBUTING.md.

Releases before `1.0.0-rc.14` predate this file and are not reconstructed here; `git log` is the record for
those.

## 1.0.0-rc.19

A pass over the two published packages against four questions — is the API correct and minimal, is there dead
code, is the framework easy to understand, does it fail gracefully — and everything it turned up, followed by
a release review of `packages/core` and the eleven findings that came out of it.

Six entries below change behaviour on an app that builds today: **`ctx.env`**, **a 5xx while prerendering**,
**`defineRoutes`' typing**, **the `error` page answering a thrown page component**, **a route under
`/_static`**, and **the `staticPaths` values a build accepts**. Read those six before upgrading — the last
two refuse a build that succeeds today, on purpose.

### Security

- **The cross-site form refusal no longer reads `x-rsc-action` differently from the classifier that decodes
  the post.** One decides what is refused, the other what is decoded, and they tested the same header two
  ways: the refusal asked whether it was _present_, the classifier whether it had a _value_. A POST carrying
  a present-but-empty `x-rsc-action` therefore fell between them — excluded from the refusal as "the
  client-initiated shape, which needs a preflight to forge", then dispatched down the form branch, where it
  ran the action its body carried with the cross-site check skipped. Not reachable from a browser: an empty
  header is still a header, so a cross-origin `fetch` still needs the preflight the framework never answers,
  and any app with `csrf()` registered caught it regardless. It mattered because this refusal is the whole of
  what an app with no `src/server.ts` has, and a predicate that fails open on a shape nothing sends today is
  one that fails open the day something does. Both now read the value.

- **`getRequestContext().env` no longer merges the platform's own `fetch` argument.** `c.env` is the second
  argument to `app.fetch(request, env)` — the app's bindings on Workers, and on every other target the
  adapter's private state: `{ incoming, outgoing }` on Node and Vercel, the whole invocation on
  `aws-lambda`. It was spread into `ctx.env` unfiltered, behind names the type declares
  `string | undefined`. So `ctx.env.ANYTHING.startsWith(…)` type-checked over a live socket wrapper,
  `JSON.stringify(ctx.env)` threw on a circular structure on two targets, and on Lambda the request's own
  headers, cookies and `authorization` were readable through `ctx.env` and serialized cleanly into anything it
  was spread into — the same class of leak the `ctx` page prop is made non-enumerable to prevent, reached
  through a different door.

  The selected preset now declares whether its platform supplies bindings, `resolveServerConfig` bakes that
  into the bundle beside `trustProxy`, and the merge runs on exactly that condition. Only `cloudflare` sets
  it, so `ctx.env` is `process.env` alone everywhere else. Filtering by value type would not do: KV, D1 and R2
  bindings are objects on purpose. `ctx.hono.env` still reaches the raw argument.

### Changed

- **The `error` page answers a page component that throws.** `RouteConfig.error` says "rendered with a 500
  status when a request throws", and for the commonest server error there is — a failed query, a null
  dereference — it was not: `renderHTML` caught its own shell failure and returned it as an ordinary 500, so
  nothing above ever knew the render had failed and `app.onError`, where the `error` page lives, was never
  reached. A page module that would not load and a thrown endpoint did reach it, which made the gap look like
  one path misbehaving rather than the promise being false on the likeliest one. Nothing has reached the
  socket when the shell fails, so the fault is re-thrown and answered where every other request failure is;
  the `error` page renders fresh, with its own payload and the client runtime, and hydrates like any page.
  An app with **no** `error` page now gets the framework's 500 **document** where a browser previously got
  `text/plain` on this path, and a client that asked for neither HTML nor a payload still gets the plain
  line. A flight request is unchanged: it is a 200 carrying the error, because its status is committed before
  the render can fail — now stated in the README beside the same point about `notFound()`.

- **A route under `/_static` fails the route check.** `mountStaticAssets` registers that prefix ahead of the
  page routes and the assets app ends in a terminal 404, so a route at `/_static/thing` built clean and then
  404'd, on every deploy target and in dev — exactly what `assertNothingIsShadowed` exists to prevent, one
  prefix out of its reach. It is refused by name now. Only a literal path: a parameterised route that happens
  to overlap the prefix loses those requests and answers the rest, and refusing it would fail a build that
  was correct. **This check runs at every server start, not only at build**, so an app that boots today while
  serving everything except its dead `/_static` route will refuse to boot after upgrading.

- **`staticPaths` refuses the segment names Windows cannot store.** `isStorableSegment` already refused
  `\ / : * ? " < > |` and the control characters, so a value that cannot be one portable file name fails the
  build rather than writing a page on one machine and not another. Two Windows rules were missing and neither
  is discoverable from a macOS or Linux build: the reserved device names (`CON`, `PRN`, `AUX`, `NUL`,
  `COM0`-`COM9`, `LPT0`-`LPT9`, with or without an extension) and a trailing `.` or space. The first fails
  `mkdir` on Windows with an error naming a path nobody wrote; the second is worse, because Win32 **strips**
  it and the page lands where no request will look — the exact failure `ssgFilePath` exists to prevent. So a
  docs slug of `con` or `v1.` builds and serves on Linux today and after this builds nowhere, which is the
  trade `:` and `*` already make. `console`, `comic`, `contents`, `v1.2` and `a b` are unaffected.

- **A 5xx while prerendering fails the build.** `renderVariant` only asked whether the status was 200, so
  every non-200 got the same sentence — `⚠ "/x" rendered 500 at build time — skipping, will SSR per request` —
  and the build printed `✓ build complete` and exited 0. "Will SSR per request" is true of a 404, a 3xx, a
  wildcard param and a route with no `staticPaths`. It is false of a 5xx: prerendering renders a page exactly
  as a request does, so that route 500s per request, forever, behind a green CI run. Every failing page is
  named at once, in route order.

- **`defineRoutes` has one signature over both accepted shapes.** The array shorthand was a second overload,
  so a mistake inside a bare array came back as an overload-resolution report whose _first_ line was the
  object form's complaint — "Property 'routes' is missing" — which is false for that call and points at a
  change the author should not make; the real message was on line 8. All four cases (bad props or bad
  `staticPaths`, through either form) now produce one error at the offending field.

  The cost is excess-property checking on the config object, which a generic parameter inferred from its
  argument cannot have. That check is now the framework's own and names the fields there are, so a typo'd
  `notfound` is still refused — and now refused when the object arrives through a variable too, which
  excess-property checking never covered.

- **`@rspack/core` 2.2.1 → 2.2.2.** A patch on the pin rc.18 moved to. `react-server-dom-rspack` stays at
  **0.1.0** and its `@rspack/core: ^2.2.0-0` peer is unchanged, so the pair still resolves as one and this is
  the manifests, the overrides and the lockfile in a single commit — nothing in the framework moved. Upstream
  is bug fixes and compile-time performance; the two fixes nearest what rshono builds are `import.meta.url`
  surviving `createRequire` when `importMeta` is disabled, and CSS Modules local ident hashes no longer
  varying with `exportsOnly` — the flag that necessarily differs between a client build that emits CSS and a
  server build that only needs the class names. rshono sets neither option, so it takes the defaults on both
  sides of that.

  2.2.2 was published the same day it was taken here, which is inside pnpm's `minimumReleaseAge`; the sixteen
  `@rspack/*@2.2.2` entries added to `minimumReleaseAgeExclude` are what waives the cooling-off for this one
  version, and they can be dropped once the window has passed.

### Added

- **`rshono build` checks every route's own module.** Four structural mistakes survived a build and then
  answered 500 on every request: a `'use client'` page, a page module with no default export, the same under
  `render: 'static'`, and an endpoint module exporting `GET` instead of `handler`. The two page checks already
  existed and ran on first request; the endpoint fork had none at all, which made the one mistake people
  actually make `TypeError: r is not a function` from a minified frame. All of them now run against every
  route once the bundle is imported for the prerender pass — `notFound` and `error` included — and name every
  broken route rather than the first.

  A module that throws while _evaluating_ is warned about, not fatal: whether an import succeeds is a question
  about the environment as much as about the module, and a page whose module scope reads a secret or opens a
  connection works per request. A `render: 'static'` route is the exception and needs no special case — it
  promised to render at build time, so the prerender pass demands the import.

- **The client's own recovery loads reach the browser instead of the framework's router.**
  `window.location.reload()` and `location.assign()` fire a `navigate` event like any other navigation, and
  the router intercepts a `reload` on purpose — that is what `router.refresh()` is. Both of the client's
  escape hatches from a torn-down React root went through it, so neither escaped: a late `notFound()` left
  the tab on its Suspense fallback with no second document ever arriving, and a late `redirect()` moved the
  address bar to a page it then failed to render into the root that had just been unmounted. The framework's
  own recovery loads now bypass its listener for exactly one navigation.

- **A late `notFound()` reloads once instead of forever.** `redirect()` and `notFound()` raised after the page
  shell has been sent both degrade to a 200 carrying a digest, and the client's recovery differs: a redirect
  has somewhere to navigate, a `notFound()` does not, so it asks for the page again — which recovers where
  the lateness was incidental and cannot where it is structural, since the response is byte-identical. The
  attempt is now spent once per URL per tab and the second arrival paints "Page not found", with the
  diagnostic in dev only and no reload button in either. A reload that does not replace the document within
  two seconds paints the same panel rather than leaving the visitor on a fallback.

  Browser coverage added for both directions of the digest path, which had none — each asserting the
  destination is on screen rather than that the address bar moved.

- **A browser module importing `@rshono/core/server` is named.** The build failed correctly and said only
  `ERROR in node:async_hooks × Reading from "node:async_hooks" is not handled by plugins` — no file path, no
  issuer, no mention of rshono, for the one mistake the docs warn against often enough to suggest people make
  it. The client compiler now catches the request where the issuer is still known and reports the module, with
  the path on Rspack's own `ERROR in <file>` line, and what to use instead.

- **`rshono dev` says when a change needs a restart.** `.env`, `.env.local` and `rshono.config.ts` are read
  once at startup and what a build needs from them is compiled in, so no rebuild picks up an edit — and the
  failure is invisible: the page rebuilds, is served, and shows the old value. The three files are watched, and
  a change to one prints which file and what to do. Written down as well, in the core README's limitations, the
  scaffolded README and `docs/configuration.md`, all three of which described `.env` loading without it.

### Fixed

- **A broken deployment no longer answers a no-JS form post with a silent 400.** `decodeAction` does two
  things in one call: it reads the caller's body, and it `__webpack_require__`s the module the action lives
  in. Both sat behind the one `catch` that answers `400 Bad Request: malformed server action request` — the
  refusal that is deliberately silent, because action ids are public and reporting from there would be an
  unauthenticated way to page whoever owns the error tracker. So an action module that would not evaluate
  told the caller their request was malformed, when it was not, and told the operator nothing at all. The
  same fault reached through a client-initiated call has answered 500 with the app's `error` page, reported
  as `source: 'action'`, since the guard around `loadServerAction` was split out; the form path — which is
  what a browser sends before hydration and with JavaScript off — kept the old behaviour. Rspack compiles an
  app's whole `'use server'` graph into a single server module, so this was every form post in the app, not
  one. The body read now has its own guard, and a `decodeAction` failure asks whether the app's actions can
  be loaded at all before it blames the caller. A malformed body, an unknown action id and undecodable
  `useActionState` metadata are all still a silent 400.

- **A thrown non-`Error` reaches the `error` page.** Hono's dispatcher hands `app.onError` only what is
  `instanceof Error` and re-throws everything else, so `throw 'a plain string'` — or a rejected string, or a
  thrown object — rejected `app.fetch` and was answered outside the app entirely: a bodiless 500 with no
  `error` page, nothing on stderr, no `onServerError` report, and, because nothing below the response floor
  ever unwound, not even `x-content-type-options`, `referrer-policy` or `x-frame-options`. A throw that was
  merely written badly therefore answered strictly worse than a real `Error` beside it, and
  `RouteConfig.error` promises the page for a throw from "an endpoint, a server action, or middleware" — all
  three reachable this way. Anything that is not an `Error` is now wrapped in one carrying it as `cause`,
  with the value named in the message; an `Error` of any kind is untouched, which is what keeps the control
  signals, the payload stand-ins and the report de-duplication intact. An endpoint and a page route convert
  at their own handler, so the app's middleware unwinds over the `error` page exactly as it does for an
  `Error`; a _middleware_ that throws a non-`Error` reaches the page too, but everything registered outside
  it is skipped, which no framework-side change could alter.

- **A directive that is not first still counts.** `page-entry-loader` prepends `'use server-entry'` to a page
  module that declares no directive of its own, and it recognised one only in first position — so a page
  opening `'use strict';` above its `'use client';` got the injection anyway, and the injected directive is
  the one the compiler acts on. The build then exited 0 and shipped a client page as a server entry, where
  the same page with `'use client'` on line one is refused by name with the framework's message. It now
  matches the whole directive prologue, the way `env-shadow-loader` already did — structurally, so a comment
  that merely mentions `'use client'` is trivia and not a directive, and any other directive (`'use cache'`,
  whatever React adds next) is stepped over rather than listed.

- **The `/_static` mount ends in a terminal 404 on `cloudflare` too.** It answered `next()` for a miss, so a
  request for a chunk that is not there walked the whole route table, then the `public/` fallback, and landed
  in `app.notFound` — which for anything that asked for HTML is a full server render of the app's 404 page,
  under a prefix no app can own. The filesystem targets have always ended that mount in a plain 404, and
  both `RESERVED_PREFIX`'s doc and the reserved-route check above lean on the mount answering its whole
  subtree on every target. A browser fetching a real subresource sends `Accept: */*` and got the plain 404
  either way, so what this cost was a render for a crawler, a probe or a hand-typed URL — and the
  `Cache-Control` that keeps a shared cache from storing a 404 for a content-hashed URL that is about to
  become valid, which the filesystem mount states and this one inherited by accident. Both now take it from
  one constant.

- **A cross-site `enctype="text/plain"` form post is refused too.** The refusal was keyed on the request
  classification, which names the two content types React writes an action as — so `text/plain`, the third
  and last `enctype` a browser `<form>` can send with no preflight, was classified as an ordinary document
  request and rendered the page, while the README promised that a page route refuses _every_ cross-site form
  post. Nothing could run an action through it (`decodeAction` is only reached for the other two, so
  SECURITY.md's boundary held) and the cost was a forced authenticated page render, which a cross-site GET
  can already produce. What was wrong was the stated scope, and the fix is the direction that makes the
  claim true: the check now runs on the request's _shape_ — a POST a browser form could have produced, all
  three enctypes — because what makes a form post forgeable from another site is the shape and not what
  happens to be in the body. `text/plain` is deliberately **not** added to the classification: `decodeAction`
  reads the body with `request.formData()`, which throws on one, so that repair would turn every same-origin
  `text/plain` POST into a 400. A cross-site `application/json` POST is still let through — no browser can
  send one without a preflight the framework never answers.

- **A handler may return a `Response` it did not build.** `Response.redirect(…)` and every `fetch()` result
  carry a header bag guarded `immutable`, and handing one back verbatim is ordinary Hono — proxying an
  upstream is the commonest thing a Worker does. The framework's response floor wrote its baseline headers
  with `c.res.headers.set(…)`, which throws `TypeError: immutable` on one of those: the throw reached
  `onError`, the app's 500 page went out in place of the redirect, and the app's error tracker got
  `immutable` plus a minified frame naming nothing that could be acted on. **On `cloudflare` and
  `aws-lambda` only**, which is what made it worth finding: `@hono/node-server` replaces the global
  `Response` with a lightweight class whose headers are always mutable, so `node` and `vercel` — dev,
  `rshono start`, and nearly every suite — answered the redirect correctly all along. The floor now collects
  what a response is missing and writes the first of them through `c.header()`, which rebuilds a finalized
  response before writing exactly as `serveAsset` already did by hand for the framework's own asset
  responses; a response that needs nothing is not rebuilt at all. The `SSG_CACHE_CONTROL` doc recipe for
  overriding a prerendered page's caching from middleware now uses `c.header()` for the same reason.

- **One fault is reported once.** `reportServerError` keeps a WeakSet so a fault crossing several stages is
  reported once, and it held everywhere except a thrown page component: an app wired to Sentry got the real
  error as `render` and then a message-free duplicate as `ssr`, because the WeakSet keys on object identity
  and React hands the SSR layer a fresh, redacted stand-in carrying only a `digest`. That digest **is** the
  provenance, so the test `entry.ssr.tsx` already made for it is now one function in `control.ts` and is made
  in all three places a payload fault could be reported twice from — the shell path, the top-level handler,
  and the `error` page's own catch, where a throwing `error` page was reported twice for the same reason.
  `onShellError` becomes what it says it is: a floor for a rejection React never announced.

- **A `redirect()` from the `error` page is a redirect.** It was a 500 plus "the error page failed to
  render: RedirectSignal" in the app's error tracker, while the `notFound` page's identical branch answered
  the redirect — nothing is committed when the signal arrives and answering it cannot fail. `notFound()` from
  the `error` page is still not honoured, because it would render the `notFound` page from inside the error
  path, but it no longer claims the page is broken: the line says the framework declined and why. One thing
  to know rather than discover: an `error` page redirecting to a URL that also fails is now a loop the
  browser ends, where it used to terminate as a 500.

- **A rebuild drops a `public/` file that is no longer there.** `dist/public` was the one output directory
  assembled with a `cpSync` and no `rm` first, so a file deleted from `public/` survived there and went on
  being served by `rshono start` permanently — and deleting `public/` outright left the whole of the old tree
  in place, since the copy is conditional. The two CDN presets clear their own output but read this
  directory, so a stale file propagated into the uploaded assets too.

- **`rshono build` warns when a `public/` file shadows a route** on `cloudflare` and `vercel`.
  `mountPublicFallback` mounts `public/` after every route, so it answers only unclaimed paths — the whole
  story on `node` and `aws-lambda`, and not where a CDN sits in front, which answers from the static output
  before the app is invoked. So `public/index.html` beside a page route at `/` serves the file on two targets
  and renders the page on the other two, and the difference only appeared after deploying. The framework
  cannot reorder either platform; the contract line is corrected, the README says which targets do which, and
  the build compares the two. It compares what a _request_ resolves to rather than filenames — an
  `index.html` answers its directory — and per target, since Cloudflare's asset handling also drops `.html`
  and Vercel's does not without `cleanUrls`.

- **Every CLI failure path drains its output before exiting.** `cli/exit.ts` exists because a piped
  stdout/stderr is asynchronous on POSIX — every CI job, and any `rshono build | tee` — so `process.exit`
  drops what has not left the buffer, which on a failure path is the report saying why. Four paths called
  `process.exit` directly: an invalid `--port`/`PORT`, both of `rshono start`'s refusals, and `rshono dev`'s
  port-in-use. Nothing in `dist/cli` reaches `process.exit` now except the helper that drains first, and a
  test keeps it that way.

- **`rshono dev` answers `/_static` itself, and now says so.** A build serves assets through the app, so they
  carry HSTS, your CSP and anything else your middleware sets; the dev front-end owns the prefix, so they
  carry none of it, and a policy is developed against the files it is most likely to break. Documented in
  preference to moving it: every request the front-end proxies waits on the server rebuild, and the client
  bundle is built by a separate compiler, so proxying assets would stall the browser's JS and CSS on a save
  that only touched a server component.

- **A `/_static` 404 carries a `Cache-Control`.** `cacheControl` returns early for anything that is not
  200/206 and the terminal `c.text('Not Found', 404)` set no header of its own. A 404 is heuristically
  cacheable under RFC 9111 — the reasoning already written above `plainNotFound` — and `/_static` is where it
  matters most: during a rolling deploy an old instance 404s a chunk the new one has, and a shared cache may
  store that answer against a content-hashed URL that is about to become valid.

- **The Biome templates exclude `.rshono/`.** Both listed `!dist` and not the dev server's output directory,
  so after anyone ran `pnpm dev` a Biome app's `format:check` and `lint` failed on generated bundles and
  `pnpm format` rewrote them. Specific to Biome, which does not read `.gitignore` unless `vcs.enabled` and
  `vcs.useIgnoreFile` are set; Prettier, oxfmt and oxlint all honour it.

- **`create-rshono`: three argument gaps.** `./` was rejected while `.` worked — `.` was special-cased as a
  literal, so the shell-completed spelling reached `toPackageName('./')`, which has nothing left to name a
  package with; the target is resolved first now, which answers for `sub/..` and an absolute path too.
  `--dry-run` was refused in a non-empty directory, where a run that writes nothing has nothing to conflict
  with and the advice (`--force`) described an action the user had not asked for. And `toPackageName` could
  return a name npm refuses — a leading `_` survived where a leading `.` did not — because npm's rule was
  spelled again per character class rather than reused; the result now goes through `isValidPackageName` on
  the way out.

- **Documentation and hygiene.** `onError` on both boundaries now carries the note `ErrorFallback`'s function
  form does — it can only be passed from a `'use client'` component, and the headline use of these components
  is that a _server_ component can render them. `CatchBoundaryProps.resetKeys` documented itself with a
  `useNavigation()` call unreachable from that server component; the `url.pathname` form off a page's props
  comes first now. `weakEtag` is no longer exported for nobody. A CI comment claimed the browser suite covers
  prefetching, which exists nowhere in the framework — the browser spec pins its _absence_ and the README
  lists it as a deliberate choice.

- **`rshono build` does not type-check, and the README now says so.** swc strips types and `tsc` is never
  invoked, while several of the framework's guarantees are types alone — the `handler` an endpoint module
  owes, and `defineRoutes`' path ↔ props and `staticPaths` ↔ path checks. Run `tsc --noEmit` in CI beside the
  build. The mistakes that make a route unservable are checked at build time whether or not you do.

## 1.0.0-rc.18

### Changed

- **`@rspack/core` 2.1.7 → 2.2.1 and `react-server-dom-rspack` 0.0.3 → 0.1.0.** The two move as a pair —
  `react-server-dom-rspack@0.1.0` declares a `@rspack/core: ^2.2.0-0` peer — and `0.1.0` is a minor on a
  pre-1.0 package, so treat it as a breaking upstream change and read this entry before upgrading.

  `react-server-dom-rspack` stays at **0.1.0**, which is its `latest`. There is a `19.3.0` on npm, but it is
  tagged `canary` and peers `react: ^19.3.0` / `react-dom: ^19.3.0` — versions that exist only as React
  canaries — so taking it would mean shipping a stable framework on a React canary. `react`, `react-dom` and
  `hono` are already at their latest stable releases and did not move.

- **Every other dependency refreshed to its latest release.** `@types/node` `^26.2.0` → `^26.4.0` (which
  `FRAMEWORK_DEPS` carries into scaffolded apps), `@types/react-dom` `^19.2.4` → `^19.2.5`, `eslint`
  `^10.8.1` → `^10.9.1`, `typescript-eslint` `^8.67.0` → `^8.68.0`, and for the website `markdown-it`
  `^15.0.1`, `@types/markdown-it` `^14.2.0`, `wrangler` `^4.127.1`.

  The website's own `typescript` moves `~6.0.3` → `^7.0.2`, matching `packages/core` and `apps/testbed`. Its
  `tsconfig.json` was already written for 7 — the `paths`-without-`baseUrl` comment says so — and it
  typechecks clean, so the 6.x pin was an oversight rather than a constraint.

  **The root `typescript` stays on `~6.0.3`.** It is there for the linter, and `typescript-eslint@8.68.0` —
  the latest — still peers `typescript >=4.8.4 <6.1.0`. Nothing to do until that range widens; see
  CONTRIBUTING.md, "Two TypeScripts".

- **`HTTPMethod` no longer offers `'head'`.** Hono dispatches a `HEAD` as a `GET` and strips the body off the
  response, so a route registered for `HEAD` answered nothing — verified: `app.on('HEAD', …)` 404s the `HEAD`
  _and_ the `GET`. The value type-checked, built and silently 404'd. Use `method: 'get'`, which answers both;
  `src/routes.ts` validation now says so by name if it finds a `'head'`.

- **`src/routes.ts` and `src/server.ts` are validated rather than cast.** Both reach the framework through a
  build-time alias with no type the compiler can hold, so a mistake used to surface later and elsewhere — a
  `routes` array that skipped `defineRoutes` as `TypeError: nN is not iterable` out of a minified bundle. Every
  message now names the file, the entry by position _and_ path, and what to do. Two mistakes that produced no
  error at all are refused as well: a key belonging to the other kind of route, and a route every method of
  which an earlier one already answers.

- **`ServerErrorContext` carries the request's Hono context and a `waitUntil`.** Reporting is what
  `onServerError` exists for, and on a serverless platform a report started there was cut off when the
  response ended. `waitUntil` holds the invocation open where the platform has such a thing to ask; `hono`
  gives a handler `hono.var` — a request id to correlate on — which it had no way to reach for a
  `source: 'request'` error, reported outside the ambient context. Both types are now generic over the app's
  `Env`, defaulting so nothing existing changes.

- **The prerender pass renders eight paths at a time and de-duplicates.** A documentation site with a few
  hundred `staticPaths` entries paid every page's data fetching in series, and a repeated entry was rendered
  and written twice with nothing said. Results, the manifest and the build log are folded back in route order,
  so a concurrent pass reads like a serial one.

- **The flight injector honours the consumer's demand.** The payload pump wrote into the response from a
  detached promise with nothing consulting demand: a client that read one chunk and stalled still pulled the
  whole payload into memory. It now takes one permit per chunk the consumer asks for, so a slow client parks
  React instead of filling the process.

- **A `render: 'static'` route the build wrote nothing for no longer pays a store lookup per request.** The
  build leaves a manifest naming every file it wrote, and the runtime reads it once.

- **`staticPaths` is checked against its own route's path.** A param key the path does not have is a type
  error where the route is declared, rather than a build-time throw from the prerender pass. Keys only, so a
  `staticPaths` annotated as returning `Record<string, string>` — the type the field declares — still
  compiles.

### Added

- **`method` on an endpoint route takes a list.** `method: ['get', 'delete']` is one handler for two methods;
  before, a two-method endpoint had to be `'all'` plus a hand-rolled check, which also answered every method
  it was not meant to. `'all'` inside a list is refused, as is an empty one.

- **`pnpm check:pins`**, which asserts the exactly-pinned dependencies agree across both published manifests,
  the `pnpm-workspace.yaml` overrides, the lockfile and what is actually installed. It runs in CI before the
  gates that would otherwise report a false green, and again in `pnpm release`, where `--skip-tests` cannot
  skip it. Nothing compared those copies before, which is why the drift above lasted a month.

- **`pnpm --filter @rshono/core test:coverage`**, the suite against a coverage floor over `dist/**`, and a CI
  job that runs it. Nothing measured coverage before, so a new branch could land untested.

### Fixed

- **Prerendered pages whose paths need percent-encoding were built and then never served.** The build wrote
  each page under `encodeURIComponent(value)` while Hono hands a handler a path it has already run
  `decodeURI` over, so writer and reader disagreed for exactly the characters `decodeURI` unescapes: every
  non-ASCII or space-bearing slug was reported as prerendered and missed on every request, forever, and
  differently per deploy target. One mapping now answers for both, and stores each segment decoded.

- **`PORT=""` bound a random port and reported success.** The CLI treated an empty `PORT` as unset while the
  node bundle turned it into `0`. Both now parse it the same way, and a `PORT` that is not a usable port is a
  named error rather than a silent bind — an empty `PORT` is common in CI images and container templates.

- **An action that failed before its payload was produced made the browser throw a `TypeError`.** A
  `bodyLimit()` 413, a proxy error page or a 502 mid-deploy all reached application code as
  `Error: Connection closed.`, with the status nowhere in sight. A response that is not a flight payload now
  surfaces its status, and an action that threw is answered with a payload the client can act on.

- **A `notFound` or `error` page that itself threw a control signal produced a bodiless, unlogged 500.** Both
  are now answered — reported, and with a body — and a `notFound` page calling `notFound()` recurses exactly
  once.

- **A `redirect()` or `notFound()` raised after the shell had flushed kept rendering a page nobody would
  see.** HTTP has no take-backs once the status line is out, so the signal still rides the payload for the
  client runtime to act on — but the render is now aborted rather than run to completion, and `rshono dev`
  warns with the page and the destination. The limitation and its app-side fix are in the README.

- **A `HEAD` on a page route rendered the whole document and threw it away.** Hono drops the body without
  reading it, so nothing cancelled the render: the abort forwarder stayed attached to the request signal,
  holding the rendered tree. A `HEAD` now takes the same path a `GET` would — prerendered bytes included, so
  it promises the same `ETag` and `Content-Length` — and the render behind it is released.

- **A plain-text 404 or 500 carried no `Cache-Control`.** The framework's default is applied to page content
  types, so these two never got one — and a 404 is heuristically cacheable, meaning a shared cache was free to
  store it while the rendered HTML 404 beside it was correctly private.

- **A route that cannot be prerendered no longer fails the whole build.** A wildcard segment, an
  optional/regex param or a `staticPaths` that rejected took the build down with a raw error; each is now a
  warning naming the reason, and the route renders per request like any other. What still fails the build is a
  `staticPaths` _value_ no single file can hold, which would otherwise be reported as prerendered and never
  served.

- **The injected flight payload could land inside `</body></html>`.** The trailer was looked for on each
  batch, so one split across two batches was missed. Anything that could still become the trailer is now held
  back and carried into the next batch.

- **A soft navigation to an unmatched path got a payload without `notFound: true`.** The flag was set on one
  of the two routes to the same page; both set it now.

### Security

- **The SSR env shadow covers every way a client component can read the environment.** The loader skipped any
  module whose source did not contain the literal `process.env`, so `process?.env` — the spelling used by
  code meant to run in a browser _and_ on a server, which is exactly what a `'use client'` component is —
  `process['env']`, `const { env } = process` and a plain alias all went through untouched, rendering real
  secrets into the SSR'd HTML while the browser bundle saw the `PUBLIC_`-only view. The gate is now the
  `process` binding itself, which the prelude replaces. A read through `globalThis.process`, which no binding
  can shadow, is warned about in the app's own source.

- **`/_static/*` is served behind `src/server.ts`'s middleware.** The asset handler was mounted ahead of the
  app and is terminal, so asset responses carried the framework's three baseline headers and nothing else —
  no CSP, no COOP, and no HSTS, which is per-response and exactly what a `/_static` request over http needs.

- **The built-in form-post guard refuses a same-site cross-origin post, and one with no `Origin`.**
  `same-site` is the label a browser sends from a sibling subdomain — a user-content host, a stale CNAME, a
  subdomain takeover — and for an app with no `src/server.ts` there is no `csrf()` behind it. The guard now
  proves same-origin rather than not-foreign, so a label with no `Origin` at all is refused too.

- **The CSP nonce is validated before it is written into the payload script tag.** That tag is built by hand,
  so its attribute value is the one in a rendered document nothing else escapes, and `secureHeadersNonce` is
  an ordinary context variable any middleware can set. A value outside the base64/base64url alphabet is
  dropped rather than escaped: a payload script the policy then refuses is the visible failure to have.

- **The build warns when nothing in `src/` registers a body cap.** Every `'use server'` export is a public
  POST endpoint and the action path buffers the whole body before it can decide anything about it. The warning
  used to appear only when `src/server.ts` was absent entirely.

- **`SECURITY.md` and the docs now say that a client-initiated action relies on the CORS preflight** for its
  cross-origin protection, which is what the `x-rsc-action` header buys — and what an app widening `cors()`
  gives up.

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
