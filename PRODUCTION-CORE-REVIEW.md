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
**Verified.** 2026-09-02. Every finding below was reproduced against a real build and a running server,
except C6, which is a platform the sandbox cannot run and is marked as reasoning.

> **The answer is yes, with one caveat.** Nothing here is a crash, a leak, a security hole or a data-loss
> path; the framework does what it says under load, under abuse and under failure. **C1 is the one finding
> worth holding a tag for**, and only because it is the gap between a documented promise and the behaviour on
> the commonest failure an app has. The rest are consistency, portability and diagnostics.

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

---

# C1 — The app's `error` page is never used when a page component throws

**Severity: medium.** The one finding that is a promise not kept, rather than a rough edge.

### Issue

`RouteConfig.error` is documented, in `router.ts`, as:

> Page rendered with a 500 status when a request throws.

It is not. Measured against the testbed, one request each, by what the client actually receives:

| failure                   | document request                           | flight request               |
| ------------------------- | ------------------------------------------ | ---------------------------- |
| **page throws in render** | 500 — **the framework's failure document** | 200 — payload + error row    |
| page module will not load | 500 — the app's `error` page               | 500 — the app's `error` page |
| endpoint throws           | 500 — the app's `error` page               | 500 — the app's `error` page |

So the app's own 500 page answers for a module that will not load and for a thrown endpoint, and **not** for
a page component that throws — a failed query, a null dereference, the archetypal server error. What the
visitor gets instead is `entry.ssr.tsx`'s `failureDocument`: correct, styled by nobody, carrying none of the
app's layout, and saying "Something went wrong while rendering this page."

### Cause

Nothing throws, so `app.onError` — where the `error` page lives — is never reached:

1. The RSC render throws. React does not reject the stream for that; it writes an **error row** into the
   payload, and `renderComponent`'s `onError` reports it (`source: 'render'`) and returns.
2. The SSR pass reads that row, so the shell fails.
3. `renderHTML` catches its own shell failure (`entry.ssr.tsx:115`) and **returns** `{ stream:
failureDocument(error), status: 500 }`.

`renderComponent` hands that back as an ordinary response. Nothing above it knows the render failed.

The framework knows: the testbed's `/crash` page says so in a comment ("the one path the app's `error` page
can't be reached from"), and `failureDocument`'s dev-only text says "so the app's error page could not be
reached either". It is a considered position — but it is not the one the API doc states, and it is not in the
README, so the first an app author hears of it is the day their 500 page does not appear.

### Fix

Two honest options, and they are not equivalent.

- **Reach the error page.** At `entry.ssr.tsx:115` nothing has been written to the socket yet — the response
  has not left `renderComponent`. Re-throwing the shell failure instead of absorbing it would put the fault in
  front of `app.onError`, which already renders the `error` page from a _fresh_ render for the module-load
  case. `failureDocument` stays as the last resort for a build with no `error` page, and for an `error` page
  that itself fails. Worth checking before doing it: the failed render's teardown (`release()`, the RSC
  stream's abort) has to be complete, and `beginPageRender(c)` has already marked the context, so the error
  page's own `ctx.setHeader` would still throw — which is the existing behaviour on the module-load path too.
- **Say so instead.** Document it on `RouteConfig.error` and in the README: the `error` page answers for a
  request that fails _around_ the render, and a page that throws _during_ it gets the framework's document,
  because the payload is already half-consumed.

The first is what an app author expects and what every comparable framework does. The second is a one-line
change and no risk. What is not defensible is the current gap between the doc and the behaviour.

---

# C2 — One fault, two reports: `render` and then `ssr`

**Severity: medium.** Not wrong output — wrong _volume_, on the path an error tracker cares about most.

### Issue

`reportServerError` keeps an `alreadyReported` WeakSet so that "one fault is reported once, however many
stages it crosses", and `prod.test.mjs` asserts exactly that for a thrown action. It does not hold for a
thrown page. One document request to `/crash?render=1`, counting the testbed's `onServerError` lines:

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
`Error` that carries only a `digest`; nothing links it to the RSC-layer error that produced it.

`entry.ssr.tsx` already knows the shape of this problem — its `onError` drops anything carrying a `digest`
precisely because "the RSC layer has already reported those in full". `onShellError` is the path with no such
guard, and `entry.ssr.tsx:113` calls it for the shell failure whenever `error !== reported`.

### Fix

The digest is the link. An error reaching `onShellError` that carries a `digest` came out of the payload, so
the RSC layer has already reported it — the same test `onError` two lines above already makes. Dropping those
would leave `onShellError` for what it is named after: a failure that started in SSR.

The existing test would need tightening with it: `prod.test.mjs` asserts
`/\[error-reporter\] (?:render|ssr) \/crash/`, which passes on either, and would keep passing if this
regressed.

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
the report for errors. A `notFound()` from the `error` page is the other half of the question and wants an
answer too — recursion there has to terminate, which is why the notFound path honours only a redirect.

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
reaches a page.

### Cause

The shadow check compares the app's routes with **each other**. The framework's own mounts — `/_static` on
every target, and on `cloudflare` the `__ssg` asset prefix — are not in that comparison, so a route they
shadow is invisible to it. The README calls `/_static` "a reserved prefix an app should not be matching on
purpose anyway", which is true and is not a check.

### Fix

One rule beside the others in `assertNothingIsShadowed`: a route whose path starts with a framework-reserved
prefix is refused by name, with the prefix in the message. It is a build-time refusal for a route that cannot
work, which is what the rest of that file does.

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

### Cause

`cli/dev.ts:262` mounts the static app on the dev **front-end**, ahead of the catch-all that proxies to the
worker. So `/_static/*` is answered before the app is reached, and the app's middleware never runs for it —
the shape production was changed to stop having.

### Fix

Either proxy `/_static` to the worker like everything else and let the app's middleware wrap it, or say in
the dev-server docs that assets bypass middleware in dev. The first keeps dev honest about the CSP an app is
developing against; the second is a sentence. Not both.

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

Two clauses in `isStorableSegment`: refuse the reserved device names (case-insensitively, extension or not),
and refuse a trailing `.` or space. The message that already exists for an unportable character covers both.

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

`return exit(1)` in all three; `readPort` becomes `async` or hands its failure back to `main`, which is where
the other flag errors are already answered.

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
- **Refusals.** The framework's plain-text answers agree on `Vary: RSC` and `private, no-cache`; the cross-site
  form refusal keys on `Sec-Fetch-Site` **and** `Origin`, refusing the shapes no browser produces.
- **Build-time validation.** The route table, both entry modules, every route's own module, and now the app's
  server actions; a duplicate path, a shadowed pattern, a bad `method`, a `staticPaths` on a dynamic route and
  a `'use client'` page are each refused by name.
- **Packaging.** 144 files, 302 kB, `dist` and `bin` only — no `src`, no `.d.ts.map`. All three entry points
  resolve, ESM-only, and the `engines` floor covers every API used (`process.loadEnvFile`, `URL.parse`,
  `Promise.withResolvers`).
- **The four deploy targets.** Each builds, and each is exercised in the suite through the handoff its platform
  actually performs — including the Vercel launcher's `(IncomingMessage, ServerResponse)` pair and the
  Cloudflare assets binding.
