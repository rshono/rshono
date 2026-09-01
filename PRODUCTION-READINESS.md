# Production readiness — findings

A pass over the two published packages, `@rshono/create` (the scaffolder) and `@rshono/core` (the
framework), against four questions: is the API correct and minimal, is there dead code, is the
framework easy to understand, and does it fail gracefully.

**Baseline** — `1.0.0-rc.18`, clean working tree, everything green: `eslint .` clean, both packages
typecheck, `@rshono/core` 281/281 and `@rshono/create` 36/36 (+6 opt-in e2e skipped), all 25
`www.rshono.com/docs` links and anchors referenced from `packages/` resolve against the shipped
markdown, no `TODO`/`FIXME`/`HACK` in either `src/`, every `eslint-disable` carries a reason, and no
unused exports in either package's `src/`.

**How to read this.** Every finding below was reproduced against a real build, and the reproduction is
given so it can be re-run or turned into a test. The one exception is **H3**, where one link in the
chain needs a browser and no browser will launch in this environment — it is labelled inline, and the
two links that *could* be checked were.

Severity is about what reaches a user in production, not about how much code it takes to fix.

---

## High

### H1 — ~~`getRequestContext().env` merges the platform adapter's private context object~~

`packages/core/src/runtime/context.ts:316`

```ts
get env(): EnvVars<E> {
  const bindings = this.#raw.env as Record<string, unknown> | undefined;
  return (this.#env = (bindings ? { ...processEnv(), ...bindings } : processEnv()) as EnvVars<E>);
}
```

`c.env` is the second argument to `app.fetch(request, env)` — Workers bindings on `cloudflare`, and on
every other target the adapter's own private handles:

| target             | what `c.env` actually holds                               | source                                          |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------- |
| `node`, `vercel`   | `{ incoming: IncomingMessage, outgoing: ServerResponse }`  | `@hono/node-server` 2.1.1 `dist/index.mjs:1023`  |
| `aws-lambda`       | `{ event, requestContext, context }`                       | `hono/dist/adapter/aws-lambda/handler.js:28`     |

It is spread into `ctx.env` unfiltered, and `ctx.env` is typed `E['Bindings'] & Record<string, string | undefined>`.

**Reproduced, both halves.**

1. On a real `node` build, a page rendering
   `Object.keys(ctx.env).filter((k) => !(k in process.env)).join(',')` emits `incoming,outgoing`.
   `JSON.stringify({ ...process.env, ...c.env })` on that pair throws
   `TypeError: Converting circular structure to JSON`.
2. That the merge is unconditional — that *whatever* an adapter passes lands in `ctx.env` and outranks
   `process.env` — was checked directly against the built testbed bundle, which needs no
   platform-specific build:

   ```js
   const bundle = await import('./dist/server/main.mjs');
   const res = await bundle.app.fetch(new Request('https://example.test/whoami'), {
     event: { headers: { authorization: 'Bearer SECRET-TOKEN', cookie: 'session=abc' } },
     PUBLIC_API_ENDPOINT: 'INJECTED-VIA-THE-ENV-ARGUMENT',
   });
   // → the rendered page contains INJECTED-VIA-THE-ENV-ARGUMENT
   ```

   So the Lambda row of the table follows from the adapter's source with no gap left to argue about.

Three consequences:

- **The type is a lie.** `ctx.env.incoming` is declared `string | undefined` and is a live socket
  wrapper, so `ctx.env.ANYTHING.startsWith(…)` type-checks and can throw at runtime.
- **`JSON.stringify(ctx.env)` throws** on `node`/`vercel` — a plausible thing to do in a log line or an
  error report.
- **On `aws-lambda` it is a disclosure vector.** `event` is plain JSON — the whole invocation, headers
  and cookies and `authorization` included — so unlike the `node` case it serializes cleanly into
  anything `ctx.env` is spread into. This is the same class of leak the `ctx` page prop is made
  non-enumerable to prevent, reached through a different door.

The framework already bakes per-target facts into the bundle (`ServerConfig.trustProxy`, `.outDir`), so
the cheapest correct fix is another one: have `resolveServerConfig` record whether the selected preset
supplies bindings, and merge `c.env` only when it does. Filtering by value type is not equivalent —
Workers bindings (KV, D1, R2) are objects on purpose.

### H2 — ~~a route module that can never work fails at request time, not at build time~~

`packages/core/src/runtime/entry.rsc.tsx:161` and `:611-617`, `packages/core/src/server/ssg.ts:178,271`

Four structural mistakes in a route's module all survive `rshono build` and then answer `500` on every
request in production. Reproduced with one fixture carrying all four; the build printed
`✓ build complete` and **exited 0**, and then:

| route            | mistake                              | what the request gets                                                            |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `/clientpage`    | page module is `'use client'`        | 500 · `[rshono] The page component for "/clientpage" is missing its client-asset info …` |
| `/noexport`      | page module has no default export    | 500 · `[rshono] The page module for "/noexport" must default-export a server component.` |
| `/static-broken` | same, but `render: 'static'`         | 500 · same message, **after the build called it "will SSR per request"**          |
| `/api/bad`       | endpoint exports `GET`, not `handler`| 500 · `TypeError: r is not a function`                                            |

Three distinct problems, one root cause — validation that exists but runs too late:

- **The messages are good and arrive at the worst possible time.** `loadPageModule`
  (`entry.rsc.tsx:161-173`) writes exactly the right thing; it just runs on the first request. `rshono
  build` already imports the server bundle for the prerender pass, so it can resolve every route's
  `component` thunk once and run those same two checks against every route, not only the static ones.
- **The endpoint fork has no check at all.** `entry.rsc.tsx:611-617` destructures `handler` and calls
  it:

  ```ts
  const { handler: endpointHandler } = await loadEndpoint();
  return endpointHandler(c, next);
  ```

  `TypeError: r is not a function` from a minified frame is verbatim the failure mode
  `validate-entries.ts`'s own header names as the reason that file exists ("surfaced as `TypeError: nN
  is not iterable` from a minified bundle … Neither names the file to open"). The page side of the same
  fork gets it right; the endpoint side needs the matching check and message.
- **The prerender pass mislabels a 5xx.** `renderVariant` (`ssg.ts:178`) only asks whether the status
  was 200, so every non-200 gets the same sentence (`ssg.ts:271`, and the summary in `build.ts:87`):

  ```
  ⚠ "/static-broken" rendered 500 at build time — skipping, will SSR per request.
  • skipped 1 (will SSR per request)
  ✓ build complete — run `rshono start`
  ```

  "will SSR per request" is true for the other skip reasons — no `staticPaths`, a wildcard param, a 404,
  a 3xx. For a 5xx it is false: that route will 500 per request, forever, and the build says `✓` and
  exits 0, so CI is green. A 5xx at build time should fail the build.

**Why this matters more than it looks:** `rshono build` runs no type checking — swc strips types and
`tsc` is never invoked (verified: the `/api/bad` fixture builds green, while `tsc --noEmit` on the same
code reports `Property 'handler' is missing … but required in type 'EndpointServerModule'`). Several of
the framework's correctness guarantees are type-only — the `EndpointServerModule` shape, and the
`defineRoutes` path ↔ props and `staticPaths` ↔ path checks — so a user who never runs `typecheck` has
no backstop at all behind the runtime checks. Worth a line in the README's Requirements & limitations
list either way.

### H3 — ~~a late `notFound()` looks like an unbounded reload loop~~

`packages/core/src/runtime/entry.client.tsx:214`, `packages/core/src/runtime/entry.rsc.tsx:245`

> **Resolved.** The reload is now bounded — one attempt per URL per tab, then a "Page not found" panel —
> and the browser suite has a case for each direction of the digest path. Link 2 is still not *executed*
> here: no browser launches in this sandbox, so `test/browser/client-runtime.spec.mjs` runs in CI only. What
> was added locally: the flight payload for the reproduction demonstrably carries `3:E{"digest":"RSHONO_NOT_FOUND"}`,
> a React error row, which is the shape those hooks are handed — so the middle link now rests on the wire
> rather than on the framework's own code.
>
> **Verification status (original).** Two of the three links are reproduced below. The middle one — React handing a
> payload error row to `onCaughtError`/`onUncaughtError` during hydration — needs a real browser, and
> none will launch here (Chromium exits `SIGSEGV`, Firefox fails to launch, WebKit times out, all three
> under `@playwright/test` in this sandbox). It is asserted by the framework's own code in three places,
> but it was not executed. Treat this as high-confidence-unconfirmed, and confirm it with a Playwright
> test before or instead of fixing it.

`redirect()` and `notFound()` raised from a boundary that resolves after the shell degrade to a `200`
carrying a digest. That part is deliberate, documented in the README and tested server-side
(`test/prod.test.mjs:188-213`). The client half is where the two differ:

```ts
const redirect = parseRedirectDigest(digest);
if (!redirect) {
  window.location.reload();          // ← the notFound branch
}
```

**Link 1 — the client takes the reload branch. Reproduced** against the built `dist/runtime/control.js`:

```
parseRedirectDigest('RSHONO_NOT_FOUND')          = null      → reload()
parseRedirectDigest('RSHONO_REDIRECT;303;%2Flogin') = { location: '/login', status: 303 }  → navigate away
isControlDigest('RSHONO_NOT_FOUND')              = true
```

So `redirect()` is terminal — the client goes somewhere else — and `notFound()` is not: there is nothing
to navigate to, so it reloads.

**Link 2 — React routes the digest to those hooks. Not executed.** The framework installs
`onCaughtError`/`onUncaughtError` (`entry.client.tsx:423,428`) for precisely this, with the comment "A
`redirect()` / `notFound()` from a component below the page root reaches us through React: it rides the
flight payload as an error, and boundaries re-throw it so it lands here"; `CatchBoundary.render()`
re-throws control errors to make it so; and `warnLateControlSignal` says a JS client "recovers by
reloading". Three assertions, no test — the browser suite (`test/browser/client-runtime.spec.mjs`) has
no case for a control digest at all.

**Link 3 — the reload gets the identical response. Reproduced** against the testbed production build,
three consecutive requests:

```
req1 status=200 type=text/html;charset=utf-8   digest: RSHONO_NOT_FOUND
req2 status=200 type=text/html;charset=utf-8   digest: RSHONO_NOT_FOUND
req3 status=200 type=text/html;charset=utf-8   digest: RSHONO_NOT_FOUND
```

If link 2 holds, the tab reloads until the user leaves. `warnLateControlSignal` already says the honest
thing — "A JavaScript client recovers by reloading, which renders this same page again" — which is
exactly why it does not recover when the lateness is deterministic. The warning is `isDev`-only, so in
production this is silent.

Wants a bound: reload at most once per document (a `sessionStorage` key, say) and on the second arrival
paint a message rather than reloading again. And a browser test for the digest path, which currently has
none in either direction.

---

## Medium

### M1 — a `/_static` 404 carries no `Cache-Control`

`packages/core/src/server/static.ts:7-16` and `:33`

`cacheControl` returns early for anything that is not `200`/`206`, and the terminal
`c.text('Not Found', 404)` sets no header of its own. Reproduced against the testbed production build —
a real asset next to it for contrast:

```
$ curl -sD - -o /dev/null .../_static/chunks/main.deadbeef.js     $ curl -sD - -o /dev/null .../_static/chunks/<real>.js
HTTP/1.1 404 Not Found                                            HTTP/1.1 200 OK
content-type: text/plain; charset=UTF-8                           cache-control: public, max-age=31536000, immutable
x-content-type-options: nosniff                                   …
…                                                                 
(no cache-control)
```

A 404 is heuristically cacheable under RFC 9111 — which is exactly the reasoning already written above
`plainNotFound` (`entry.rsc.tsx:187`), where the framework sets the header explicitly for this reason.
`/_static` is where it matters most: during a rolling deploy an old instance 404s a chunk the new one
has, and a shared cache may store that answer for a content-hashed URL that is about to become valid.
One line, and the two paths agree.

### M2 — `rshono dev` never picks up a `.env` change

`packages/core/src/cli/index.ts:63-64`, `packages/core/src/builder/public-env.ts`,
`packages/core/src/cli/dev.ts:112`

**Reproduced.** A dev server serving a page that reads three values, before and after editing `.env`:

| read                                              | initial        | after editing `.env` + a source edit | after `rshono dev` restart |
| ------------------------------------------------- | -------------- | ------------------------------------ | -------------------------- |
| server component, `process.env.PUBLIC_APP_NAME`   | `first`        | `first`                              | `second`                   |
| server component, `process.env.SECRET_THING`      | `first-secret` | `first-secret`                       | `second-secret`            |
| client component, `process.env.PUBLIC_APP_NAME`   | `first`        | `first`                              | `second`                   |
| a marker in the client component (rebuild proof)  | `v1`           | **`v2`**                             | `v2`                       |

The marker moving to `v2` proves the rebuild happened and was served; the env values did not move. Only
restarting the dev server picks them up. Three independent reasons stack:

- `loadEnvFiles(rootDir)` runs once, in the CLI process, before `devCommand`.
- `publicEnv(isDev)` is evaluated once inside `createConfigs` and is what `DefinePlugin` and the
  env-shadow prelude bake in; `compiler.watch` reuses that same config object.
- The worker is spawned with `env: process.env` (`dev.ts:112`) and then calls `runtime.loadEnv()`, but
  `process.loadEnvFile` does not override an already-set variable (verified:
  `FOO=from-shell node -e "process.loadEnvFile('.env')"` keeps `from-shell`), so the stale value the
  parent carries wins in every restarted worker too.

The same is true of `rshono.config.ts`, read once at `cli/index.ts:64`.

Neither is wrong as a design decision, and neither is written down: the core README, the scaffolded
README and `docs/configuration.md` all describe `.env` loading without mentioning that dev does not
watch it. This is the kind of gap that costs someone an afternoon. Either watch the two files and
restart, or say so plainly in the docs.

### M3 — importing `@rshono/core/server` from a `'use client'` module fails with a raw resolver error

Reproduced with a `'use client'` component importing `getRequestContext`. The build **does fail** —
exit code 1, correctly — but with this and nothing else:

```
ERROR in node:async_hooks
  × Module build failed:
    ╰─▶   × Reading from "node:async_hooks" is not handled by plugins (Unhandled scheme).
          │ Rspack supports "data:" and "file:" URIs by default.
          │ You may need an additional plugin to handle "node:" URIs.
```

No file path, no issuer, no mention of rshono or of `@rshono/core/server`. Everything else in the
framework names the file to open; this is the one common mistake that does not, and the docs warn
against it often enough to suggest people make it. A client-compiler `resolve.alias` for
`node:async_hooks` pointing at a stub that throws with a real message, or a small plugin that recognises
the request and reports the issuer, would bring it in line.

### M4 — the Biome templates do not exclude `.rshono/`

`packages/create/templates/biome/biome.json`, `packages/create/templates/biome-tailwind/biome.json`

Both list `"!dist", "!.wrangler", "!.vercel", "!.netlify", "!wrangler.jsonc"` — and not `.rshono`, the
dev server's output directory. **Reproduced** on a scaffolded `--quality biome` app with an identically
malformed file planted in each of the two directories:

```
$ pnpm dlx @biomejs/biome@2.5.6 format .
.rshono/server/main.mjs format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Checked 13 files in 19ms. Found 1 error.
```

`dist/server/main.mjs` was skipped, `.rshono/server/main.mjs` was not — so this is the missing exclude
and nothing else. After anyone runs `pnpm dev`, that app's `format:check` and `lint` fail and
`pnpm format` rewrites the generated bundle.

It is specific to Biome, which does not read `.gitignore` unless `vcs.enabled` and `vcs.useIgnoreFile`
are set, and neither is. **The other three toolchains were checked and are fine** — Prettier 3, oxfmt
and oxlint all honour `.gitignore`, verified by moving `.gitignore` aside and watching oxfmt go from
"15 files, all correct" to "16 files, `.rshono/server/main.mjs` has format issues". So the fix is the
two `biome.json` files only.

The intent is already written down, in the one template that gets it right: *"Without this, linting
after a dev run reports on bundles rather than on anything you wrote."* (`templates/eslint/eslint.config.mjs`).

---

## Low

### L1 — `create-rshono` argument handling: three small gaps

All three reproduced; all three in `packages/create/src/cli.ts` / `options.ts`.

**`./` is rejected while `.` works** (`cli.ts:148`, `options.ts:101`):

```
$ create-rshono .  -y --dry-run   →  └  Dry run: nothing was written.
$ create-rshono ./ -y --dry-run   →  ■  "./" does not give a usable npm package name.
```

`cli.ts` special-cases the literal `'.'` and falls back to the directory's basename; `'./'` misses that
branch and reaches `toPackageName('./')`, which strips the leading `./` and the trailing `/` and returns
`null`. Resolving the target directory first and taking its basename whenever the input resolves to the
cwd fixes the class rather than the case. `test/cli.test.mjs:114` covers `'.'` and
`test/plan.test.mjs:435-436` cover `'./nested/my-app'` and `'my-app/'`; `'./'` falls between them.

**`--dry-run` is refused in a non-empty directory** — the conflict check (`cli.ts:151-162`) runs before
the dry-run branch (`cli.ts:235`):

```
$ create-rshono dryrun -y --dry-run
■  "dryrun" is not empty (existing.txt) — pass --force to scaffold into it anyway.
```

A dry run writes nothing, so there is nothing to conflict with, and the advice describes an action the
user did not ask for. Moving the dry-run branch above the check is the minimal fix.

**`toPackageName` can return a name npm rejects** (`options.ts:81,101`). Its doc says it returns "a name
npm will accept, or `null` when nothing usable is left". It strips a leading `-` and rejects a leading
`.`, but not a leading `_`, which npm also refuses: `toPackageName('_leading')` → `'_leading'`, and
`isValidPackageName('_leading')` → `false`. **The CLI is not affected** — it calls both and refuses
correctly (verified) — so this is only a contract violation on a function exported from `api.ts` as part
of the documented programmatic surface. Strip `_` alongside `-`, or fold the validity check in and drop
the two-call dance.

### L2 — every route type error leads with the wrong fix

`packages/core/src/router.ts:403-421`

The array shorthand is a second overload, so a mistake inside a bare array is reported as an
overload-resolution failure with the *object*-form error first. Reproduced:

```
error TS2769: No overload matches this call.
  Overload 1 of 2 … Property 'routes' is missing in type '{ path: string; … }[]'
    but required in type 'RouteConfig<readonly Route[]>'.
  Overload 2 of 2 …
    Type '() => Promise<…>' is not assignable to type
      … & "component props are not satisfied by PageProps<'/u/:id'>"
```

The carefully written message is on line 8; the first thing read is a statement that is false for this
call and points at the wrong change (wrap it in `{ routes: … }`). `types/routes.tsx` already notes that
"an overload mismatch is reported [at] the argument", so the mechanism is understood — the cost to the
reader may not be. A single signature over `readonly Route[] | RouteConfig<…>` with the validation
applied conditionally would produce one error instead of a resolution report.

### L3 — documentation and hygiene

- **`onError` does not carry the note `fallback` does** (`boundaries.tsx:32` and `:122`).
  `ErrorFallback` explains that the function form only works from a `'use client'` component; `onError`
  is equally a function prop with the same restriction and says only "Called with the caught error, for
  logging or reporting" — and the headline use of these components is that a *server* component can
  render them. Worth a sentence. **Kept low deliberately:** the failure was reproduced and React's own
  message is excellent, naming the exact prop, so this is a cosmetic gap rather than a trap:

  ```
  [rshono] render error: Error: Event handlers cannot be passed to Client Component props.
    {loading: <p/>, onError: function onError, children: ...}
                             ^^^^^^^^^^^^^^^^
  ```

  (The page does 500 rather than degrade, but that is React's contract for any function prop, not
  something rshono owns.)
- **`CatchBoundaryProps.resetKeys` documents itself with a hook call** —
  `resetKeys={[useNavigation().url.pathname]}` — which is unreachable from the server component the
  surrounding prose is about. The server-side form (`resetKeys={[url.pathname]}` off `PageProps`) is the
  one most readers need.
- **`weakEtag` is exported for nobody** (`server/prerendered.ts:157`). Referenced only by
  `toPrerenderedPage` in the same file; no other source and no test mentions it. Drop the keyword.
- **A CI comment claims coverage of a feature that does not exist** (`.github/workflows/ci.yml:181`):
  "Soft navigation, **prefetching**, scroll restoration and the fatal overlay only exist in a real
  browser." There is no `prefetch` anywhere in `packages/core/src`; the browser spec pins its *absence*
  (`client-runtime.spec.mjs:78`) and the README lists "No link prefetching" as a deliberate choice.
- Outside the two packages, for completeness: `apps/website/src/components/home.tsx:37` exports an
  unused `Pager`.

---

## Checked and found sound

Recording what was examined and produced no finding, so a later pass need not repeat it.

- **Public API surface.** Three entry points, no wildcard in `exports`, so deep imports into
  `dist/runtime/context.js` are blocked and `runWithContext` / `beginPageRender` / `reportServerError`
  stay out of the published surface and out of semver. The barrels are deliberate.
- **`ctx`'s non-enumerability, and the eight throwing stubs.** Both unusual and both right — the
  reasoning (React's dev-only prop serialization walks own enumerables and would reach `ctx.hono.env`;
  `ctx.redirect()` through `ctx.hono` is a *silent* no-op, which is worse than a throw) is written where
  a maintainer will find it, and `test/prod.test.mjs` asserts the leak does not happen.
- **The control-signal path, server side.** Digest encoding, the shell-flushed race window, the deferred
  abort, `release()` on every exit, the `HEAD` body cancel. The late-signal window is tested from outside
  — both that the digest survives and that the doomed render is wound down in under 1.5s.
- **`flight-inject.ts`.** Permit-based backpressure, the trailer carry, the two cancel paths, and the
  `cancelled` flag standing in for a `cancel` the Streams standard skips. Every branch carries its
  reason; the module exists because an upstream package made a narrower version of the same assumption.
- **Env and secret safety.** The `MENTIONS_PROCESS` gate is `\bprocess\b` rather than `process.env`, so
  `process?.env`, `process['env']` and `const { env } = process` are all covered; the directive-prologue
  regex handles two directives; the SSR-layer rule is deliberately not scoped to `src/`, so a
  `node_modules` client component is covered too. The loader fails the build rather than passing source
  through when it cannot read a module's layer.
- **Route-table validation.** `assertNothingIsShadowed` is method-by-method and only fires when every
  method is taken; the cross-kind key checks catch what excess-property checking against a union cannot;
  `'head'` gets its own message. All ten cases are unit-tested. (What it does *not* reach is the route's
  module — that is H2.)
- **Prerendering.** `ssgFilePath` is the single canonical path→file mapping shared by the writer and
  every reader, resolved *before* the render so a bad path fails the build naming the path; the manifest
  turns a miss into a `Map` lookup rather than a failed read forever; the page cache is byte-bounded and
  stores only hits.
- **`refusesCrossSiteForm` and the `x-rsc-action` split.** The reasoning for why the header branch needs
  no origin check (not CORS-safelisted, no preflight answered) and why the form branch needs both
  `Sec-Fetch-Site` and `Origin` holds, including the sibling-subdomain case and the fail-closed
  treatment of a missing `Origin`. Verified that `OPTIONS` on a page path is a 404, so no preflight is
  answered; `PUT` is a 404 and `HEAD` and `POST` are served, matching the documented method set.
- **Response headers.** `appendVary` preserves existing entries and leaves `*` alone; `etagMatches`
  normalises the weak prefix on both sides; the security floor unwinds last so `secureHeaders()` wins;
  `Vary: RSC` is a two-state header rather than `Vary: Accept`. Confirmed on a live build for a dynamic
  page, a plain 404 and a `HEAD`.
- **Dead code.** No unused exports in either `src/` beyond the `weakEtag` keyword in L3. Every template
  overlay is referenced by a feature, every template token is both produced and consumed in both
  directions, and `render()` throws on an unknown one.
- **Docs.** All 25 `www.rshono.com/docs/...` links and anchors referenced from `packages/` resolve
  against the shipped markdown, checked with the site's own slugify.
- **Release discipline.** `check-pinned-deps.mjs` compares both manifests against the workspace
  overrides, with the incident that motivated it recorded in its header; CI covers lint, four OS/Node
  combinations, a coverage floor, Playwright, an install-and-build of a real scaffolded app on both npm
  and pnpm, and an inspection of the packed tarball's entry points.
