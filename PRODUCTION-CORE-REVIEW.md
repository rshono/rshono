# Release review — `packages/core`

A read of the whole package with one question in front of it: **is this ready to tag 1.0.0?** Not a follow-up
to the three documents before it — [`PRODUCTION.md`](./PRODUCTION.md),
[`PRODUCTION-FOLLOWUPS.md`](./PRODUCTION-FOLLOWUPS.md) and
[`PRODUCTION-FOLLOWUP-FOLLOWUPS.md`](./PRODUCTION-FOLLOWUP-FOLLOWUPS.md), all of which are fixed and struck
through — but a fresh pass over the source, the request path, the build path and the CLI, hunting for what
those reviews were not looking for. Dependencies are out of scope by instruction.

**Environment.** `@rshono/core@1.0.0-rc.19` · Rspack 2.2.2 · React 19.2.8 · Hono 4.13.5 · Node 22.22.2
**Baseline.** `npm test` **332/332** · `test:browser` green (run outside this sandbox) · `typecheck` clean ·
`eslint .` clean · `prettier --check .` clean · coverage 84.95 / 92.13 / 79.28 against floors of 82 / 90 / 75
**Verified.** 2026-09-02, then **audited a second time** — see below.

> **The answer is yes, with one caveat.** Nothing here is a crash, a leak, a security hole or a data-loss
> path; the framework does what it says under load, under abuse and under failure. **C1 is the one finding
> worth holding a tag for**, and only because it is the gap between a documented promise and the behaviour on
> the commonest failure an app has. The rest are consistency, portability and diagnostics.

### How this was verified, and what the second pass changed

Every finding was reproduced against a real build and a running server, except **C6** and **C9**, which are
platforms this sandbox cannot run and are marked as reasoning from the emitted configuration.

The findings were then audited a second time, with the two riskiest fixes **prototyped and run against the
suite** rather than argued about. That pass changed four of them, and each change is the kind that would
otherwise have been discovered by shipping it:

- **C1's fix, applied as first written, silently regresses an app with no `error` page** — a browser gets a
  bare `text/plain` line where it used to get a readable 500 document, and **the suite stays green**. The fix
  is therefore two parts, not one; see C1's _Regression risk_.
- **C2 is sharper than it looked.** `onShellError`'s only live path _is_ the duplicate: an SSR-only failure
  never reaches it. Measured with a fixture whose `'use client'` component throws on the server.
- **C7's suggested fix contained a trap** — making `readPort` async turns `readPort(a) ?? readPort(b)` into a
  never-nullish `Promise`, so the second source would stop being read. Corrected to the sync shape.
- **C9 is new**, found while checking C4's claim about Cloudflare: `public/` shadows a page route on the two
  CDN-fronted targets and not on the others, against what the contract it implements says. It is last in the
  list because it was found last; the Severity column is what to read the list by.

Each finding below now carries a **Regression risk** line: what acting on it costs, and what to check before
it lands. Where a fix would break an existing test, the test is named — a green suite after one of these
changes is not by itself evidence that it was safe.

---

## Summary

| #      | Issue                                                                                 | Severity | Kind        |
| ------ | ------------------------------------------------------------------------------------- | -------- | ----------- |
| **C1** | The app's `error` page is never used when a page component throws — the commonest 500 | Medium   | Code + docs |
| **C2** | That same fault is reported **twice**, as `render` and again as `ssr`                 | Medium   | Code        |
| **C3** | A `redirect()` from the `error` page is swallowed and reported as a failure           | Low      | Code        |
| **C4** | Routes under the reserved `/_static` prefix build cleanly and can never run           | Low      | Code        |
| **C5** | `rshono dev` answers `/_static` itself, so app middleware never sees an asset request | Low      | Code        |
| **C6** | `ssgFilePath` accepts segment names Windows cannot store                              | Low      | Portability |
| **C7** | Two CLI failure paths exit without draining, against `exit()`'s own reasoning         | Nit      | Code        |
| **C8** | A flight request for a throwing page answers 200 where the document answers 500       | Nit      | Docs        |
| **C9** | `public/` shadows a page route on `cloudflare` and `vercel`, and not on `node`        | Low      | Code + docs |

---

# C1 — The app's `error` page is never used when a page component throws

**Severity: medium.** The one finding that is a promise not kept, rather than a rough edge.

### Issue

`RouteConfig.error` is documented, in `router.ts`, as:

> Page rendered with a 500 status when a request throws.

It is not. Measured against the testbed, one request each, by what the client actually receives:

| failure                   | document request                           | flight request                             |
| ------------------------- | ------------------------------------------ | ------------------------------------------ |
| **page throws in render** | 500 — **the framework's failure document** | 200 — a payload carrying an error row      |
| page module will not load | 500 — the app's `error` page               | 500 — the app's `error` page, as a payload |
| endpoint throws           | 500 — the app's `error` page               | 500 — the app's `error` page, as a payload |

So the app's own 500 page answers for a module that will not load and for a thrown endpoint, and **not** for
a page component that throws — a failed query, a null dereference, the archetypal server error. What the
visitor gets instead is `entry.ssr.tsx`'s `failureDocument`: correct, styled by nobody, carrying none of the
app's layout, and saying "Something went wrong while rendering this page."

### Cause

Nothing throws, so `app.onError` — where the `error` page lives — is never reached:

1. The RSC render throws. React does not reject the stream for that; it writes an **error row** into the
   payload, and `renderComponent`'s `onError` reports it (`source: 'render'`) and returns.
2. The SSR pass reads that row, so the shell fails.
3. `renderHTML` catches its own shell failure (`entry.ssr.tsx:110-115`) and **returns**
   `{ stream: failureDocument(error), status: 500 }`.

`renderComponent` hands that back as an ordinary response. Nothing above it knows the render failed.

The framework knows: the testbed's `/crash` page says so in a comment ("the one path the app's `error` page
can't be reached from"), and `failureDocument`'s dev-only text says "so the app's error page could not be
reached either". It is a considered position — but it is not the one the API doc states, and it is not in the
README, so the first an app author hears of it is the day their 500 page does not appear.

### Fix

Two honest options, and they are not equivalent.

- **Reach the error page.** At `entry.ssr.tsx:115` nothing has been written to the socket yet — the response
  has not left `renderComponent`. Re-throwing the shell failure instead of absorbing it puts the fault in
  front of `app.onError`, which already renders the `error` page from a _fresh_ render for the module-load
  case. **Prototyped**: one line, and `/crash?render=1` then answers 500 with the app's error page, layout,
  runtime and all. But it is only half a fix — see below.
- **Say so instead.** Document it on `RouteConfig.error` and in the README: the `error` page answers for a
  request that fails _around_ the render, and a page that throws _during_ it gets the framework's document.

The first is what an app author expects and what every comparable framework does. The second is a one-line
change and no risk. What is not defensible is the current gap between the doc and the behaviour.

### Regression risk

**High enough that the one-line version must not be shipped on its own.** With the prototype applied:

- **An app with no `error` page loses its visible 500 document.** `app.onError`'s last resort is
  `plainRefusal(c, 'Internal Server Error', 500)` — `text/plain`. Measured against the minimal-app fixture:

  ```
  browser (Accept: text/html)    500  text/plain; charset=UTF-8  "Internal Server Error"
  curl (no Accept)               500  text/plain; charset=UTF-8  "Internal Server Error"
  ```

  That is the README's "never a blank screen" promise weakened for exactly the apps that have nothing else,
  and **the suite does not catch it**: `minimal-app.test.mjs:67` asserts `/Internal Server Error/`, which the
  plain-text line satisfies. So the fix is two parts — re-throw, **and** make `onError`'s HTML fallback emit
  `failureDocument` rather than a plain line.

- **One test fails, and it is the right one to have to rewrite.** `prod.test.mjs:635`, _"a render failure
  answers with a visible error document, not a blank page"_, pins three properties: a 500, the words
  `500 — Internal Server Error`, and **no `<script src=…>`** — "hydrating a payload from the same failed
  render would tear the document down and blank the message". The first two are the fixture's own; the third
  is the one to think about. It does not carry over: the error page is a _fresh_ render with its own payload,
  which is why the module-load path already ships the runtime safely today. The test should assert the app's
  error page for an app that has one, and keep asserting the failure document for one that does not.

- **Nothing else moves.** The whole suite was run against the prototype: 332 tests, one failure, the one
  above. The flight half of the table is unaffected — that response is committed before anything is awaited
  (C8), so no change to the SSR path can reach it.

---

# C2 — One fault, two reports: `render` and then `ssr`

**Severity: medium.** Not wrong output — wrong _volume_, on the path an error tracker cares about most.

### Issue

`reportServerError` keeps an `alreadyReported` WeakSet so that "one fault is reported once, however many
stages it crosses", and `prod.test.mjs` asserts exactly that for a thrown action. It does not hold for a
thrown page. One document request each, counting the testbed's `onServerError` lines:

```
page throws (document)             2 report(s): render, ssr
page throws (flight)               1 report(s): render
module will not load (document)    1 report(s): request
endpoint throws                    1 report(s): request
```

The second report is React's redacted stand-in — _"An error occurred in the Server Components render. The
specific message is omitted in production builds…"_ — so an app wired to Sentry gets the real error and then
a message-free duplicate of it, tagged with a different `source`.

### Cause

The WeakSet keys on error _identity_, which is the right key everywhere else: the same object crosses stages.
Here it cannot work, because the object is not the same one. React hands the SSR layer a fresh, redacted
`Error` carrying only a `digest`; nothing links it to the RSC-layer error that produced it.

`entry.ssr.tsx`'s `onError` already drops anything carrying a `digest`, precisely because "the RSC layer has
already reported those in full". The shell path (`entry.ssr.tsx:113`) has no such test — it fires whenever
`error !== reported`, and a digest-carrying error is exactly the one `onError` returned early for, so
`reported` is still unset and the duplicate goes out.

**Measured, and it makes the fix unambiguous: the duplicate is `onShellError`'s _only_ live path.** A fixture
whose `'use client'` component throws during SSR — the failure that hook is named for — never reaches it,
because `onError` saw that error first and `error === reported` skips the call:

```
client component throws in SSR   500   [rshono] SSR error: Error: client component blew up during SSR
server component throws in RSC   500   [rshono] render error: Error: server component blew up …
                                       [rshono] SSR shell error: [Error: An error occurred in the Server …]
```

### Fix

Give the shell path the same test the line above it already makes: an error carrying a string `digest` came
out of the payload and has been reported. Then decide what `onShellError` is for — it becomes a defensive
floor for a rejection React never announced through `onError`, which is the same shape as the client's
"produced no result" branch (F6) and wants the same one-line comment saying so.

### Regression risk

**Low, and bounded by two checks that already exist.** A control signal cannot be swallowed: `isControlDigest`
is tested two lines earlier and re-throws. An abort cannot be swallowed: the `!options.signal?.aborted` guard
is on the same line. What is left is an error whose digest React minted for the payload — which the RSC layer
reported before writing.

The one thing to fix _with_ it: `prod.test.mjs:809` asserts
`/\[error-reporter\] (?:render|ssr) \/crash/`, which passes on either source and would keep passing if this
regressed. It should name `render` and assert the absence of a second line, the way the action test beside it
already does.

---

# C3 — A `redirect()` from the `error` page is swallowed, and reported as a failure

**Severity: low.** An asymmetry between two sibling paths, where the other one is clearly the considered
behaviour.

### Issue

An app whose `notFound` page redirects gets a redirect. An app whose `error` page redirects gets a 500 and a
misleading line in its error tracker. Same fixture, both pages calling `redirect('/')`:

```
GET /no-such-path (app 404 page redirects)     303 → /
GET /gone         (notFound() from a page)     303 → /
GET /boom         (error page redirects)       500   the framework's failure document
                                               [rshono] the error page failed to render: RedirectSignal …
```

### Cause

`respondToControlSignal` honours a `RedirectSignal` thrown by the `notFound` page, on the reasoning that
"nothing is committed yet, the branch above cannot fail". The `error` page's equivalent, at
`entry.rsc.tsx:795`, catches everything the same way:

```ts
} catch (renderError) {
  reportServerError(renderError, { source: 'request', hono: c, message: '[rshono] the error page failed to render:' });
}
```

A control signal is not a render failure, and this is the one catch on that path that does not say so.

### Fix

The same three lines the `notFound` path already has: honour a `RedirectSignal` by answering it, and leave
the report for errors.

### Regression risk

**Low, with one shape to decide deliberately.** An `error` page that redirects to a URL that also fails
becomes a redirect loop the browser ends, where today it is a 500. That is the app's own mistake and the
`notFound` page can already make it — but it is a change from "always terminates" to "terminates unless the
app points it at itself", so it belongs in the commit message rather than being discovered.

`notFound()` from the `error` page is the other half of the question and should **not** be honoured by the
same change: it would render the `notFound` page from inside the error path, which can fail in turn. Leave it
reported, as now.

---

# C4 — A route under `/_static` builds cleanly and can never run

**Severity: low.** Exactly the failure `assertNothingIsShadowed` exists to prevent, one prefix out of its
reach.

### Issue

```ts
export const routes = defineRoutes([
  { path: '/', component: () => import('./pages/home') },
  { path: '/_static/thing', component: () => import('./pages/manual') },
  { path: '/_static/*', component: () => import('./pages/wildcard') },
]);
```

builds with no warning, and then:

```
/_static/thing           404 text/plain    (no page rendered)
/_static/anything/else   404 text/plain    (no page rendered)
/                        200 text/html     home
```

Both routes are dead. `runtime.mountStaticAssets` registers `/_static` ahead of the page routes
(`deploy/filesystem.ts:42`), and the assets app ends in a terminal 404 — so nothing under that prefix ever
reaches a page. The same holds on the CDN targets, one layer further out, and in dev (C5).

### Cause

The shadow check compares the app's routes with **each other**. The prefixes the framework itself mounts are
not in that comparison, so a route they shadow is invisible to it. The README calls `/_static` "a reserved
prefix an app should not be matching on purpose anyway", which is true and is not a check.

`/_static` is the only prefix reserved on every target. `/_rshono/hmr` is dev-only and exact rather than a
prefix; `__ssg` is a Cloudflare asset path, reachable but not one an app would name.

### Fix

One rule beside the others in `assertNothingIsShadowed`: a route whose path starts with `/_static` is refused
by name, with the prefix in the message.

### Regression risk

**One, and it is worth naming: this check runs at every server start, not only at build.**
`validateRoutesModule` is called as the bundle evaluates, so a refusal turns an app that boots today —
serving everything except its dead `/_static` route — into one that refuses to boot after an upgrade. That is
already true of every other rule in that function, and it is the right trade for a route that cannot work,
but it makes this a **minor-version** change rather than a patch, and the changelog has to say so.

---

# C5 — `rshono dev` answers `/_static` itself, so app middleware never sees an asset

**Severity: low.** A dev/prod divergence in a security-relevant place.

### Issue

Production deliberately routes asset requests through the app's own middleware — that was a fix, and
`prod-config.test.mjs` asserts it: an asset carries HSTS, the app's CSP and its `X-Response-Time`. Under
`rshono dev` it carries none of them:

```
dev page               csp: true    hsts: true    x-response-time: true
dev asset              csp: false   hsts: false   x-response-time: false
```

So a CSP is developed against a policy that does not apply to the files it is most likely to break.

### Cause

`cli/dev.ts:262` mounts the static app on the dev **front-end**, ahead of the catch-all that proxies to the
worker. `/_static/*` is answered before the app is reached.

### Fix

**Document it, in preference to moving it.** The front-end owning `/_static` is not obviously an oversight:
the client bundle is built by a compiler that finishes independently of the server one, and every request the
front-end proxies first awaits `workerGate.promise`. Proxying assets would park them behind the _server_
rebuild — so a save that only touches a server component would stall the browser's JS and CSS until the
worker came back, and a server bundle that fails to build would take the whole page's assets down with it.
That is a worse dev experience than the divergence, and it is the likelier reason the mount is there.

If the divergence is to go, the shape that keeps both properties is narrower: proxy `/_static` **only** while
a worker is live, and answer locally while the gate is closed.

### Regression risk

**Documentation: none.** Proxying: the stall described above, which no test would catch — the dev suite
starts a server, waits for it to be ready and then asserts on requests, so it never observes an asset fetched
mid-rebuild.

---

# C6 — `ssgFilePath` accepts segment names Windows cannot store

**Severity: low.** Reasoning plus a mapping, not an observation: this sandbox is macOS.

### Issue

`isStorableSegment` (`server/prerendered.ts:75`) refuses `\ / : * ? " < > |` and the control characters,
because a `staticPaths` value that cannot be one portable file name must fail the build rather than "writing
a page on one machine and not on another". Two Windows rules are missing from it:

```
"/docs/con"      -> "docs/con/index.html"      # a reserved device name — mkdir fails, EINVAL
"/docs/NUL"      -> "docs/NUL/index.html"      # …and CON, PRN, AUX, NUL, COM1-9, LPT1-9
"/docs/com1"     -> "docs/com1/index.html"
"/docs/x."       -> "docs/x./index.html"       # trailing dot: Win32 strips it, so the file lands at docs/x/
"/docs/x "       -> "docs/x /index.html"       # trailing space: same
```

The reserved names fail the build with an OS error naming a path the author did not write. The trailing dot
and space are worse: Windows silently stores them under the trimmed name, so the page is written where the
reader will never look for it — "a page the build reports as prerendered and nothing ever serves", which is
the exact failure `ssgFilePath`'s doc comment says it exists to prevent.

### Fix

Two clauses in `isStorableSegment`: refuse the reserved device names (case-insensitively, with or without an
extension), and refuse a trailing `.` or space. The message that already exists for an unportable character
covers both.

### Regression risk

**It fails builds that work today, on purpose, and that is the trade the existing check already made.** An app
on Linux with a documentation slug of `con` builds and serves now; after this it does not build anywhere. That
is the same rule `:` and `*` already follow — "portable or not at all" — and the alternative is a build that
succeeds on the author's machine and fails in CI on Windows. Worth being explicit about in the changelog, and
worth checking the two halves separately: the trailing dot/space case is a silent wrong answer and the
reserved-name case is a loud one, so if only one is taken, take that one.

---

# C7 — Two CLI failure paths exit without draining

**Severity: nit.** The module beside them explains why this matters.

### Issue

`cli/exit.ts` exists because "a piped stdout/stderr — every CI job, and any `rshono build | tee` — is
asynchronous on POSIX, and exiting drops whatever has not left the pipe buffer… On the failure paths that is
the report saying _why_ the build failed, cut mid-error." Three failure paths do not use it:

- `cli/index.ts:39` — `readPort`, after printing `rshono: invalid --port …`
- `cli/start.ts:19` — no production build found
- `cli/start.ts:29` — this build targets another platform

Each prints one line and calls `process.exit(1)` directly. Every other bad-input path in the CLI goes through
`exit()`.

### Fix

`start.ts` is already `async`, so both of its paths become `return exit(1)` with one added import.

`readPort` is the one that needs care, and **not** the way this document first suggested. Making it `async`
would break its call site silently:

```ts
const port = readPort(values.port, '--port') ?? readPort(process.env.PORT, 'PORT');
```

`??` on a `Promise` is never nullish, so an `async readPort` would resolve `--port` to a pending promise and
**stop reading `PORT` altogether**. The safe shape keeps the parse synchronous and moves the exit up into
`main`, which is already `async` and is where the other flag errors are answered:

```ts
let port: number | undefined;
try {
  port = parsePort(values.port, '--port') ?? parsePort(process.env.PORT, 'PORT');
} catch (error) {
  console.error(`rshono: ${error instanceof Error ? error.message : String(error)}`);
  return exit(1);
}
```

### Regression risk

**Only the trap above, which is why it is written out.** The message text and the exit code are unchanged, so
`start.test.mjs`'s assertions on both hold; `exit()` adds two zero-length writes before the same
`process.exit(1)`.

---

# C8 — A flight request for a throwing page answers 200

**Severity: nit.** A consequence of a design that is already documented for `notFound()`, and not for a throw.

### Issue

The same failure, two statuses:

```
page throws in render (document)   500   the framework's failure document
page throws in render (flight)     200   payload + error row
```

For `notFound()` and `redirect()` the README explains this — a flight response is committed as
`200 text/x-component` before anything is awaited, so no signal can change the status. A plain throw lands in
the same place and is not mentioned: a soft navigation to a page that throws is a **200** on the wire, and
what the visitor sees is the client runtime's error UI, which is the design working. An uptime monitor or a
CDN log watching for 5xx sees nothing.

### Fix

A sentence in the README's error-handling paragraph, beside the `notFound()` one it already has.

### Regression risk

**None** — it is a sentence. Worth resisting the temptation to "fix" the status: buffering the payload to
learn whether it failed would cost every page its streaming, which is the trade M4 already settled.

---

# C9 — `public/` shadows a page route on `cloudflare` and `vercel`, and not on `node`

**Severity: low.** Found while auditing C4. Reasoning from the emitted configuration, not observed: both
halves are the platform's routing, which this sandbox does not run.

### Issue

`DeployRuntime.mountPublicFallback` is documented, in `contract.ts:51`, as:

> Mounts `public/` at the web root, **after every route**, so it only answers paths no route claimed.

That is true on `node` and `aws-lambda`, where `entry.rsc.tsx:757` registers it after the route loop. On the
two targets where a CDN sits in front, `public/` is part of the static output and the platform answers from it
**before** the app is reached:

- **vercel** — `ROUTES` in `deploy/vercel/build.ts:24-28` is `[…, { handle: 'filesystem' }, { src: '/(.*)',
dest: '/index' }]`. The filesystem handler is ahead of the function by construction.
- **cloudflare** — `assets: { directory, binding }` in `deploy/cloudflare/build.ts:45-48`, whose own comment
  says it: "Read by the worker for `public/` files and prerendered pages; **the CDN still answers first**."

So an app with `public/about.html` and a page route at `/about.html` renders the page under `rshono dev` and
`rshono start`, and serves the file on the two deploy targets — a behaviour difference that only appears
after deploying. `public/index.html` beside a page route at `/` is the same collision on the path every app
has.

### Fix

The framework cannot reorder either platform, so the honest answers are documentation and a check:

- Correct `mountPublicFallback`'s contract line: it is a fallback where the app owns the whole surface, and a
  CDN-first store where the platform routes. The README's deploy table has a column for this already.
- A build-time warning is cheap and would catch it before the deploy: the build knows the route table and it
  copies `public/`, so a collision between the two is one `Set` lookup at `finalize` time on the targets
  where it matters.

### Regression risk

**None for the documentation half.** For the warning: it must compare against what a _request_ resolves to,
not raw filenames — `public/about.html` answers `/about.html`, and an `index.html` answers its directory —
which is the same normalisation `ssgFilePath` already does for prerendered pages. A warning keyed on
filenames alone would be noisy and wrong.

---

# Checked and found correct

Everything below was probed or read and behaves as documented — recorded so the next review knows what has
already been looked at.

- **Request-context isolation.** Eight concurrent requests keep their own cookies, headers and URL; the
  per-request maps (`wrappers`, `rendering`, `actionResults`, `alreadyReported`) are all weak, and the
  prerender cache is bounded by bytes.
- **Streaming teardown.** `flight-inject.ts`'s permit system, its two cancel paths and its trailer carry are
  reasoned through the cases that bite — a batch split across React's 2 kB views, a cancelled readable during
  `flush`, a binary row that is not valid UTF-8. The `HEAD` path cancels the body it does not send.
- **Adversarial paths.** `/_rshono/hmr` is absent in production; `//docs//x`, `/docs/./x`, `%00`, an 8 kB path
  and an 8 kB query are all answered without a stack trace or a 500; `OPTIONS` is a 404; proxy headers are
  ignored without `trustProxy`.
- **Conditional and range requests.** `If-None-Match` matches an exact tag, a list and the strong spelling;
  a `Range` on a prerendered page is ignored with a 200 (legal), and on a static asset gives 206 and 416
  correctly.
- **Refusals.** The framework's plain-text answers agree on `Vary: RSC` and `private, no-cache`; the
  cross-site form refusal keys on `Sec-Fetch-Site` **and** `Origin`, refusing the shapes no browser produces.
- **Build-time validation.** The route table, both entry modules, every route's own module, and now the app's
  server actions; a duplicate path, a shadowed pattern, a bad `method`, a `staticPaths` on a dynamic route and
  a `'use client'` page are each refused by name.
- **Packaging.** 144 files, 302 kB, `dist` and `bin` only — no `src`, no `.d.ts.map`. All three entry points
  resolve, ESM-only, and the `engines` floor covers every API used (`process.loadEnvFile`, `URL.parse`,
  `Promise.withResolvers`, `import.meta.dirname`).
- **The four deploy targets.** Each builds, and each is exercised in the suite through the handoff its
  platform actually performs — including the Vercel launcher's `(IncomingMessage, ServerResponse)` pair and
  the Cloudflare assets binding.
