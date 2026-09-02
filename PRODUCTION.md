# Pre-Production changes, fixes and improvements

Final review of `packages/core` before 1.0.0. Every finding below was reproduced against a real build
of `apps/testbed` (`@rshono/core@1.0.0-rc.19`, Rspack 2.2.2, React 19.2.8, Hono 4.13.5, Node 22.22.2) —
no finding is inferred from reading alone.

Baseline: `npm test` 303/303 pass, `npm run typecheck` clean, `eslint packages/core` clean.

---

## H1 — Production server bundles ship React's **development** builds (~2× bundle size, every target)

**Severity: high.** The one finding here that costs something on every deploy.

`dist/server/main.mjs` for the testbed is **809 KB minified**. Half of it is React's development
builds, which can never run.

```
$ node -e "JSON.parse(fs.readFileSync('dist/server/main.mjs.map')).sources.filter(s=>/development/.test(s))"
react-dom/cjs/react-dom-server-legacy.node.development.js      395 KB
react-dom/cjs/react-dom-server.node.development.js             429 KB
react-dom/cjs/react-dom.development.js                          18 KB
react/cjs/react.development.js                                  47 KB
react/cjs/react-jsx-runtime.development.js                      12 KB
react-server-dom-rspack/cjs/…-client.node.development.js       201 KB

$ grep -c "Each child in a list should have a unique" dist/server/main.mjs
1        # a dev-only React warning string, in a production bundle
```

### Cause

`react-dom/server.node.js` (and every other React entry wrapper) is a runtime branch:

```js
if (process.env.NODE_ENV === 'production') { s = require('./cjs/…production.js'); }
else                                       { s = require('./cjs/…development.js'); }
```

Rspack normally erases the dead half, because `mode: 'production'` installs a DefinePlugin for
`process.env.NODE_ENV`. DefinePlugin respects lexical scope: it will **not** substitute an expression
whose root identifier is a local binding — and `env-shadow-loader.cjs` prepends exactly such a binding
to every SSR-layer module (`src/builder/env-shadow-loader.cjs:99`):

```js
const process = Object.assign(Object.create(globalThis.process ?? Object.prototype), { env: {…} });
```

So in the **SSR layer** the branch stays dynamic and both sides are bundled. The RSC layer, which gets
no prelude, is unaffected — visible in the same source map: `react-server-dom-rspack-server.node.*`
appears only as `.production.js`. The client bundle is likewise clean (DefinePlugin replaces the whole
`process.env` expression there, so nothing is shadowed).

The correct build still *runs* — the prelude's `env` literal carries `NODE_ENV: 'production'` — so this
is size and cold-start cost, not a behaviour bug. On `vercel` and `aws-lambda` it is upload weight and
parse time on every cold start; on `cloudflare` it eats half the Worker size budget.

### Verified remedy

Make the one variable that gates dead-code elimination statically known again, before the prelude
shadows the binding. Two lines:

```diff
--- a/packages/core/src/builder/env-shadow-loader.cjs
-  const { prelude, layer, appSrcPrefix } = this.getOptions();
+  const { prelude, layer, appSrcPrefix, nodeEnv } = this.getOptions();
@@
+  if (nodeEnv) source = source.replace(/process\.env\.NODE_ENV/g, JSON.stringify(nodeEnv));
   const prologue = source.match(DIRECTIVE_PROLOGUE)[0];

--- a/packages/core/src/builder/rspack-config.ts   (the SSR-layer loader options, ~line 345)
                 layer: Layers.ssr,
+                nodeEnv: mode,
```

The substituted value is the same one the prelude's `env` literal already carries, so nothing about the
env shadow's security property changes. Measured with the patch applied, then reverted:

| target       | before  | after   |         |
| ------------ | ------- | ------- | ------- |
| `node`       | 809,192 | 398,470 | **−51%** |
| `cloudflare` | 793,162 | 383,020 | **−52%** |
| `vercel`     | 806,314 | 395,592 | **−51%** |

All six development modules leave the bundle; `npm test` still passes 303/303 (dev and production
builds both). The substitution is textual, like the prelude insertion beside it — same class of risk as
DefinePlugin's own substitution, which every other module in the build already gets.

**Also worth a look while here:** `dist/server` totals **4.3 MB** for the testbed, of which **3.4 MB is
`main.mjs.map`**. `vercel/build.ts:50` `cpSync`s the whole of `dist/server` into the function, and the
`aws-lambda` hint is "zip `dist/`". The map is deliberate (`onServerError` gets mapped frames), but it
is 80% of what those two targets upload, and it is worth saying so in the deployment docs.

---

## M1 — `useNavigation().url` is wrong on a `render: 'static'` route, and the docs point at it

`entry.rsc.tsx:300` puts the page's URL into the payload as a `RouterProvider` prop:

```tsx
<RouterProvider href={props.url.href} params={props.params}>
```

On a prerendered route that URL is frozen at build time. The shipped payload confirms it:

```
$ grep -o '"href":"https[^"]*"' apps/testbed/dist/ssg/docs/getting-started/index.rsc
"href":"https://rshono.example/docs/getting-started"
```

So for a visitor on `http://localhost:4321/docs/getting-started?tab=x`, `useNavigation().url` is
`https://rshono.example/docs/getting-started` — **wrong origin, and no query string** — both on first
paint and after a soft navigation (the prerendered `index.rsc` is what the soft navigation fetches).

This matters because it is exactly what the docs prescribe as the workaround. `PageProps.url`
(`router.ts:60-62`) and the README both say:

> On a `render: 'static'` route this is the build-time URL […] so `url.searchParams` is always empty.
> **Read the query from `useNavigation().url` in a `'use client'` component instead**, or mark the route
> `render: 'dynamic'`.

The second half of that advice is sound; the first half cannot work. Nothing in the suite catches it —
`NavInfo` (the only `useNavigation()` consumer in the testbed) is mounted on `/profile/:id`, a dynamic
route.

**Options:** (a) correct the docs — on a static route the URL is fixed at build time in *both* places,
and `render: 'dynamic'` or a `location`-reading effect are the only ways to see the query; or (b) have
the client re-provide the live URL after hydration for payloads it knows are prerendered. (a) is the
honest 1.0 answer.

---

## M2 — *Any* cross-site form POST to a page route is refused, not just one carrying an action

`entry.rsc.tsx:429` runs `refusesCrossSiteForm(c)` for every form-content-type POST that reaches a page
route, **before** the body is parsed — so before it is known whether the post carries a `$ACTION_*`
field at all.

```
# testbed started with TESTBED_CSRF=off, so this is the framework's own check, not hono/csrf
$ curl -X POST -H 'Origin: https://idp.example' -H 'sec-fetch-site: cross-site' \
       -H 'content-type: application/x-www-form-urlencoded' --data 'SAMLResponse=abc' :4322/login
Forbidden: cross-site form post to a server action     (403)
```

Refusing before parsing is defensible — you cannot know it is not an action without buffering an
untrusted body. But two things follow that are not currently written down:

- **The message misattributes.** No server action was involved in the request above.
- **The limitation is broader than documented.** `refusesCrossSiteForm`'s doc comment says the cost is
  that "an app deliberately accepting *form* posts to an **action** from another origin of its own
  cannot". In fact a page route cannot accept *any* cross-site form post — which is the arrival shape of
  SAML ACS, OIDC `response_mode=form_post`, and most payment-gateway returns. It is not in the README's
  limitations list.

The escape hatch exists and works (`{ type: 'endpoint' }` routes skip this path entirely). It just is
not discoverable from either the message or the docs. Suggest: reword to "cross-site form post to a page
route — a page route cannot accept one; use an `{ type: 'endpoint' }` route", and add a line to the
README's limitations.

---

## M3 — A malformed server-action body is a 500 and an `onServerError` report, not a 400

`entry.rsc.tsx:408-411` reads and decodes the action payload outside the `try` that guards the action
call, so a decode failure escapes to Hono's `onError` and is reported as `source: 'request'`:

```
$ curl -X POST -H "Origin: $B" -H "x-rsc-action: <a real id>" -H 'content-type: text/plain' \
       --data 'not-a-flight-payload' $B/users
→ 500

# server log
[rshono] request error: SyntaxError: Unexpected token 'o', "not-a-flight-payload" is not valid JSON
[error-reporter] request /users #ee3d14d1…: Unexpected token 'o' …
```

Reproduced for three shapes: garbage body, empty body, and a bogus `multipart/form-data` body
(`TypeError: Failed to parse body as FormData.`). Same for a `$ACTION_ID_<unknown>` in the form branch,
where `decodeAction` rejects out of `renderPage`.

Action ids are public — they are string literals in the client bundle — so any unauthenticated client
can mint 500s and pages whoever is on call for the error tracker. The framework already answers the
neighbouring case correctly: an unknown action id is a clean `400 Bad Request: unknown server action`
(`entry.rsc.tsx:400`), and that check was clearly written with exactly this in mind. An undecodable
body is the same class of thing — a malformed request, not a server fault.

Suggest wrapping the decode (`request.text()`/`request.formData()`, `decodeReply`, `decodeAction`) so
it answers 400 and does not reach `reportServerError`. `loadServerAction` is worth pulling inside the
same guard: it too can throw synchronously, for a manifest entry whose module will not load.

---

## M4 — `notFound()` costs a full document load on **every** soft navigation, however early it is called

For a flight fetch, `renderComponent` hands the stream to `c.body(...)` and returns before React has
rendered anything, so the response is committed as `200 text/x-component` the instant it is returned.
A `notFound()` from the first line of a page component therefore cannot be a 404 on that path — it
rides the payload as a digest, and the client's only recovery is `reloadOnceForLateNotFound()`
(`entry.client.tsx:326`): a real browser reload, plus a `sessionStorage` key spent and then released by
`main()` when the reloaded document turns out to be the 404 page.

This is deliberate, tested (`prod.test.mjs:264`) and self-healing. What is missing is the user-facing
statement of it. The README frames the whole subject as *late* signals:

> **`redirect()` and `notFound()` must be reached before the page shell is sent.** […] Called from a
> `<Suspense>` boundary that resolves later, the signal can no longer be a 3xx or a 404.

On a soft navigation there is no shell, and "before the shell" is unachievable — every `notFound()`
degrades, and every soft navigation to a not-found page costs an extra round trip and a full document
parse. `redirect()` is unaffected in practice (the client turns the digest into a `push()`, which is
still soft), which makes the asymmetry worth naming explicitly.

---

## L1 — Two shapes of dead route the shadow check does not catch

`assertNothingIsShadowed` (`validate-entries.ts:147`) keys on the literal path string, so two routes
that Hono considers the same pattern are treated as different paths:

```js
validateRoutesModule({ routes: [
  { path: '/u/:id',   component: … },
  { path: '/u/:name', component: … },   // never runs — Hono matches the first
]});
// => accepted
```

Confirmed against Hono directly: `/users/:id` then `/users/:name`, request `/users/7` → the first
handler. Normalising param names into the key (`/u/:id` → `/u/:`) closes it in one line.

The second shape is a wildcard registered *ahead* of a concrete path — `/a/*` then `/a/b`, where
`/a/b` never runs. The doc comment covers the reverse order ("a catch-all registered *behind* a route")
but not this one.

Both are exactly the failure this validator exists to prevent: a build that exits 0 with a route in it
that can never answer.

---

## L2 — An unknown CLI flag prints a raw Node stack trace

`parseArgs` at `cli/index.ts:39` is outside any handler, so `main().catch` prints the error object:

```
$ rshono build --porf 3000
TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--porf'. To specify a positional argument …
    at checkOptionUsage (node:internal/util/parse_args/parse_args:102:13)
    at parseArgs (node:internal/util/parse_args/parse_args:373:3)
    at main (…/packages/core/src/cli/index.ts:39:35)
    …
```

Every other bad input is a clean line — `rshono: unknown command "bogus"` plus the help,
`rshono: invalid --port "abc" — expected an integer between 0 and 65535.` (both exit 1, verified). A
typo'd flag is the most likely of the three and gets the worst output. Wrapping `parseArgs` and
printing `rshono: <message>` + `HELP` would make it consistent.

---

## L3 — `HOST` is read by the CLI and silently dropped by `rshono dev`

`cli/index.ts:70` reads `process.env.HOST`, and `cli/index.ts:74` passes only `{ rootDir, port, config }`
to `devCommand` — which binds `127.0.0.1` unconditionally. So `HOST=0.0.0.0 rshono dev` does nothing,
with no message.

Binding dev to loopback is the right call (dev source maps embed `'use server'` source, as the README
says). The problem is that the README's line directly under the three commands —

> `--port` / `PORT` and `HOST` set where it listens

— reads as applying to all three, and the `-h` help text mentions `HOST` nowhere at all. Either say
"`HOST` applies to `start`; `dev` always binds 127.0.0.1", or warn when `HOST` is set under `dev`.

---

## L4 — Prerendered documents bake in a build-time CSP nonce

The prerender pass renders through the app's full middleware, so `secureHeaders({ …NONCE })` mints a
nonce at build time and the framework stamps it into the file that ships:

```
$ TESTBED_CSP=1 rshono build && grep -o 'nonce="[^"]*"' dist/ssg/docs/getting-started/index.html
nonce="9dzL1T6JO0Awv7p4E2kq/A=="        # ×5, identical, frozen
```

For an app whose CSP always carries `NONCE` these files are never served — `mustRenderForNonce`
(`entry.rsc.tsx`) correctly renders per request — so the impact is dead bytes and a build that reports
"prerendered 3 static page(s)" for pages the deployment will never serve. Where a nonce policy is
*scoped* (`server.use('/app/*', secureHeaders(…))`) and a static route sits outside it, the stale nonce
is served: the client picks it up as `__webpack_nonce__`, which is inert without a nonce CSP on that
path but is not something anyone would want to explain twice.

The flight variant already comes out nonce-free. Rendering the document variant the same way — the
prerender pass asking for a document with no nonce, the way it asks for the `RSC: 1` variant — removes
the whole question.

---

## L5 — Smaller things

- **`getRequestContext().env` snapshots `process.env` once per process, not per request.**
  `context.ts:76` memoises `{ ...process.env }` in a module-level `envSnapshot`. The JSDoc on
  `RequestContext.env` says "Computed once and cached", which reads as per-request; the process-wide
  half is only in a code comment. A runtime mutation of `process.env` after the first `ctx.env` read is
  never seen. Worth one clause in the public doc.

- **`readBuildMarker` returns any string as a `DeployTarget`** (`build-marker.ts:26`) with no check
  against `DEPLOY_TARGETS`. Only used for a message today, and the tolerance for an unknown newer
  target is deliberate — but the return type says `DeployTarget | null` and that is not what it
  guarantees.

- **`decodeAction` / `decodeFormState` are passed a `serverManifest` the runtime ignores.**
  `react-server-dom-rspack`'s exports are `decodeAction(body)` and `decodeFormState(result, body)` —
  they read `__rspack_rsc_manifest__.serverManifest` themselves. The hand-written declaration in
  `types/react-server-dom-rspack.d.ts:40-42` invents a two/three-argument signature the package does not
  have, and `entry.rsc.tsx:433,442` pass the extra argument. Harmless, but it is a hand-written
  declaration whose stated purpose is to describe only what the framework actually calls.

- **`.d.ts.map` files ship, `src/` does not.** 46 declaration maps (29 KB) point at `../src/*.ts`, which
  `files: ["dist","bin"]` excludes, so go-to-definition in a consumer's editor lands on nothing. The
  `.js.map` files are fine — `inlineSources: true` embeds the source, which is what makes production
  stack traces readable. Either drop `declarationMap` or add `src` to `files`.

- **The coverage gate measures less than it appears to.** `test:coverage` gates on lines ≥ 82 /
  branches ≥ 90 / functions ≥ 75 over `dist/**`, and reports 83.44 / 91.65 / 78.42 — but only modules
  loaded *in this process* appear. `runtime/entry.rsc.js`, `entry.client.js`, `entry.ssr.js`,
  `boundaries.js`, `navigation.js` and every `deploy/*/runtime.js` are absent from the table entirely,
  because they only ever execute inside the bundled testbed in a child process. The request hot path is
  covered — by the e2e suites, thoroughly — but not by this number, which sits 1.4 points above its
  floor and is one refactor away from failing for no reason. Worth a comment in `package.json`, or a
  floor set from what the table actually measures.

---

## Verified as claimed

Checked against a real build and server, and correct:

- **Packaging.** ESM-only is real: `require('@rshono/core')` → `ERR_PACKAGE_PATH_NOT_EXPORTED`, and all
  three entries (`.`, `/server`, `/client`) import cleanly in plain Node outside the bundler.
- **Method surface.** A page route answers `GET`, `POST` and `HEAD` and 404s everything else (`OPTIONS`
  → 404, verified). `HEAD` is dispatched by Hono as `GET` and rebuilt bodiless, so the `'head'`-less
  `HTTPMethod` union and the `'get'`-only registrations are right. An endpoint answers exactly the
  methods it lists (`['get','delete']` → 200/200, POST/PUT/PATCH/OPTIONS → 404).
- **`HEAD` promises what `GET` sends.** `HEAD /docs/getting-started` returns `content-length: 9296`,
  `etag`, `cache-control: public, max-age=300` — byte-identical to the `GET` head.
- **Prerendered serving.** Both representations from disk, weak `ETag`, `If-None-Match` → 304,
  `If-None-Match: *` → 304, a percent-encoded slug (`/docs/caf%C3%A9`) resolving to the file the build
  wrote.
- **Path safety.** `/_static/../../package.json`, `/_static/..%2f..%2fpackage.json`,
  `/_static/%2e%2e/%2e%2e/package.json` and `/../package.json` all 404. `/docs/..%2f..%2fpackage.json`
  is a prerender *miss* that falls through to SSR, which is the documented design.
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

---

## Suggested order

1. **H1** — two lines, halves every server bundle, suite-verified.
2. **M3** — a client-reachable 500 and error-tracker noise; the neighbouring 400 already exists.
3. **M1, M2, M4** — documentation corrections; M2 also wants a reworded 403.
4. **L1** — one line in the shadow key.
5. **L2–L5** — polish.
