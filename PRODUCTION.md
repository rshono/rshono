# Pre-Production Review — `packages/core` 1.0.0

Final review before 1.0.0. Every finding was reproduced against a real build of `apps/testbed` and a
running production server — nothing here is inferred from reading alone.

**Environment.** `@rshono/core@1.0.0-rc.19` · Rspack 2.2.2 · React 19.2.8 · Hono 4.13.5 · Node 22.22.2
**Baseline.** `npm test` 303/303 pass · `typecheck` clean · `eslint packages/core` clean · coverage 83.44 / 91.39 / 78.42
**Verified.** 2026-09-02 at `78650f2` — all 14 findings re-reproduced from scratch.

> **All 14 findings are real. None is struck as a non-bug.**
> Four *supporting details* were wrong and are struck through where they appear: M1's README
> attribution, L4's nonce count, L5's coverage branch figure, and two line numbers (L1, L5). None
> changes a verdict.

---

## Summary

| #      | Issue                                                              | Fix                                          | Kind      |
| ------ | ------------------------------------------------------------------ | -------------------------------------------- | --------- |
| **H1** | Server bundles ship React's **development** builds — 2× every target | 2-line loader change                         | **Code**  |
| **M1** | JSDoc prescribes `useNavigation().url` for a static route's query — it's the same frozen URL | Correct the JSDoc            | Docs      |
| **M2** | *Any* cross-site form POST to a page route is refused, message blames a server action | Reword the 403 + README line | Code + docs |
| **M3** | A malformed action body is a 500 + error-tracker page, not a 400   | Wrap the decode                              | **Code**  |
| **M4** | `notFound()` always costs a full document load on a soft navigation | State it in the README                       | Docs      |
| **L1** | Two shapes of dead route pass the shadow check                     | Normalise the key                            | Code      |
| **L2** | An unknown CLI flag prints a raw Node stack trace                  | Wrap `parseArgs`                             | Code      |
| **L3** | `HOST` is read, then silently dropped by `rshono dev`              | Scope the doc, or warn                       | Docs      |
| **L4** | Prerendered documents bake in a build-time CSP nonce               | Prerender without a nonce                    | Code      |
| **L5** | Five smaller things — see below                                    | Assorted                                     | Polish    |

**Suggested order:** H1 (biggest win, smallest patch) → M3 (client-reachable 500) → L1, L2, L4 (small
code fixes) → M1, M2, M4, L3 (documentation) → L5 (polish).

---

# H1 — Server bundles ship React's development builds

**Severity: high.** The one finding that costs something on every deploy.

### Issue

`dist/server/main.mjs` is **809,447 B minified**, and roughly half of it is React development builds
that can never run. All six appear in the source map, along with a dev-only warning string:

```
react-dom/cjs/react-dom-server-legacy.node.development.js      395 KB
react-dom/cjs/react-dom-server.node.development.js             429 KB
react-dom/cjs/react-dom.development.js                          18 KB
react/cjs/react.development.js                                  47 KB
react/cjs/react-jsx-runtime.development.js                      12 KB
react-server-dom-rspack/cjs/…-client.node.development.js       201 KB

$ grep -c "Each child in a list should have a unique" dist/server/main.mjs
1        # a dev-only React warning string, in a production bundle
```

**Impact is size and cold-start only, not behaviour** — the prelude compiled into the bundle reads
`{env:{NODE_ENV:"production",…}}`, so the correct build is still the one that executes. On `vercel` and
`aws-lambda` it is upload weight and parse time on every cold start; on `cloudflare` it eats half the
Worker size budget.

### Cause

Every React entry wrapper is a runtime branch:

```js
if (process.env.NODE_ENV === 'production') { s = require('./cjs/…production.js'); }
else                                       { s = require('./cjs/…development.js'); }
```

Rspack normally erases the dead half via the DefinePlugin that `mode: 'production'` installs. But
DefinePlugin respects lexical scope — it will **not** substitute an expression whose root identifier is
a local binding, and `env-shadow-loader.cjs:99` prepends exactly such a binding to every SSR-layer
module:

```js
const process = Object.assign(Object.create(globalThis.process ?? Object.prototype), { env: {…} });
```

So in the **SSR layer** the branch stays dynamic and both halves are bundled. Two controls confirm the
scope: the **RSC layer** gets no prelude and is clean in the same map
(`react-server-dom-rspack-server.node.production.js` only), and the **client bundle** is clean too
(264 KB, no development React) because DefinePlugin replaces the whole `process.env` expression there.

### Fix

Make the one variable that gates dead-code elimination statically known again, before the prelude
shadows the binding — two lines:

```diff
--- a/packages/core/src/builder/env-shadow-loader.cjs
-  const { prelude, layer, appSrcPrefix } = this.getOptions();
+  const { prelude, layer, appSrcPrefix, nodeEnv } = this.getOptions();
@@
+  if (nodeEnv) source = source.replace(/process\.env\.NODE_ENV/g, JSON.stringify(nodeEnv));
   const prologue = source.match(DIRECTIVE_PROLOGUE)[0];

--- a/packages/core/src/builder/rspack-config.ts   (SSR-layer loader options, ~line 345)
                 layer: Layers.ssr,
+                nodeEnv: mode,
```

The substituted value is the one the prelude's `env` literal already carries, so the env shadow's
security property is unchanged. The substitution is textual, like the prelude insertion beside it —
the same class of risk as DefinePlugin's own, which every other module already gets.

**Measured with the patch applied, then reverted:**

| target       | before  | after   | change   |
| ------------ | ------- | ------- | -------- |
| `node`       | 809,447 | 398,635 | **−50.7%** |
| `cloudflare` | 793,162 | 383,020 | **−52%** |
| `vercel`     | 806,314 | 395,592 | **−51%** |

All six development modules leave the bundle and `npm test` still passes 303/303 (dev and production
builds both). Because the patch was the *only* change, this is also what establishes DefinePlugin's
lexical-scope behaviour as the cause rather than a correlation.

### Related — worth a line in the deployment docs

`dist/server` totals **4.3 MB**, of which `main.mjs.map` is **3,457,162 B (78%)**. `vercel/build.ts:50`
`cpSync`s the whole of `dist/server` into the function, and the `aws-lambda` hint is
`'zip dist/ with the handler at dist/server/main.mjs'`. The map is deliberate — `onServerError` gets
mapped frames — but it is most of what those two targets upload, and that is worth saying out loud.

---

# M1 — `useNavigation().url` is wrong on a `render: 'static'` route

### Issue

`entry.rsc.tsx:300` puts the page's URL into the payload as a `RouterProvider` prop, and on a
prerendered route that URL is frozen at build time:

```tsx
<RouterProvider href={props.url.href} params={props.params}>
```

So a visitor at `/docs/getting-started?tab=x` gets the **wrong origin and no query string**, on first
paint and after a soft navigation alike:

```
$ curl -s -H 'RSC: 1' 'http://127.0.0.1:4461/docs/getting-started?tab=x' | grep -o '"href":"https[^"]*"'
"href":"https://rshono.example/docs/getting-started"     # wrong origin, query gone
# served from disk — this is what a soft navigation gets:
cache-control: public, max-age=300     etag: W/"WB1k5eZLRbGubImY7Xq4TI"

$ curl -s -H 'RSC: 1' 'http://127.0.0.1:4461/profile/42?tab=x' | grep -o '"href":"http[^"]*"'
"href":"http://127.0.0.1:4461/profile/42?tab=x"          # a dynamic route, for contrast
```

**This is exactly what the docs prescribe as the workaround.** `PageProps.url` (`router.ts:60-62`)
~~and the README both say~~ says:

> On a `render: 'static'` route this is the build-time URL […] so `url.searchParams` is always empty.
> **Read the query from `useNavigation().url` in a `'use client'` component instead**, or mark the route
> `render: 'dynamic'`.

The second half of that advice is sound; the first half cannot work. `RouterProvider`
(`navigation.tsx:75`) does `new URL(href)` from that same payload prop and `useNavigation()` returns it
unchanged — so on a static route the hook and `PageProps` carry the **same** frozen URL, and neither can
see the query. Nothing in the suite catches it: `NavInfo`, the only `useNavigation()` consumer in the
testbed, is mounted on `/profile/:id`, a dynamic route.

> **Correction — the original finding also blamed the README; that part was not real.** The misleading advice is in the `PageProps.url`
> JSDoc **only** (`packages/core/src/router.ts:60-62`). The core README's one line on the subject
> (`README.md:103`) reads "The same pair reaches a `'use client'` component from `useNavigation()`, so a
> read moves across the boundary unchanged" — *consistent* with the defect rather than a victim of it.
> The root `README.md` is a 34-line monorepo index and mentions neither. **So this is a one-JSDoc fix,
> not a two-document one.**

### Fix

Correct the JSDoc: on a static route the URL is fixed at build time in *both* places, and
`render: 'dynamic'` or a `location`-reading effect are the only ways to see the query.

The alternative — having the client re-provide the live URL after hydration for payloads it knows are
prerendered — is a real option, but the doc correction is the honest 1.0 answer.

---

# M2 — *Any* cross-site form POST to a page route is refused

### Issue

`entry.rsc.tsx:429` runs `refusesCrossSiteForm(c)` for every form-content-type POST reaching a page
route, **before** the body is parsed — so before it is known whether the post carries a `$ACTION_*`
field at all:

```
# TESTBED_CSRF=off, so this is the framework's own check, not hono/csrf
$ curl -X POST -H 'Origin: https://idp.example' -H 'sec-fetch-site: cross-site' \
       -H 'content-type: application/x-www-form-urlencoded' --data 'SAMLResponse=abc' :4457/login
Forbidden: cross-site form post to a server action     (403)

# the same request with a non-form content type is let through, confirming the check keys
# on the content type rather than on the presence of an action:
$ curl -X POST … -H 'content-type: application/json' --data '{}' :4457/login      → 200
```

The cause is in `request.ts`, not `entry.rsc.tsx`: `parseRenderRequest` returns `{ kind: 'form-action' }`
for **any** POST matching `FORM_CONTENT_TYPES` once no `x-rsc-action` header is present. There is no
body inspection, so a `$ACTION_*` field is never looked for.

Refusing before parsing is defensible — you cannot know it is not an action without buffering an
untrusted body. Two consequences are simply not written down:

- **The message misattributes.** No server action was involved in the request above.
- **The limitation is broader than documented.** `refusesCrossSiteForm`'s doc comment says the cost is
  that "an app deliberately accepting *form* posts to an **action** from another origin of its own
  cannot". In fact a page route cannot accept *any* cross-site form post — the arrival shape of SAML
  ACS, OIDC `response_mode=form_post`, and most payment-gateway returns. The core README has zero
  occurrences of "cross-site", "form post", "SAML" or "form_post".

The escape hatch works but is undiscoverable: `{ type: 'endpoint' }` routes call the app handler
directly (`entry.rsc.tsx:612`) and never reach `renderPage` — verified, such a POST is **not** a 403.

### Fix

Two small changes:

1. Reword the 403 to name the real constraint — *"cross-site form post to a page route — a page route
   cannot accept one; use an `{ type: 'endpoint' }` route"*.
2. Add the limitation, and the endpoint escape hatch, to the README's limitations list.

---

# M3 — A malformed server-action body is a 500, not a 400

### Issue

`entry.rsc.tsx:408-411` reads and decodes the action payload **outside** the `try` that guards the
action call, so a decode failure escapes to Hono's `onError` and is reported as `source: 'request'`.
All four shapes reproduce, using a real action id:

| request                                  | status | reported as                                          |
| ---------------------------------------- | ------ | ---------------------------------------------------- |
| garbage body, `text/plain`               | 500    | `SyntaxError: Unexpected token 'o' … not valid JSON` |
| empty body                               | 500    | `SyntaxError: Unexpected end of JSON input`          |
| bogus `multipart/form-data`              | 500    | `TypeError: Failed to parse body as FormData.`       |
| `$ACTION_ID_deadbeef` in the form branch | 500    | `Could not find the module "deadbeef" …`             |

Each also emitted `[error-reporter] request /users #<uuid>: …`, i.e. it pages whoever owns the error
tracker.

**Action ids are public** — bare `createServerReference("4096cb98…")` string literals in
`dist/static/chunks/*.js` — so any unauthenticated client can mint 500s at will.

The framework already answers the neighbouring case correctly: an unknown action id is a clean
`400 Bad Request: unknown server action` (`entry.rsc.tsx:400`), and that check was clearly written with
exactly this in mind. An undecodable body is the same class of thing — a malformed request, not a
server fault.

### Fix

Wrap the decode — `request.text()` / `request.formData()`, `decodeReply`, `decodeAction` — so it answers
400 and never reaches `reportServerError`. Pull `loadServerAction` inside the same guard: it too can
throw synchronously, for a manifest entry whose module will not load.

---

# M4 — `notFound()` always costs a full document load on a soft navigation

### Issue

For a flight fetch, `renderComponent` returns at `entry.rsc.tsx:346` —
`return c.body(releaseWhenDone(rscStream, release), …)` — *before* awaiting anything, so the response is
committed as `200 text/x-component` the instant it is returned. `shellFlushed` is still `false` when
`onError` fires, so the control signal is written into the payload as a digest and no status change is
possible.

A `notFound()` from the **first line** of a page component therefore cannot be a 404 on that path — the
"however early it is called" claim is exact, not rhetorical. The client's only recovery is
`reloadOnceForLateNotFound()` (`entry.client.tsx:326`): a real `window.location.reload()`, guarded by a
per-URL `sessionStorage` key that `main()` releases once the reloaded document turns out to be the 404
page.

`redirect()` is unaffected — `handleControlDigest` takes the `push(redirect.location)` branch two lines
below, which is still soft. **That asymmetry is the part worth naming explicitly.**

This is deliberate, self-healing, and tested (`test/prod.test.mjs:264` asserts `flight.status === 200`
and a `/RSHONO_NOT_FOUND/` payload). What is missing is the user-facing statement of the cost. The
README (`packages/core/README.md:305`) frames the whole subject as *late* signals:

> **`redirect()` and `notFound()` must be reached before the page shell is sent.** […] Called from a
> `<Suspense>` boundary that resolves later, the signal can no longer be a 3xx or a 404.

On a soft navigation there is no shell, so "before the shell" is unachievable — every `notFound()`
degrades, and every soft navigation to a not-found page costs an extra round trip and a full document
parse. Nothing in the README tells a reader that.

### Fix

Documentation only. State that on a soft navigation there is no shell to beat, that every `notFound()`
therefore costs a document load, and that `redirect()` does not.

---

# L1 — Two shapes of dead route pass the shadow check

### Issue

`assertNothingIsShadowed` (~~`validate-entries.ts:147`~~ `runtime/validate-entries.ts:141`) keys on the
literal path string — `` `${method} ${route.path}` `` at line 152 — so two routes Hono considers the
same pattern hash differently and both are accepted. Verified against the built validator, with an
exact duplicate as the control:

```
/u/:id  then /u/:name   → ACCEPTED      # second route is dead
/a/*    then /a/b       → ACCEPTED      # second route is dead
/u/:id  then /u/:id     → REFUSED       # the control: "routes[1] … would never run"
```

And against Hono 4.13.5 directly, confirming the accepted routes really are unreachable:

```
GET /users/7   with /users/:id then /users/:name   → the FIRST handler   (:name never runs)
GET /a/b       with /a/* then /a/b                 → the WILDCARD        (/a/b never runs)
```

Both are exactly the failure this validator exists to prevent: a build that exits 0 with a route in it
that can never answer. The doc comment above the function does discuss a catch-all registered *behind*
a route, but not a wildcard registered *ahead* of a concrete path.

### Fix

Normalising param names into the key (`/u/:id` → `/u/:`) closes the first shape in one line. The
wildcard shape needs the key to be wildcard-aware, and a line in the doc comment.

---

# L2 — An unknown CLI flag prints a raw Node stack trace

### Issue

`parseArgs` is the first statement of `main()` (`cli/index.ts:39`) with no `try` between it and
`main().catch` at `cli/index.ts:90`, which is `console.error(error)` — the raw error object:

```
$ rshono build --porf 3000
TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--porf'. To specify a positional argument …
    at checkOptionUsage (node:internal/util/parse_args/parse_args:102:13)
    at parseArgs (node:internal/util/parse_args/parse_args:373:3)
    at main (…/packages/core/src/cli/index.ts:39:35)
    …                                                        # 9 frames in total
```

Every other bad input is a clean line, in the same run:

```
$ rshono bogus               → rshono: unknown command "bogus"  + help
$ rshono start --port abc    → rshono: invalid --port "abc" — expected an integer between 0 and 65535.
```

A typo'd flag is the most likely of the three and gets the worst output.

### Fix

Wrap `parseArgs` and print `rshono: <message>` plus `HELP`, matching the other two paths.

---

# L3 — `HOST` is read by the CLI, then silently dropped by `rshono dev`

### Issue

`cli/index.ts:70` reads `process.env.HOST`, but `cli/index.ts:74` passes only
`{ rootDir, port, config }` to `devCommand`. The drop is structural, not conditional: `DevOptions`
(`cli/dev.ts:79-83`) declares no `host` field at all, and `dev.ts:328` binds
`serve({ …, hostname: '127.0.0.1' })` unconditionally. `start` does receive it (`cli/index.ts:82`).

So `HOST=0.0.0.0 rshono dev` does nothing, with no message.

Binding dev to loopback is the right call — dev source maps embed `'use server'` source. The problem is
that `packages/core/README.md:38` sits immediately under the three-command block at lines 33-35 with
nothing scoping it to `start`:

> `--port` / `PORT` and `HOST` set where it listens

That reads as applying to all three commands, and `HOST` appears nowhere in the `-h` help text
(`cli/index.ts:13-26`).

### Fix

Either scope the README line — "`HOST` applies to `start`; `dev` always binds 127.0.0.1" — or warn when
`HOST` is set under `dev`. Ideally both.

---

# L4 — Prerendered documents bake in a build-time CSP nonce

### Issue

The prerender pass renders through the app's full middleware, so `secureHeaders({ …NONCE })` mints a
nonce at build time and the framework stamps it into the file that ships — ~~×5~~ **×6** identical,
frozen:

```
$ TESTBED_CSP=1 rshono build
  • prerendered 3 static page(s): /docs/getting-started, /docs/deployment, /docs/café
$ grep -o 'nonce="[^"]*"' dist/ssg/docs/getting-started/index.html | sort | uniq -c
   6 nonce="u72ZIGvaWj6USsfwbZdUfQ=="
$ grep -c nonce dist/ssg/docs/getting-started/index.rsc
0                                        # the flight variant is already nonce-free
```

There are two cases, and both are confirmed:

- **Global nonce policy → dead bytes.** These files are never served. Against a running
  `TESTBED_CSP=1` server, two successive requests return *different* nonces (`2Kx2vfeWuHcz…`,
  `Pw2wiWO/SOy/…`), neither the baked one, under `cache-control: private, no-cache` — the
  rendered-per-request signature, not the `public, max-age=300` a disk-served page carries. So
  `mustRenderForNonce` (`entry.rsc.tsx:563`) behaves correctly, and the cost is dead bytes plus a build
  that reports "prerendered 3 static page(s)" for pages the deployment will never serve.
- **Scoped nonce policy → the stale nonce ships.** `cspNonce(c)` is just `c.get('secureHeadersNonce')`
  (`entry.rsc.tsx:115-117`), so on a path `secureHeaders` never ran on it is `undefined`,
  `mustRenderForNonce` is false, and the file is served with the build-time nonce in it. The client
  picks it up as `__webpack_nonce__` — inert without a nonce CSP on that path, but not something anyone
  would want to explain twice.

### Fix

Have the prerender pass ask for a document with **no nonce**, the way it already asks for the `RSC: 1`
variant. The flight variant comes out nonce-free today; rendering the document variant the same way
removes the whole question.

---

# L5 — Smaller things

### `getRequestContext().env` snapshots `process.env` per *process*, not per request

`context.ts:76` memoises `{ ...process.env }` in a module-level `envSnapshot`. The public JSDoc at
`context.ts:312` says "Computed once and cached", which reads as per-request; the process-wide half is
only in the code comment at `context.ts:70-72`. A runtime mutation of `process.env` after the first
`ctx.env` read is never seen.

**Fix:** one clause in the public doc.

### `readBuildMarker` returns any string as a `DeployTarget`

`deploy/build-marker.ts:26` is `return typeof parsed.deploy === 'string' ? parsed.deploy : null` — a
bare `typeof` test with no `DEPLOY_TARGETS` membership check, so the declared `DeployTarget | null` is
not what it guarantees. One consumer, `cli/start.ts:24`, which only compares `!== 'node'` to print a
refusal and exit — so an unknown newer target is reported by name rather than crashing, which is the
deliberate tolerance. Type-accuracy nit, no behavioural bug.

**Fix:** validate against `DEPLOY_TARGETS`, or widen the return type to `string | null`.

### `decodeAction` / `decodeFormState` are passed a `serverManifest` the runtime ignores

`react-server-dom-rspack@0.1.0` exports exactly:

```js
exports.decodeAction = function (body) { …
exports.decodeFormState = function (actionResult, body) { …
```

One and two parameters — the file reads `__rspack_rsc_manifest__.serverManifest` internally. The
hand-written declaration at `types/react-server-dom-rspack.d.ts:40,42` invents an extra
`serverManifest` parameter, and the call sites (`entry.rsc.tsx:433` and ~~`:442`~~ `:448`) both pass a
surplus argument that JS discards. Harmless, but this declaration's stated purpose is to describe only
what the framework actually calls.

**Fix:** drop the extra parameter from the declaration and the two call sites.

### `.d.ts.map` files ship, `src/` does not

**46** declaration maps totalling **29,185 bytes** point at `../src/*.ts`, which `files: ["dist","bin"]`
excludes — so go-to-definition in a consumer's editor lands on nothing. The `.js.map` files are fine:
`tsconfig.build.json` sets `inlineSources: true` (line 10), which embeds the source and is what makes
production stack traces readable.

**Fix:** drop `declarationMap` (line 8), or add `src` to `files`.

### The coverage gate measures less than it appears to

`test:coverage` gates on lines ≥ 82 / branches ≥ 90 / functions ≥ 75 over `dist/**` and reports
83.44 / ~~91.65~~ **91.39** / 78.42 — but only modules loaded *in this process* appear.
`entry.rsc.js`, `entry.client.js`, `entry.ssr.js`, `boundaries.js`, `navigation.js` and every
`deploy/*/runtime.js` have **zero** occurrences anywhere in the report, because they only ever execute
inside the bundled testbed in a child process. The whole `runtime/` section is just `context.js`,
`control.js`, `flight-inject.js`, `hot-update.js`, `request.js` and `validate-entries.js`; `deploy/`
lists only `build-marker.js`, `presets.js` and the `cloudflare` / `vercel` `build.js` files.

The request hot path *is* covered — thoroughly, by the e2e suites — but not by this number, which sits
1.4 points above its floor (83.44 vs 82; branches 91.39 vs 90) and is one refactor away from failing
for no reason.

**Fix:** a comment in `package.json` saying what the number does and does not cover, or a floor set from
what the table actually measures.

---

# Checked and correct — no action

Verified against a real build and server, and behaving as documented:

- **Packaging.** ESM-only is real: `require('@rshono/core')` → `ERR_PACKAGE_PATH_NOT_EXPORTED`, and all
  three entries (`.`, `/server`, `/client`) import cleanly in plain Node outside the bundler.
- **Method surface.** A page route answers `GET`, `POST` and `HEAD` and 404s everything else (`OPTIONS`
  → 404). `HEAD` is dispatched by Hono as `GET` and rebuilt bodiless, so the `'head'`-less `HTTPMethod`
  union and the `'get'`-only registrations are right. An endpoint answers exactly the methods it lists
  (`['get','delete']` → 200/200, POST/PUT/PATCH/OPTIONS → 404).
- **`HEAD` promises what `GET` sends.** `HEAD /docs/getting-started` returns `content-length: 9296`,
  `etag`, `cache-control: public, max-age=300` — byte-identical to the `GET` head.
- **Prerendered serving.** Both representations from disk, weak `ETag`, `If-None-Match` → 304,
  `If-None-Match: *` → 304, a percent-encoded slug (`/docs/caf%C3%A9`) resolving to the file the build
  wrote.
- **Path safety.** `/_static/../../package.json`, `/_static/..%2f..%2fpackage.json`,
  `/_static/%2e%2e/%2e%2e/package.json` and `/../package.json` all 404.
  `/docs/..%2f..%2fpackage.json` is a prerender *miss* that falls through to SSR, which is the
  documented design.
- **Action-id handling.** `__proto__` and `constructor` as action ids → `400 Bad Request: unknown server
  action`, not a prototype lookup.
- **Header floor.** `nosniff` / `Referrer-Policy` / `X-Frame-Options` on every response including error
  and 404 paths; `Vary: RSC` and `private, no-cache` on page content types only; `text/plain` 404s and
  500s carry an explicit `cache-control` of their own.
- **`HTTPException` passthrough.** `csrf()`'s 403 and `bodyLimit()`'s 413 keep their status instead of
  becoming the 500 page.
- **Client disconnects are clean.** 40 aborts mid-stream (document and flight) produced no error
  output, no unhandled rejection, and no degradation.
- **`.env` precedence.** `process.loadEnvFile` does not override an existing variable — confirmed
  directly — so `.env.local` beats `.env` and the real environment beats both, exactly as documented.
- **Transformer `cancel`.** Node 22 does fire `TransformStream` transformer `cancel` on a cancelled
  readable, so the `releaseWhenDone` / `flight-inject` teardown paths are reachable as designed.
- **Client bundle hygiene.** No development React in `dist/static` (264 KB total); the H1 defect is
  server-side only.
- **Build-time refusals.** Duplicate exact paths, a `src/server.ts` that is not a Hono app, four broken
  route modules named at once, a static page that throws, and a `'use client'` module importing
  `@rshono/core/server` all fail the build with a message naming the file.
