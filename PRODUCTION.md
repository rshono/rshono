# Production readiness — `@rshono/core` 1.0.0

Consolidated from two independent reviews of `packages/core` (49 modules, 5,444 LOC of `src/`), against the
four release goals: a stable and bug-free API, a framework that is secure by default, a public surface that
exposes only what is needed, and a suite that covers it.

Every item below was **re-verified against the current working tree** while merging. Duplicates have been
collapsed, stale line numbers corrected, and claims that did not survive re-checking are recorded in
[Appendix A](#appendix-a--dismissed) rather than silently dropped.

## Baseline (verified at merge time, branch `feature/harden-for-production`)

| Check                              | Result                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @rshono/core build` | ✅ clean                                                                                                                                                                                         |
| `tsc --noEmit`                     | ✅ clean                                                                                                                                                                                         |
| `pnpm lint`                        | ✅ clean                                                                                                                                                                                         |
| `pnpm --filter @rshono/core test`  | ✅ 192 pass / 0 fail (30 suites, 8.7s)                                                                                                                                                           |
| `test:browser` (Playwright)        | ⚠️ not run — no Chromium in this environment                                                                                                                                                     |
| Installed vs. declared deps        | ✅ agree at `@rspack/core` 2.2.1 / `react-server-dom-rspack` 0.1.0 — [1.1](#11--blocker-the-published-dependency-versions-have-never-been-tested) resolved, and `pnpm check:pins` now holds them |

The architecture holds up. The deploy seam (`DeployRuntime`), the layer-based env shadow, the control-signal
digests, the abort-forwarding discipline in `renderComponent`, and the prerender store's byte-bounded cache
are sound and well documented — the reasoning behind the hard parts is written down in the code itself, which
is unusual and worth preserving. No `TODO`/`FIXME`/`HACK` markers, one `as unknown as` in the package, no
tracked build artefacts.

Everything below is either a defect reproduced against a real build or a gap between what the code does and
what `README.md` / `SECURITY.md` say it does.

**Provenance markers.** **[measured]** = reproduced against a running build, a direct call, or the installed
Hono. **[by construction]** = follows from reading the code but was not executed.

---

## 1. Blockers

### ~~1.1 — Blocker: the published dependency versions have never been tested~~ — ✅ resolved in `ee25131`

- [x] ~~**`packages/core/package.json:64,67` declares `@rspack/core: 2.2.0` and `react-server-dom-rspack: 0.1.0`;
      `pnpm-workspace.yaml:13-14` overrides resolve `2.1.7` and `0.0.3`. [measured]**~~

  Verified installed: `packages/core/node_modules/@rspack/core` → **2.1.7**, `react-server-dom-rspack` →
  **0.0.3**. Commit `6d8e3e4` ("chore: upgrade rspack to 2.2.0") moved the manifests and left the overrides
  behind, so CI, the local suite and every fixture run against 2.1.7/0.0.3 while `npm i @rshono/core` gets
  2.2.0/0.1.0. These are regular `dependencies`, not peers, so consumers cannot opt out. All four versions
  exist on npm, so the package installs — it is simply untested, and `0.0.3 → 0.1.0` is a minor bump on a
  `0.x` package, i.e. breaking by convention.

  **Why it matters:** `packages/core/README.md:20-22` makes this exact promise — _"Both are pinned to exact
  versions — in the manifests and in workspace overrides — and a release of rshono is what moves them, so an
  upstream change reaches you as a tested release rather than as a broken install."_ Right now they moved
  outside one. `ci.yml` says the same thing and does not check it.

  **Knock-ons:** `packages/create/package.json:54` pins `2.2.0` for scaffolded apps and its `FRAMEWORK_DEPS`
  codegen reads rshono's manifest, so generated apps inherit the same untested pair; the hand-written
  `src/types/react-server-dom-rspack.d.ts` was authored against 0.0.3's surface; `packages/core/README.md:20`
  still tells users `react-server-dom-rspack` "is still `0.0.x`".

  **Fix:** pick one resolution; make the manifests, the overrides, the lockfile and the README agree; re-run
  the full suite (including `scaffold` and `browser`); then add a CI step asserting `packages/core` +
  `packages/create` deps equal the `pnpm-workspace.yaml` overrides. Nothing in `ci.yml` catches this drift
  today.

  > This item invalidates every other result in this document, including the 192 passing tests. Do it first.

  #### Resolution — aligned **up**, to the pair the manifests already declared

  The two peer-couple: `react-server-dom-rspack@0.1.0` declares `@rspack/core: ^2.2.0-0`, so they can only
  move together, and the manifests already named the newer pair. The overrides and the lockfile were moved to
  `2.2.0` / `0.1.0` to match, making the published resolution the tested one rather than reverting to a pair
  that is now a month stale.

  A follow-up commit (`c146e0c`) then took the whole tree to the latest available release, so `pnpm outdated -r`
  is empty but for one entry that cannot move: **`@rspack/core` 2.2.1** (still satisfying the `^2.2.0-0` peer),
  `@types/node` `^26.4.0`, `@types/react-dom` `^19.2.5`, `eslint` `^10.9.1`, `typescript-eslint` `^8.68.0`, and
  the website's `markdown-it` / `@types/markdown-it` / `wrangler` / `typescript` (`~6.0.3` → `^7.0.2`, matching
  core and testbed — its tsconfig was already authored for 7). Two ceilings are real and were verified, not
  assumed:

  - **`react-server-dom-rspack` stops at 0.1.0**, its `latest`. npm also carries a `19.3.0`, but it is tagged
    `canary` and peers `react`/`react-dom` `^19.3.0` — versions that exist only as React canaries — so taking
    it would put a stable framework on a React canary. `react`, `react-dom` and `hono` are already latest
    stable.
  - **The root `typescript` stays on `~6.0.3`**, because `typescript-eslint@8.68.0` — the latest — still peers
    `typescript >=4.8.4 <6.1.0`. This is the documented "Two TypeScripts" constraint, re-confirmed against the
    current release rather than taken from the comment. It also keeps
    [7.3](#7-docs-and-repo-hygiene) (the root `baseUrl`) alive as written.

  **Verified green at 2.2.1 / 0.1.0** _[measured]_ — `typecheck`, `pnpm lint`, **192/192** core tests
  (30 suites), `testbed typecheck` against the built declarations, and the **`scaffold` e2e at 42/42**
  (`CREATE_RSHONO_E2E=1`, 70.9s), which packs the framework, installs generated apps from a registry with
  **no overrides in play**, and builds them — the consumer path this drift had made untested. Every export
  the hand-written `src/types/react-server-dom-rspack.d.ts` declares was confirmed present in 0.1.0 on all
  three entry points, so the declarations did not need widening.

  **Not re-run:** `test:browser` — no Chromium in this environment. Still outstanding as
  [8.3](#8-release-checklist).

  **Guard added:** `pnpm check:pins` (`scripts/check-pinned-deps.mjs`) compares every exact pin across both
  published manifests, the `pnpm-workspace.yaml` overrides, the lockfile and `node_modules`. It runs in the
  CI `lint` job _before_ the gates that would otherwise report a false green, and inside `pnpm release`'s
  version step, where `--skip-tests` cannot skip it. Confirmed to fail on a reconstruction of `6d8e3e4`'s
  exact state, naming all three drifted files.

  **Two claims in the knock-ons above did not survive checking**, recorded so they are not re-raised:
  `packages/create`'s `@rspack/core` is a devDependency for bundling **its own** CLI
  (`packages/create/rspack.config.mjs`, `scripts/build.mjs`), not something scaffolded apps receive; and
  `FRAMEWORK_DEPS` never carried the pair — its `TEMPLATE_DEPS` list is `hono`, `react`, `react-dom`,
  `typescript`, `@types/node`, `@types/react` only. Generated apps did inherit the untested pair, but
  transitively through `@rshono/core`'s own `dependencies`, which is exactly what the `scaffold` job now
  covers.

  _Prose corrected with it (closes [7.1](#7-docs-and-repo-hygiene)):_ `packages/core/README.md:20`, the
  website's `getting-started.md`, the `.d.ts` header and `packages/benchmarks/README.md` said
  "`0.0.x`"/"`0.0.3`"; all four now say **pre-1.0**, which cannot rot to a stale digit again.

### ~~1.2 — Blocker: prerendered pages whose params need percent-encoding are built and then never served~~ — ✅ resolved in `84f4897`

- [x] ~~**`src/server/ssg.ts:55` writes the file under `encodeURIComponent(value)`, but Hono's `getPath` runs
      `decodeURI` on any path containing `%` before the handler sees it. [measured]**~~

  The two disagree for exactly the characters `decodeURI` unescapes. Verified end-to-end against
  `dist/server/prerendered.js` and the installed Hono:

  | `staticPaths` value | written to disk             | `c.req.path` at runtime | lookup key              | result   |
  | ------------------- | --------------------------- | ----------------------- | ----------------------- | -------- |
  | `plain`             | `docs/plain/index.html`     | `/docs/plain`           | `docs/plain/index.html` | HIT      |
  | `café`              | `docs/caf%C3%A9/index.html` | `/docs/café`            | `docs/café/index.html`  | **MISS** |
  | `a b`               | `docs/a%20b/index.html`     | `/docs/a b`             | `docs/a b/index.html`   | **MISS** |
  | `ü`                 | `docs/%C3%BC/index.html`    | `/docs/ü`               | `docs/ü/index.html`     | **MISS** |
  | `a/b`               | `docs/a%2Fb/index.html`     | `/docs/a%2Fb`           | `docs/a%2Fb/index.html` | HIT      |

  So reserved characters survive and unreserved-but-escaped ones (all non-ASCII, spaces) do not — an invisible
  line. The build reports the page as prerendered and every request silently falls back to SSR, forever.

  **And the targets disagree.** Cloudflare's `readPrerendered` builds its key with `new URL(path, c.req.url)`
  (`src/deploy/cloudflare/runtime.ts:36`), which _re-encodes_ non-ASCII — so Workers **hits** where
  node/vercel/aws-lambda **miss**. Same build, same routes, different behaviour per target.

  **Why it matters:** any non-ASCII slug (CJK, accented, Cyrillic) loses prerendering on three of the four
  targets, with no error and no warning. Compounded by [3.7](#37--render-static-routes-the-build-skipped-still-take-the-prerendered-lookup-on-every-request):
  every one of those misses is a failed `readFile` on every request, forever.

  **Fix:** pick one canonical on-disk form — decode the path once and write/read decoded is simplest — and
  assert the **round-trip** in a test rather than testing `interpolatePath` in isolation, which is what let
  this through.

  _Done as described._ `ssgFilePath` is now the single mapping from a path to the file holding its page — the
  build's and every deploy target's — and decodes each segment, so the encoded and the decoded form of a path
  resolve to the same file. `prerenderedRelPath` is gone into it; its traversal guard is subsumed and tightened
  (`%2e%2e` is refused as the `..` it decodes to). Workers escapes the key back into a URL through the new
  `ssgAssetPath`, so all four targets read what the build wrote. A segment that cannot be one portable file name
  (`.`, `..`, empty, or holding `\ / : * ? " < > |` or a control character) is `null`: a miss for a request, and
  a named build error where it used to be a `join(dir, null)` TypeError. Asserted as a round trip — the testbed
  gained a `café` doc that `prod.test.mjs` and `cloudflare.test.mjs` both fetch percent-encoded.

### ~~1.3 — Blocker: `HTTPMethod` advertises `'head'`, which can never match~~ — ✅ resolved in `7443826`

- [x] ~~**`src/router.ts:220`. Hono rewrites `HEAD` to `GET` before routing, so a `'head'` registration is
      unreachable. [measured]**~~

  Verified against the installed Hono — and it is worse than "the `GET` handler wins". A route registered for
  `HEAD` alone answers **nothing**:

  ```
  app.on('HEAD', '/headonly', …)   ->  HEAD /headonly  ->  404
                                       GET  /headonly  ->  404
  ```

  **Why it matters:** `{ type: 'endpoint', method: 'head', … }` type-checks, builds, and silently 404s in
  production for every method. It is a public type advertising a value that cannot work.

  **Fix:** drop `'head'` from the union — a `HEAD` is already answered by the `'get'` handler with the body
  stripped — and say so in the doc comment on `EndpointRoute.method` (`src/router.ts:213-214`). The same change
  makes the internal `['GET', 'HEAD']` registrations at `src/server/static.ts:30`,
  `src/deploy/filesystem.ts:47` and `src/deploy/cloudflare/runtime.ts:64,71` honest rather than
  dead-but-plausible.

  _Done as described,_ all four registrations included — each is now `app.get(…)`. `EndpointRoute.method` and
  the `HTTPMethod` alias both say why there is no `'head'`, as do `docs/routing.md` and the API reference.
  The testbed's `/api/quick-health` declares `method: 'get'` and `prod.test.mjs` sends it a `HEAD` — plus a
  `public/` file and a hashed chunk — so the fact the removal rests on is asserted rather than assumed.
  A runtime `method` that is not in the union is rejected by the validation pass added for
  [1.4](#14--blocker-srcroutests-and-srcserverts-are-cast-not-validated), so a JS app cannot register the
  unreachable route either.

### ~~1.4 — Blocker: `src/routes.ts` and `src/server.ts` are cast, not validated~~ — ✅ resolved in `e1f34bf`

- [x] ~~**`src/runtime/entry.rsc.tsx:40,53-54` cast the app's two entry modules straight to their types with no
      check. [measured, by building real fixtures]**~~

  | app mistake                                                                                           | what the developer sees                                                                                                        |
  | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
  | `export const routes = [ … ]` without `defineRoutes` (an identity function, so this looks equivalent) | build fails with `TypeError: nN is not iterable` — a minified identifier, from a bundle, naming neither rshono nor `routes.ts` |
  | `src/server.ts` default-exporting a non-Hono value                                                    | `TypeError: Cannot read properties of undefined (reading 'map')` from inside `app.route`                                       |
  | **duplicate `path` values**                                                                           | **builds cleanly, exit 0, no warning** — the first registration silently shadows the second                                    |
  | `render` / `staticPaths` on an `{ type: 'endpoint' }` route                                           | **type-checks** (excess-property checking against a union allows any key present in some member) and is silently ignored       |
  | `staticPaths` on a `render: 'dynamic'` route                                                          | silently ignored                                                                                                               |

  **Fix:** one validation pass over `routes` / `notFound` / `error`, ideally in `createConfigs` so it fails the
  build with a `[rshono]` message naming the offending entry. Accept a bare array in `entry.rsc.tsx` too, since
  the docs present it as a valid shape.

  _(A missing or misnamed `routes` export needs nothing — Rspack already reports `ESModulesLinkingError:
export 'routes' … was not found … (possible exports: table)`, which is better than anything we would write.)_

  _Done,_ as `src/runtime/validate-entries.ts` — not in `createConfigs`, which never sees the route table:
  the app's TypeScript is only evaluable once bundled. The pass runs at the server bundle's module load
  instead, which covers all three entries into it — `rshono build` (it imports the bundle for the prerender
  pass), `rshono dev` startup, and a deployed server booting — and `buildCommand` prints a `[rshono]` throw
  from there as a message rather than as a stack through minified frames. Every row of the table above is now
  a named refusal; a bare array is accepted. One judgement call beyond the brief: shadowing is decided per
  **method**, and only when _all_ of a route's methods are already claimed, so `'get'` and `'post'` endpoints
  on one path — and a catch-all behind a route claiming one method of it — stay legal. Covered by unit tests
  over `validateRoutesModule`/`validateServerApp` and two builds in `minimal-app.test.mjs` that must exit 1.

---

## 2. Security

`SECURITY.md` declares four boundaries the framework owns: the env split, action dispatch, the request context,
and prerender traversal. The e2e suite proves the last two hold. Two items below land inside the first two.

### ~~2.1 — The env shadow does not cover `process?.env`, `process['env']`, or an aliased `process`~~ — ✅ resolved in `fbce4a7`

- [x] ~~**`src/builder/env-shadow-loader.cjs:33` skips any module whose source lacks the literal substring
      `process.env`. [measured, by calling the built loader directly]**~~

  | source shape                            | shadowed |
  | --------------------------------------- | -------- |
  | `process.env.DATABASE_URL`              | yes      |
  | `const { DATABASE_URL } = process.env`  | yes      |
  | `globalThis.process.env.DATABASE_URL`   | yes      |
  | `process?.env.DATABASE_URL`             | **no**   |
  | `process['env'].DATABASE_URL`           | **no**   |
  | `const p = process; p.env.DATABASE_URL` | **no**   |

  **Why it matters:** `process?.env` is not a contrived shape — it is the idiomatic way to write env access in
  code meant to run in both a browser and a server, which is exactly what a `'use client'` component is. Such a
  component is SSR'd in the `ssr` layer against the real `process`, so **the secret is rendered into the HTML
  stream**; the browser bundle does not get the same value, so it is a hydration mismatch as well.
  `SECURITY.md` puts this in scope: _"Anything that gets a non-prefixed variable into either is in scope."_

  **Fix:** gate on `process` rather than `process.env` — the prelude is already a full `process` shadow, so it
  covers all three shapes once it is emitted. Add the table above as a loader unit test.

  _Done as described._ The gate is `/\bprocess\b/` behind an `includes('process')` fast path, so `preprocess`,
  `processEnv` and `child_process` still cost one string scan and out. `const { env } = process` was a seventh
  shape the table missed, and is covered too. The loader unit tests hold the whole table.

  **One row of the table above was wrong**, and the fix does not change it: `globalThis.process.env` is _not_
  shadowed and never was. The measurement behind that "yes" was whether the loader fires, not whether the read
  is shadowed — the prelude is a module-scoped binding, and `globalThis.process` is the real `process` however
  a module spells it (verified: the prelude evaluated against a real `process` returns the secret through
  `globalThis.process.env` and `undefined` through `process.env`). Nothing a loader emits can close that: it
  would take shadowing `globalThis` itself, and the real global cannot be captured in a scope that declares
  `const globalThis` without hitting its own TDZ. So the loader now **warns** when a module under the app's
  `src/` reads `process` through the global object — the app's own source only, since a library
  feature-detecting `globalThis.process?.env?.NODE_ENV` is doing nothing wrong and has no app secret to read —
  and `SECURITY.md`'s env-split bullet states the boundary rather than implying a tighter one. That warning
  needed `rshono build` and `rshono dev` to print warnings at all: both used the `summary` preset, which counts
  them and never shows them.

  The pin is end to end as well as unit: the testbed's `leak-helper.ts` now reaches the env three ways and
  never by the dotted spelling, so `prod.test.mjs`'s existing "secrets never reach the browser" assertion is
  what fails if the gate narrows again — confirmed by rebuilding with the old gate restored, which renders the
  real `DATABASE_URL` into the page.

### ~~2.2 — `src/server.ts` middleware never runs for `/_static/*`~~ — ✅ resolved in `2fb87db`

- [x] ~~**`src/runtime/entry.rsc.tsx:397` mounts static assets; `:401-403` mounts the app's sub-app _after_ it,
      and the asset handler is terminal. [measured, against a real `rshono start` of `apps/testbed` with
      `TESTBED_CSP=1`]**~~

  ```
  /                                CSP ✓   HSTS ✓   COOP ✓   X-Frame-Options ✓   nosniff ✓
  /_static/chunks/main.<hash>.js   CSP —   HSTS —   COOP —   X-Frame-Options ✓   nosniff ✓
  ```

  Only the framework's three baseline headers (`entry.rsc.tsx:373-378`) reach an asset response.

  **Why it matters:** HSTS is the one that materially matters — it is per-response, and a `/_static` request
  over http is exactly where a downgrade lands. CSP and COOP are moot for a `.js` file, but their absence is
  not something an operator will expect, and nothing documents it.

  **Fix:** mount static assets _after_ `app.route('/', serverApp)` — they sit on a reserved prefix, so ordering
  costs nothing — or state the exception in the README and lean on the CDN `_headers` the presets already
  write.

  _Done the first way._ `runtime.mountStaticAssets(app)` now runs below `app.route('/', serverApp)` and still
  above the page routes, so an asset response goes through the app's middleware and no route can claim the
  prefix. The flip side is the one mounting src/server.ts first always had, one path wider, and both halves of
  it are now in the comment there: a terminal handler shadows a path, and unscoped middleware runs for
  `/_static` too. `DeployRuntime.mountStaticAssets`'s doc said "ahead of the app's routes" and now says which
  ones.

  Pinned in `prod-config.test.mjs`, where the hardened profile already runs: an asset must carry HSTS, the
  app's CSP and the testbed's own `X-Response-Time`, while keeping the immutable `Cache-Control` the asset
  handler sets — the middleware wraps the handler rather than replacing it. Verified to fail with the old
  order restored.

### ~~2.3 — The built-in CSRF guard leaves a same-site cross-origin form post to `csrf()`~~ — ✅ resolved in `5f296e1`

- [x] ~~**`src/runtime/entry.rsc.tsx:106-110` returns early unless `Sec-Fetch-Site` is exactly `cross-site`.
      [measured, against a running minimal-app build with no `src/server.ts`, so no `csrf()`]**~~

  ```
  POST /  Sec-Fetch-Site: same-site   Origin: https://evil.app.test  ->  200   (not refused)
  ```

  This is **deliberate** — the doc comment at `:96` says so: _"`same-site` is left alone too, since a subdomain
  policy is `csrf()`'s to express."_ The defect is not the code, it is the gap between the code and what
  `SECURITY.md` leads a reader to expect.

  **Why it matters:** `SECURITY.md`'s sentence — _"a cross-site form post to a server action, which it refuses
  whether or not `csrf()` is registered"_ — is _literally_ accurate, since `cross-site` is the Fetch Metadata
  term of art for a different registrable domain. But `same-site` is what a browser sends from a **sibling
  subdomain**, so with no `csrf()` any subdomain — a user-content host, a stale CNAME, a subdomain takeover —
  can drive any `'use server'` export with any arguments. A reader of that sentence will not expect that.

  **Fix:** either compare `Origin` against `publicUrl(c).origin` whenever `Origin` is present (not only when
  `Sec-Fetch-Site` says `cross-site`), or — if the subdomain policy is genuinely `csrf()`'s to own — reword
  `SECURITY.md` so it says what the guard actually covers. Do not leave the sentence as it reads today.

  _Both, and the code first._ The guard now treats `same-site` exactly as it treats `cross-site`, so it is the
  `Origin` comparison that decides for either label. Comparing on `Origin` alone — the first option as written
  — was rejected: it would drop the `same-origin` short-circuit, and a genuine post behind a proxy that
  rewrites `Host` carries a public `Origin` against an internal `publicUrl(c)` whenever `trustProxy` is off.
  The browser's own label is unforgeable by page script and settles that case; only the two labels that mean
  "not from this origin" need the comparison at all.

  `SECURITY.md` now says "a form post to a server action from another origin — a sibling subdomain included,
  since `Sec-Fetch-Site: same-site` is what a browser labels that". The cost is stated in the guard's doc
  comment: an app deliberately accepting a form post to an action from another origin of its own cannot,
  `csrf()`'s allowlist included, and `{ type: 'endpoint' }` is what that app wants. `minimal-app.test.mjs` —
  the app with no `src/server.ts`, where the framework guard is the only thing standing — covers the subdomain
  shape, both labels paired with the app's own origin, and a `same-origin` post whose `Origin` a proxy
  rewrote.

### ~~2.4 — _(hardening)_ `refusesCrossSiteForm` allows `Sec-Fetch-Site: cross-site` with no `Origin`~~ — ✅ resolved in `a084b69`

- [x] ~~**`src/runtime/entry.rsc.tsx:108-109` refuses only when `Origin` is _present and different_.**~~

  Per Fetch, a browser always appends `Origin` to a non-GET/HEAD request (`null` under
  `Referrer-Policy: no-referrer`, which the comparison already refuses), so **there is no browser shape that
  reaches this** — it is not exploitable. But a security predicate should not fail open, and the guard reads as
  though it covers the case.

  **Fix:** refuse a `cross-site` label unless `Origin` positively proves same-origin. Add the shape to
  `test/prod.test.mjs` beside the two already covered.

  _Done as described._ Past the label check the comparison is unconditional, so no `Origin` and `Origin: null`
  are both refused; the `same-origin` / `none` short-circuit still runs ahead of it, so a genuine post behind
  a proxy that rewrote `Host` is untouched. Covered in `minimal-app.test.mjs` rather than `prod.test.mjs`: the
  testbed registers `csrf()`, so a 403 there does not say which of the two refused it, while the minimal app
  has no `src/server.ts` and the framework guard is the only thing standing.

### ~~2.5 — _(hardening)_ The CSP nonce is interpolated into raw HTML unvalidated~~ — ✅ resolved in `afb4748`

- [x] ~~**`src/runtime/flight-inject.ts:73` writes `nonce="${nonce}"` into a `<script>` tag it builds by hand.**~~

  The value comes from Hono's `secureHeaders()` today, so it is not attacker-controlled — but this is the one
  raw attribute write on a path React is not escaping for us, and the framework does not own where the value
  comes from.

  **Fix:** validate against `/^[A-Za-z0-9+/=_-]+$/`; drop the attribute otherwise.

  _Done as described,_ that exact character set — base64 and base64url, which is what any generator of a nonce
  emits. Checked at the raw write rather than at `cspNonce`, so the guard travels with the injector rather
  than with one of its callers. Dropped rather than escaped: a value that is not a nonce is not one, and a
  page whose payload scripts the policy then refuses is the visible failure to have, where an escaped garbage
  nonce would be a silent one. Five injection-shaped values are in the unit suite beside the base64url case.

### ~~2.6 — No default cap on the bodies the framework's own action path buffers~~ — ✅ resolved in `07f3550`

- [x] ~~**`src/runtime/entry.rsc.tsx:314` (`await request.text()`), `:335` (`await request.formData()`).**~~

  Every `'use server'` export is a public POST endpoint by design; without `bodyLimit()` those two calls buffer
  whatever arrives. `src/builder/rspack-config.ts:126` warns only when `src/server.ts` is **absent** — an app
  that has one but never registered `bodyLimit()` is warned about nothing.

  **Fix:** either apply a generous framework default on the action/form-post path only (overridable, and
  documented as a floor the way the baseline headers are), or widen the build warning to detect a
  `src/server.ts` with no `bodyLimit` and say so.

  _The second, deliberately._ The first was rejected on two counts. There is no "only if unset" signal to read
  the way the baseline headers have one, so a framework cap would be a **ceiling, not a floor**: an app
  uploading a file through a server action could not raise it, and the escape hatch would have to be a new
  config field — API surface, freezing at 1.0, in the one file whose doc comment says it "holds only what the
  _build_ decides. Per-request concerns — CSRF, CSP, the body cap — are Hono middleware in `src/server.ts`."
  That sentence is the framework's position on this, and `configuration.md` states it to users as "the
  framework runs no CSRF check, body cap or CSP of its own".

  So the warning is what changed. `mentions(srcDir, 'bodyLimit')` scans the whole of `src/` rather than
  `src/server.ts` alone, so a cap registered from a helper module counts, and the message names what it looked
  for so an unwarranted warning explains itself. Textual on purpose — the question is whether the author
  thought about this at all, and the worst a wrong answer does is print something nobody needed. Four cases in
  the unit suite: no `src/server.ts`, one without the cap, one that registers it from a helper, and the
  testbed. `docs/pages.md`'s "Every action is a public endpoint" now says the body is buffered before the
  action runs and points at the cap.

### ~~2.7 — Write down that client-initiated actions rely on the CORS preflight~~ — ✅ resolved in `e3b181c`

- [x] ~~**`refusesCrossSiteForm` is applied only to the `form-action` branch; the `rsc-action` branch
      (`src/runtime/entry.rsc.tsx:307-327`) has no same-origin check at all.**~~

  It does not need one — `x-rsc-action` is not a CORS-safelisted header, so a cross-origin POST cannot be sent
  without a successful preflight _[measured: a cross-site `x-rsc-action` POST reaches the unknown-action-id 400
  at `:311`, i.e. it passes no CSRF gate of its own]_. That is the standard defence and it is correct — but it
  is load-bearing and written down nowhere outside the `refusesCrossSiteForm` doc comment.

  **Fix:** add it to `SECURITY.md` beside the form-post rule, and pin the branch selection with the
  `parseRenderRequest` tests from **6.1**.

  _Done as described,_ and **6.1** is done with it. `SECURITY.md` says it beside the form-post rule, including
  what an app gives up by adding a `cors()` permissive enough to allow `x-rsc-action`; the header's own
  declaration in `request.ts` says the branch choice is a security boundary rather than a dispatch detail.
  `parseRenderRequest` is now table-driven over method × `x-rsc-action` × content-type × `RSC`, with
  `createRscRequest` round-tripped through it, and each case names the branch it lands on. One thing the table
  turned up: the form content-type match is a **prefix** match, so `application/x-www-form-urlencodedX` is a
  `form-action` — deliberate, since `; charset=UTF-8` has to stay in the branch, and erring wide is the safe
  direction here: an over-matched POST lands on the guarded branch and decodes to nothing, where an
  under-matched one would land on a branch with no origin check.

---

## 3. Correctness bugs

### ~~3.1 — `PORT=""` binds a random port instead of the default~~ — ✅ resolved in `f71f16a`

- [x] ~~**`src/cli/index.ts:61` tests `process.env.PORT ?` (falsy → treated as unset, so `PORT` is left in the
      environment untouched); `src/deploy/node/runtime.ts:18` tests `process.env.PORT !== undefined` (empty
      string → `Number('')` → **0** → "any free port"). The two disagree. [measured, against a real
      `rshono start`]**~~

  ```
  PORT unset  -> serving on http://localhost:3000
  PORT=""     -> serving on http://localhost:64659    <-- CLI says "unset", bundle says "port 0"
  PORT="0"    -> serving on http://localhost:64660    (intended)
  PORT="abc"  -> exit 1: RangeError [ERR_SOCKET_BAD_PORT] … Received type number (NaN)
                         at Object.serveApp (webpack://…)
  ```

  **Why it matters:** an empty `PORT` is common in CI and container templates, and the failure is **silent**:
  the process starts, reports success, and binds a port nothing will connect to.

  **A second, smaller half:** the CLI validates `--port` with a clean `rshono: invalid --port "…"`
  (`src/cli/index.ts:55-59`) but leaves `PORT` unvalidated and never range-checks either source, so these fall
  through to Node as raw errors with a `webpack://` frame in the stack:

  ```
  PORT=abc rshono start           -> RangeError [ERR_SOCKET_BAD_PORT] … Received type number (NaN)  + stack
  rshono start --port 999999      -> RangeError [ERR_SOCKET_BAD_PORT] … Received number (999999)    + stack
  HOST=bogus.invalid rshono start -> Error: getaddrinfo ENOTFOUND bogus.invalid (unhandled 'error') + stack
  ```

  **Fix:** validate both sources through one helper (integer, 0–65535) in the CLI, report them the way the
  `--port` flag already is, and make the two "is it set" tests agree.

  _Done as described,_ with the helper in `src/server/server-config.ts` beside the `SERVER_DEFAULTS` it falls
  back to — not in the CLI — because the CLI is only one of the two readers: a bundle started as
  `node dist/server/main.mjs` reads `PORT` itself, and a helper the CLI owned would have left that half free to
  drift again. Blank is "unset" on both sides, an explicit `PORT=0` still means "any free port", and everything
  else present must be digits in 0–65535 — digits, because `Number` alone accepts `0x50`, `1e3`, `+80` and
  `3.0` as ports nobody typed. The node runtime parses **under** the `??`, so the dev server's own port
  override still wins without the environment being read at all.

  The `HOST=bogus.invalid` line above is left as it is: a hostname is only wrong once DNS says so, and the
  clean report for that belongs with the listener rather than with an input parse.

  **6.12** is done with it: `parsePort` is table-driven in the unit suite, and `start.test.mjs` covers the CLI
  half — an empty `PORT` passed on untouched for the bundle to read as unset, a valid one and `--port` through
  with the flag winning, and `abc` / `999999` from either source refused with one line and no stack, before the
  bundle runs.

### ~~3.2 — An action request that fails before its payload is produced makes the browser throw a `TypeError`~~ — ✅ resolved in `ae127b0`

- [x] ~~**`src/runtime/entry.client.tsx:377` reads `payload.returnValue!`; `:366` feeds every action response
      straight to `createFromFetch` with no status or content-type check.**~~

  Two distinct shapes reach application code as a meaningless error:

  **(a) A non-flight response body.** `createFromFetch` is handed the body whatever the status. Feeding the
  parser a plain-text body directly _[measured]_:

  ```
  createFromReadableStream(<<"Payload Too Large">>)     -> throws Error: Connection closed.
  createFromReadableStream(<<"Internal Server Error">>) -> throws Error: Connection closed.
  ```

  So an action POST rejected by `bodyLimit()` with a 413 — which `test/prod-config.test.mjs:144-170` proves is
  reachable — surfaces as "Connection closed." with the real status nowhere in sight.

  **(b) A flight payload with no `returnValue`.** When something throws _before_ the payload is produced on an
  `rsc-action` request, `app.onError` renders the app's `error` page as flight (`entry.rsc.tsx:510`) **without**
  forwarding `returnValue`. The client then reads `.ok` off `undefined` at `:377` and the caller sees
  `Cannot read properties of undefined` — for an action that may already have run. The triggers are
  `loadPage()` failing (a chunk gone after a deploy) or `decodeReply` on an undecodable body.

  > Note: a **render** error is _not_ a trigger. `renderComponent` returns the stream at `entry.rsc.tsx:256`
  > before the render can throw, so the response is already committed. An earlier draft of this review claimed
  > otherwise; corrected here.

  **Fix:** check `response.ok` and the content type before decoding; carry `returnValue` through the error
  render; drop the `!` and make the client tolerate its absence with a real message.

  _Done, with one deliberate departure:_ the gate is the **content type alone**, not `response.ok`. A payload
  legitimately arrives as a 404 from the `notFound` page and as a 500 from an action that threw — both carry a
  real payload the caller has to see — so a status gate would have refused the two responses the runtime most
  needs to decode. `payloadResponse` reads the body of what it refuses (bounded to 200 characters) into the
  message, because a plain-text refusal says what it refused only in its body and HTTP/2 carries no
  `statusText` at all. Soft navigation goes through the same helper: it still ends in a reload, but the console
  now says why instead of "Connection closed."

  For (b), the result is carried across in `actionResults` — a `WeakMap` keyed on the Hono context, the way
  `beginPageRender` keys its own marker, so nothing is added to the payload type or to `ctx` and nothing
  outlives its request. `onError` passes it to the `error`-page render, so an action that ran gets its value
  back even though the page it returned to could not be built. Where nothing ran there is nothing to carry and
  the client says so.

  **6.13** is done with it. The trigger needed a page that fails _after_ the action —
  `apps/testbed/src/components/unloadable.tsx`, a module that throws as it evaluates, which is what a chunk
  that went missing between deploys looks like from the runtime's side. `prod.test.mjs` posts an action to it
  (the result comes back with the error page's payload) and posts an undecodable body to `/users` (no result is
  invented). The non-flight half is a browser test, since the client runtime is what changed: an action POST
  fulfilled as a 413 must surface the status rather than the parser's error.

### ~~3.3 — A `notFound` or `error` page that itself throws a control signal produces a bodiless, unlogged 500~~ — ✅ resolved in `bd62257`

- [x] ~~**`src/runtime/entry.rsc.tsx:491` re-enters `respondToControlSignal` from `onError` with no guard.**~~

  Trace: `onError(error)` → `isControlSignal` → `respondToControlSignal` (`:409-424`) → `renderComponent(the
notFound page)` → that page throws `redirect()`/`notFound()` → the signal propagates **out of `onError`**.
  Verified that a throwing `onError` **rejects `app.fetch`** in Hono (`compose.js` calls
  `res = await onError(err, context)` inside the `catch`, unguarded). `@hono/node-server` then hits
  `handleFetchError`, which is `new Response(null, { status: 500 })` — no body, and **nothing written to the
  log**.

  > Scope note: the `error`-page path at `:509-513` _does_ have a try/catch and _does_ report through
  > `reportServerError` before falling back to the plain-text 500 at `:516`. It is the control-signal path at
  > `:491` — and the same re-entry from the page handler at `:459` — that is unguarded. An earlier draft
  > described both as unlogged; only this one is.

  **Fix:** a one-shot guard so a second signal degrades to `plainNotFound` / the framework 500 rather than
  escaping.

  _Done, as a try/catch around the `notFound`-page render itself_ rather than as a re-entry counter. It is the
  same shape the `error`-page path at `:509-513` already uses, it covers both callers at once (the handler
  catch as well as `onError`), and it catches an **ordinary** throw from that page too — which had the same
  hole and was not in the original finding. The degraded answer is `plainNotFound`: the request still gets the
  404 it earned, and `reportServerError` names the page that failed, so the log is no longer silent.
  Terminating by construction — the page is rendered once and what replaces it cannot fail.

  One case is **not** degraded: a `redirect()` from the `notFound` page. Nothing is committed when that signal
  arrives, the redirect branch cannot fail, and `app.notFound` has always answered it as a real 3xx — so
  degrading it here would have made the same page behave differently depending on which of the two paths
  rendered it. It recurses exactly once.

  Covered in `prod.test.mjs` from both entries (an unmatched path, and a page that called `notFound()`), for
  the thrown signal and for the redirect; the testbed's 404 page fails on demand behind `?boom=`, which
  nothing links to. Verified that the first pair answers **500** without the fix.

### ~~3.4 — `redirect()` raised after the SSR shell has flushed never becomes a real 3xx~~ — ✅ resolved in `4f4ae3e`

- [x] **`renderComponent` consults `controlSignal` exactly once, after `await renderHTML(...)` returns
      (`src/runtime/entry.rsc.tsx:277`). `renderHTML` returns at _shell ready_, so a signal thrown from inside a
      `<Suspense>` that resolves later loses the race and the response is already committed as
      `200 text/html`. [measured]**

  Reproduced on a throwaway minimal-app route whose `<Suspense>` child awaits 400 ms and then calls
  `redirect('/login-target')`:

  ```
  GET /slow-redirect  ->  200 text/html   (expected 303)
  body: …<p data-section="loading">Loading…</p>…
        …push("3:E{\"digest\":\"RSHONO_REDIRECT;303;%2Flogin-target\"}")…$RX("B:0")…</body></html>
  ```

  The code at `:277-292` handles the _near_ race deliberately and well (its comment describes a boundary
  settling "just before the shell was ready"); this is the case past that window.

  **Why it matters:** the document closes cleanly and React marks the boundary errored, so **a client with
  JavaScript should recover** — the digest reaches `hydrateRoot`'s `onUncaughtError`
  (`entry.client.tsx:394-395`) → `handleControlDigest(…, {hard: true})` → `location.assign()`. That half is
  _[by construction]_: it needs the browser suite to confirm, and note that `onRecoverableError` is **not**
  wired up _[measured: only `onCaughtError` and `onUncaughtError` are]_, so it depends on React classifying
  this as uncaught rather than recoverable. **Without JavaScript the user is left on the Suspense fallback
  under a `200`.** `notFound()` degrades identically _[by construction]_ — same signal, same single check —
  which makes it a soft 404 that crawlers will index.

  **The existing test asserts a guarantee the framework does not have.** `test/prod.test.mjs:141`
  ("redirect() from inside a bare Suspense, after the shell has already resolved") passes only because the
  testbed's section awaits `Promise.resolve()` and wins the race.

  #### Decision: accept the degradation, stop paying for it, and warn at authoring time

  **A real 3xx is not recoverable here.** By the time the signal fires, the status line, the headers and the
  shell bytes are on the wire — `renderHTML` returns at shell-ready (`entry.ssr.tsx:102`) and that stream is
  already handed to `c.body(...)` (`entry.rsc.tsx:293`). HTTP has no take-backs once the head is committed, so
  the only option that yields a genuine 3xx is to not stream at all. Costed:

  | Option                      | Happy-path cost                                                      | Redirect-path cost  | No-JS                       |
  | --------------------------- | -------------------------------------------------------------------- | ------------------- | --------------------------- |
  | Status quo                  | zero                                                                 | full render, wasted | stranded on fallback, `200` |
  | Buffer until `allReady`     | **TTFB = full render time, whole document in memory, every request** | correct 3xx         | correct 3xx                 |
  | **Abort on late signal** ✅ | one boolean check                                                    | winds down early    | stranded (unchanged)        |

  Buffering is rejected: it taxes 100% of page renders to fix a case that fires on a vanishing fraction of
  them, and it deletes streaming SSR — most of why this architecture exists.

  **What is actually wasted today** is the render itself. `controlSignal` is read once at `:277` and never
  again, so every remaining boundary renders, its data settles, and the whole flight payload is serialized and
  injected — for a page the client discards at `location.assign()`. Per
  [4.1](#41--neither-half-of-the-flight-injector-honours-backpressure) there is no backpressure, so for a slow
  client that doomed document also accumulates in memory.

  - [x] **(a) Abort the doomed render.** The wind-down already exists for the _pre_-shell race at `:286-290`;
        this adds the post-shell arm:

        ```js
                    let controlSignal;
                    let shellFlushed = false;               // set right after `await renderHTML(...)` returns

                    const rscStream = renderToReadableStream(rscPayload, {
                      signal,
                      onError(error) {
                        if (isControlSignal(error)) {
                          controlSignal = error;
                          // Post-shell: the response is committed and the digest is the only path left. Everything
                          // still rendering is for a page the client will navigate away from.
                          if (shellFlushed) setImmediate(() => renderAbort.abort(error));
                          return error.digest;
                        }
                        …
                      },
                    });
                    ```

                    Near-free on the happy path; on the redirect path it stops the remaining boundaries, lets
                    `flight-inject`'s `cancel`/`flush` run, and fires the `release()` at `:216` that today only fires when
                    the doomed render finishes on its own.

                    Aborting does **not** truncate the client's recovery path: `react-dom`'s abort converts pending
                    boundaries into `$RX` client-render instructions and closes the document cleanly — the shape the client
                    runtime already handles.

  - [x] **(b) ⚠️ The `setImmediate` is load-bearing — this is what the test must pin.** Aborting
        _synchronously_ inside `onError` would cut React off **before** it writes the error row carrying the
        digest, destroying the only recovery the client has. Deferring one macrotask lets the current flush
        complete; it is the same boundary `flight-inject` already uses (`src/runtime/flight-inject.ts:33`).
        _This timing was reasoned about, not measured_ — a test must assert that the digest survives the abort,
        not merely that a redirect eventually happens.

        _Measured while implementing, and the premise does not hold today:_ with the abort called
            **synchronously** from inside `onError`, the digest row still reaches the client — `3:E{"digest":
            "RSHONO_REDIRECT;303;%2Flogin"}` is written, `$RX("B:0")` follows, and the document closes cleanly, on
            react-server-dom-rspack 0.1.0 / React 19.2.8. So the deferral is **defensive, not load-bearing**: it is
            kept because that ordering is a React internal the `^19.1.0` peer range does not promise, and one
            macrotask on an already-doomed render costs nothing. The test asserts the digest either way, which is
            the contract worth pinning; it cannot distinguish the two implementations, and the note above is
            corrected rather than dropped so nobody re-derives the original claim.

  - [x] **(c) Dev-only warning.** `isDev` is a DefinePlugin constant (`entry.rsc.tsx:43`), so the block is
        dead-code-eliminated in production. A loud `[rshono]` warning when a control signal arrives post-shell
        gives authoring-time discovery at zero runtime cost — which is worth more than a docs paragraph,
        because the root fix is an app-code fix.

        _Done — and the DCE claim is wrong, checked against the built bundle:_ `isDev` is destructured out of
            `__RSHONO_CONFIG__`, and the minifier does not fold that through, so the warning's string ships in
            `dist/server/main.mjs` (~700 bytes) and costs one boolean check per control signal. It never *fires* in
            production, which is what `prod.test.mjs` now asserts, and `dev.test.mjs` asserts that it does in dev —
            naming the call, the request and where the decision belongs. Left as it is: the same pattern is used
            for every other `isDev` branch in the file, and making this one call site special would be the
            inconsistency, not the fix.

  - [x] **(d) Document the limitation and the correct pattern.** Under "Requirements & limitations": a
        `redirect()` / `notFound()` from a boundary that resolves after the shell cannot produce a 3xx, and
        without JavaScript the visitor stays on the fallback under a `200`. The fix is app-side — an auth gate
        belongs in middleware or the page component body, **before** the render commits to streaming. Note that
        `notFound()` degrades to a soft 404 that crawlers will index.

  - [x] **(e) Replace the test that passes for the wrong reason** (`test/prod.test.mjs:141`) with one whose
        `<Suspense>` child genuinely loses the race, for both `redirect()` and `notFound()`.

        _Its claim was replaced rather than the test:_ what it actually pins — a signal that settles just
            before shell-ready is still a real 3xx — is real behaviour worth keeping, so it was renamed and
            re-commented to say which window it covers. The new pair drives `/late-signal`, whose section waits
            50ms and whose neighbour takes 2s, and asserts the digest, the `$RX` instructions, the clean document
            trailer, the fallback a no-JS visitor is left on, and — through the neighbour — that the doomed render
            was actually wound down. Verified both fail without (a): the slow section renders and the response
            waits it out.

  > Rejected: `<meta http-equiv="refresh">` as a no-JS escape hatch. It creates a history entry, so Back
  > returns to the redirecting page and redirects again — a trap.

  > Scope: the abort is the **document** path only. A flight fetch commits its response the moment
  > `renderComponent` returns the stream, so there is no shell race there and the digest riding the payload is
  > already the documented answer (`/suspense-redirect` with `RSC: 1`). The same wasted-render argument applies
  > to it, but at a fraction of the cost and with a live client tree on the other end, so it was left alone
  > rather than folded into a decision that was taken about the SSR half.

### ~~3.5 — A `HEAD` on a page route renders the page and throws the result away~~ — ✅ resolved in `a9da318`

- [x] **[measured, against a real build]** `HEAD /` → `200`, `content-type: text/html;charset=utf-8`,
      `cache-control: private, no-cache`, `vary: RSC`, **0 bytes**, no `Content-Length`. Those headers come from
      the real render, so the shell was produced.

  Hono wraps the `GET` response as `new Response(null, res)`, so the body stream is never consumed:
  `flush`/`cancel` in `src/runtime/flight-inject.ts` never run, and the `release()` at
  `src/runtime/entry.rsc.tsx:216` never fires — leaving the abort forwarder attached to the request signal
  until the request object is collected.

  **Why it matters:** retention is bounded, but the work is pure waste and a `HEAD` flood is a cheap amplifier.

  **Fix:** answer `HEAD` from the head only, or cancel the stream and release.

  _Both, split by route kind._ A `render: 'static'` route takes the prerendered path for a HEAD as well as a
  GET, so it reads a file instead of rendering a page — and that turned out to fix a second thing: a rendered
  answer carries no `ETag`, so a conditional HEAD on a prerendered route could never 304, and the
  `cache-control` it reported was `private, no-cache` rather than the `public, max-age=300` its own GET sends.
  Everything else keeps rendering, because "answer from the head only" would have to invent a status: a page
  can 404, redirect or 500, and a HEAD that says 200 for a page whose GET redirects is worse than a wasted
  render. What changed there is that the body is **cancelled** rather than dropped, which is what ends the
  render and fires `release()`.

  **6.7** is done with it — the suite had no HEAD on a page route at all. It now asserts every header a HEAD
  and its GET must agree on (`content-type`, `cache-control`, `vary`, `etag`, `content-length`), the empty
  body, and a conditional HEAD that 304s off the ETag it was just given. Verified both fail without the fix.

### ~~3.6 — Any method other than `GET`/`POST` on a page route is a 404, not a 405~~ — ✅ resolved in `9c045b6`

- [x] **`src/runtime/entry.rsc.tsx:463` registers `app.on(['GET', 'POST'], …)`, leaving every other method to
      the not-found handler. [measured]**

  ```
  GET /page -> 200    POST /page -> 200    HEAD /page -> 200 (empty body)
  PUT /page -> 404    DELETE /page -> 404  OPTIONS /page -> 404
  ```

  `405` with an `Allow: GET, POST, HEAD` header is the more correct answer. Implementing it means tracking the
  methods registered per path, so it is a real change rather than a one-liner — 404 is defensible as a
  documented choice, but right now it is an accident.

  #### Decision: keep the 404, make it a documented choice

  `HEAD` already resolves correctly through the `GET` route ([3.5](#35--a-head-on-a-page-route-renders-the-page-and-throws-the-result-away)),
  so the only shapes affected are `PUT` / `PATCH` / `DELETE` / `OPTIONS` on a _page_ — none of which a page
  route is ever meant to answer. The per-path method registry that 405 requires is real work and new state on
  a hot path, bought for a distinction no client acts on differently here.

  - [x] Add the sentence to "Requirements & limitations": page routes answer `GET`, `POST` and `HEAD`;
        every other method is a 404 rather than a 405, and an endpoint route is the way to answer one.

        _Done, in the README and beside the endpoint-route rules in `docs/routing.md` — which is where the way
            out belongs, since `method` defaults to `all` there. Pinned in `prod.test.mjs` as well: PUT, PATCH,
            DELETE and OPTIONS all 404 with no `Allow` header, and the endpoint route answers the OPTIONS a page
            will not. Those requests carry the app's own `Origin`, because the testbed's `csrf()` refuses an
            unsafe method with a foreign one before the router is reached — a 403 that says nothing about routing._

  - [ ] Revisit only if a real need appears (a `PUT`-based API mistakenly pointed at a page path is the
        plausible one). Adding `Allow` later is not a breaking change.

### ~~3.7 — `render: 'static'` routes the build skipped still take the prerendered lookup on every request~~ — ✅ resolved in `b1e8d8c`

- [x] ~~**`src/runtime/entry.rsc.tsx:429` computes `servesPrerendered` from `route.render === 'static'` alone.**~~

  The build's `skipped` list (`src/server/ssg.ts:140-141,150-152`) never reaches the runtime, and misses are
  deliberately **not** cached (`src/server/ssg.ts:64-68` — caching misses would let anyone mint entries), so it
  never warms up. A parameterised static route does a failed `readFile` for **every** param value that was not
  prerendered, forever — including every value affected by the encoding bug in [1.2](#12--blocker-prerendered-pages-whose-params-need-percent-encoding-are-built-and-then-never-served).

  **Fix:** record the prerendered paths in the build marker and gate the lookup on it.

  _Done, with the record in the store rather than in the build marker._ The marker is `rshono start`'s — the
  CLI reads it to refuse a build for another platform — and it does not travel into the asset store a
  target without a filesystem reads. `dist/ssg/manifest.json` does: it is written by the same pass that
  writes the pages, and Cloudflare's `finalize` already copies that whole directory into the assets tree.

  Keyed by `ssgFilePath`, not by request path — that function is the one canonical form both sides already
  share, so the index cannot disagree with the store about encoding the way the two sides once did about
  `café` ([1.2](#12--blocker-prerendered-pages-whose-params-need-percent-encoding-are-built-and-then-never-served)).
  Both readers gate on it: filesystem targets read it once per process, Workers fetch it once per isolate —
  worth a subrequest there, since it saves one on every miss. A missing or unparseable manifest reads as "no
  index", which gates nothing, so an older build behaves exactly as it did.

  `servesPrerendered` itself is unchanged: the gate sits one level down, in each runtime's
  `readPrerendered`, which is the only place that knows how its store is addressed. What is saved is the
  store access, not the branch.

  Covered in the unit suite (a file the manifest does not list is not served; no manifest still serves; a
  broken one does not take the store down) and on Workers by counting binding calls — a path the build never
  prerendered costs no page read at all.

### ~~3.8 — A plain-text 404 carries no `Cache-Control`~~ — ✅ resolved in `11d2a69`

- [x] ~~**`plainNotFound` (`src/runtime/entry.rsc.tsx:138-140`) is `text/plain`, so it misses the
      `PAGE_CONTENT_TYPE` gate at `:390` that adds `private, no-cache` at `:394`. [measured]**~~

  ```
  404  content-type: text/plain  vary: RSC  x-content-type-options: nosniff  …  (no cache-control)
  ```

  Verified `cc=null` on `PUT /`, `DELETE /`, and on `GET /nope` for an app with no `notFound` page.

  **Why it matters:** a 404 is heuristically cacheable per RFC 9111, so a shared cache may store it — while the
  _rendered_ HTML 404 next to it is correctly `private, no-cache`. The common case (a page that throws during
  render) returns the framework's `failureDocument` as `text/html` and _does_ get the default _[measured]_, so
  this is the uncommon path silently behaving differently.

  **Fix:** set it explicitly in `plainNotFound`. (The plain-text 500 at `:516` has the same gap, but 500 is not
  in the heuristic list, so that half is consistency only.)

  _Done as described, both halves,_ with the value pulled into a `PAGE_CACHE_CONTROL` constant so the three
  places that name it cannot drift. Asserted where the framework's own answers are actually reachable — the
  minimal app, which has neither page — and in `prod.test.mjs` against the _rendered_ 404 beside it rather
  than against a literal, since the point is that one request answered two ways must not promise two things.

### ~~3.9 — Wildcard / regex / optional params plus `staticPaths` fail the whole build with a raw error~~ — ✅ resolved in `8eba15f`

- [x] **`src/server/ssg.ts:43,49` throw out of `interpolatePath`, which nothing catches (`:144` →
      `buildCommand` → `main().catch` → `process.exit(1)`), and neither message carries the `[rshono]` prefix
      every other framework error uses.**

  Every _other_ unprerenderable route gets `⚠ … will SSR per request` and is pushed to `skipped`
  (`src/server/ssg.ts:140-141`). This one kills the build.

  **Fix:** catch per route, warn, skip — matching the behaviour one branch above it.

  _Done as described,_ over the whole of `await staticPaths()` rather than the interpolation alone: a
  `staticPaths` that **rejects** — a database that blipped mid-build — leaves the route exactly as
  unprerenderable, and killing the build over it is the same wrong trade.

  The messages became reasons rather than sentences, since the caller writes the line and already names the
  route, which is also what settles the missing `[rshono]` prefix — a warning in the `⚠` house style, like
  every one beside it:

  ```
  ⚠ Static route "/files/*" will SSR per request — wildcard segments are not supported by staticPaths.
  ⚠ Static route "/docs/:slug" will SSR per request — staticPaths returned a param set without "slug".
  ```

  **Deliberately still fatal**, one branch down: a `staticPaths` _value_ no single file can hold (`a b/c`,
  `a:b`, `..`). The distinction is route shape versus a named page — a shape nothing could prerender is the
  framework's business to route around, while a value the author asked for by name and the store cannot answer
  is theirs to see. Its own test keeps asserting the rejection.

### ~~3.10 — _(nit)_ A soft navigation to an unmatched path gets a payload without `notFound: true`~~ — ✅ resolved in `4610a7d`

- [x] ~~**`src/runtime/entry.rsc.tsx:484` omits the flag that `:421` sets.**~~

  No functional impact today — only `setServerCallback` reads it (`entry.client.tsx:376`) — but it is an
  inconsistency in the wire contract, and the kind that costs an afternoon later.

  **Fix:** pass `notFound: true` in both places.

  _Done as described._ Writing the test turned up something worth recording: a `notFound()` thrown from
  inside a **component** on a flight request never reaches either of those places. `renderComponent` hands
  the payload stream back before the render can throw (`entry.rsc.tsx:256`), so the response is committed and
  the signal rides the payload as a digest — `GET /profile/9999` with `RSC: 1` is a **200** carrying
  `RSHONO_NOT_FOUND`, which the client runtime turns into a real load. Same signal, same page, two ways of
  getting there; the suite now pins both, because they look interchangeable and are not.

---

## 4. Robustness and performance

### ~~4.1 — Neither half of the flight injector honours backpressure~~ — ✅ resolved in `5aa6611`

- [x] ~~**`src/runtime/flight-inject.ts:156-179` (`transform`) returns as soon as it has pushed to `batch`, so
      `pipeThrough` never backpressures React's HTML stream; `writeFlight` (`:122-154`) pumps the whole RSC
      stream into the controller from a detached promise (`:174`). Nothing consults
      `controller.desiredSize`.**~~

  A slow client therefore accumulates the whole document plus the whole payload in the process. Bounded by page
  size, so not a live incident — but it is the shape of a memory-pressure bug under load, and worth a
  deliberate decision before 1.0 rather than after.

  **Decided: real backpressure, from a pull-driven wrapper.** Measured first, because half the finding did not
  hold. The **payload** half did: a consumer that read one chunk and stalled still took all 500 chunks of a
  test payload into the readable's queue. The **HTML** half mostly did not — a deferred `emitBatch` still sets
  the transform's backpressure, so a React-shaped source (flushes separated by a macrotask) parked after 7
  chunks; only a producer that never yields the microtask queue was admitted in full.

  `controller.desiredSize` could not have fixed either: a transform readable's high-water mark is 0, so it is
  never positive, and `Transformer` has no "the consumer wants more" hook. `injectFlightPayload` therefore
  returns a `ReadableWritablePair` whose readable is a pull-driven wrapper around the transform; `pull` runs
  once per chunk the consumer takes and releases one permit, and both producers take one before they enqueue.
  Same payload, same stalled consumer: **3 chunks instead of 500**, and reading resumes it. The permit is per
  _batch_, not per chunk, because a React flush has to leave as one chunk — so what stays buffered is one
  flush, which is the bound React itself holds while building one.

  **The cost, measured** (`91d4af8`): 3.6ms → 4.0ms to push a 187 kB page (400 HTML chunks, 400 payload
  chunks) through the module with nothing else in the way — one extra stream hop and a microtask per chunk.
  Not the shape of a real response, where the socket write dominates by orders of magnitude, and the trade is
  a bounded process against an 11% slower in-memory pipeline.

  Two side effects worth recording. The wrapper's `cancel` is the one notification the standard never skips,
  where the transformer's own is skipped for the whole window `flush` spends awaiting the payload — so the
  teardown that releases the RSC branch and fires `onDone` now hangs off the reliable one, and is idempotent
  because both can reach it. And the two enqueues in `flush` are deliberately left ungated: the response is
  over by then, and parking its last two chunks would only add a way for it not to end.

### ~~4.2 — `injectFlightPayload` has no guard for a document trailer straddling two batches~~ — ✅ resolved in `0ea397c`

- [x] **`emitBatch` tests for `</body></html>` on the joined batch only (`src/runtime/flight-inject.ts:118`);
      no tail is carried across batches. [measured]** Feeding it `</bo` and `dy></html>` separated by a real
      macrotask:

  ```
  <html><body><p>hi</p></bo<script>(self.__FLIGHT_DATA||=[]).push("0:\"hi\"\n")</script>dy></html></body></html>
  ```

  The flight `<script>` is injected **inside the `</body>` tag** and the trailer appears twice.

  **Status: defence-in-depth, not a live bug.** The module's own comment at `:97-99` states the assumption
  explicitly — _"React writes its final flush in one synchronous run, so a trailer split across batches is not
  a shape it produces"_ — and that is correct today. But this injector exists **because** `rsc-html-stream`
  made a narrower version of the same assumption and got it wrong (see the module header at `:6-8`), so the
  assumption deserves a guard rather than a comment.

  The five existing split tests cannot catch it: they enqueue synchronously, so every split lands in one batch.

  **Fix:** carry a `TRAILER_BYTES.length - 1` byte tail across batches; add a macrotask-separated test.

  _Done as described,_ with the tail chosen rather than fixed: `emitBatch` holds back the longest suffix of the
  batch that is a prefix of the trailer — 14 bytes at most and **0 in practice**, since a React flush ends
  with a closed tag rather than the start of one, so no intermediate flush pays for the guard. `flush` is the
  one call allowed to emit such a tail, because by then there is no next batch to complete it.

  Two consequences worth recording. A false trailer mid-document is no longer silently dropped — it only
  leaves the carry if nothing completes it, which is strictly better than the old unconditional drop. And a
  tail that never completes leaves **after** the payload scripts rather than before them: releasing it the
  moment a script wants to go out is the very bug being guarded, since the next batch may be the rest of the
  trailer. That costs at most 13 bytes of a truncated document arriving late, still inside `<body>`, and only
  a truncated document can reach it. Both halves are pinned by the new macrotask-separated test.

### ~~4.3 — `prerenderStaticRoutes` renders sequentially and does not deduplicate~~ — ✅ resolved in `33da990`

- [x] ~~**`src/server/ssg.ts:134-173` awaits each path in turn and renders each twice (document at `:148`, then
      flight at `:164`).**~~

  A documentation site with a few hundred `staticPaths` entries pays all of that serially, and a duplicate
  entry is rendered and written twice with no warning.

  **Fix:** bounded-concurrency map over paths; de-duplicate the interpolated path list before rendering.

  _Done as described._ The pass is now two: expand the routes into a de-duplicated target list, then render
  that list through a worker pool of **8** — a pool rather than fixed batches, since a batch is only as fast
  as its slowest member. The app's own handler serves these renders, so the concurrency is the concurrency a
  request already gets in production. The two renders _per_ path stay sequential: the flight payload is only
  worth asking for once the document came back 200.

  Three things moved so that a concurrent pass stays as legible as a serial one. `written`, `skipped` and the
  manifest are folded back in **target order** rather than completion order; each path's warnings are buffered
  and printed with it, so the build log does not depend on which page finished first; and `ssgFilePath` is
  resolved during expansion, so which of several unrepresentable paths fails the build does not depend on
  render order either. A repeated path is warned about once per route with a count rather than once per
  occurrence — it is usually a bug in the app's query, and a site with many duplicates should not get a wall
  of them.

---

## 5. API surface — the parts that freeze at 1.0.0

The public surface is three entry points and is the right size: `defineRoutes` / `defineConfig` plus types from
`@rshono/core`; `getRequestContext` / `redirect` / `notFound` / `onServerError` / `publicUrl` from `/server`;
`useNavigation` / `AsyncBoundary` / `CatchBoundary` from `/client`. Verified that `dist/index.js` pulls in no
runtime machinery, as advertised. These are the items that cannot change after 1.0.0 without a major.

- [x] ~~**5.1 — `onServerError` cannot reliably reach `waitUntil`, and reaches it inconsistently.**~~ — ✅ resolved in `02c6cd7`.
      `ServerErrorHandler` is given `(error, { source, request })` and its return value is ignored
      (`src/runtime/context.ts:555-563,607-621`), so on Workers and Lambda a report started there is cut off
      when the response ends. There _is_ an undocumented workaround — `getRequestContext().hono.executionCtx` —
      but it works for only three of the four sources: `render`, `ssr` and `action` are reported from inside
      `runWithContext`, while `source: 'request'` is reported at `entry.rsc.tsx:500`, **outside** it, where
      `getRequestContext()` throws. Reporting is the one thing this hook exists for.
      → **Fix:** put the Hono `Context` (or a `waitUntil`) on `ServerErrorContext`. That also gives a handler
      `c.var.requestId` to correlate on, which it cannot get today.

      _Both, not either._ `hono` closes the reachability gap and carries `hono.var` / `hono.env`;
          `waitUntil` is there because `c.executionCtx` **throws** where a platform has no execution context —
          the `node`, `vercel` and `aws-lambda` targets, and dev — so a handler reaching for it itself would
          have its report swallowed by the guard that keeps reporting from failing a request, on exactly the
          platforms where nothing needed holding open. It is a no-op there instead, and its doc says so per
          target, including that `hono/aws-lambda`'s `streamHandle` exposes no execution context to ask (verified
          in `node_modules/hono`: it calls `app.fetch(req, env)` with no third argument), so a slow report on
          Lambda is best-effort. Wrapping `streamifyResponse` to fix that was rejected — the marker it puts on
          the handler is what makes Lambda stream at all, so holding the invocation open would mean
          reimplementing the adapter.

          `ServerErrorContext` and `ServerErrorHandler` became generic over the app's `Env`, defaulting so
          nothing existing changes, matching `getRequestContext<E>`. `reportServerError` takes `hono` and
          derives `request` from it, so the nine call sites did not grow. The testbed's reporter now uses both
          for real, so the existing assertion on `[error-reporter] request /api/boom` — the source reported
          outside the ambient context — proves both reach a handler.

- [x] ~~**5.2 — `EndpointRoute.method` takes a single method.** `method?: HTTPMethod` (`src/router.ts:214`)
      cannot express `['get', 'post']`, so a two-method endpoint has to be `'all'` plus a hand-rolled check.
      Widening to `HTTPMethod | readonly HTTPMethod[]` is backward compatible, and much harder to add after
      1.0. Settle alongside [1.3](#13--blocker-httpmethod-advertises-head-which-can-never-match).~~ — ✅
      resolved in `21aef60`.

      _Widened as described._ Registration de-duplicates the list, because `app.on(['GET', 'GET'], …)`
          registers the path twice. Validation refuses the two lists that are mistakes rather than guessing:
          an empty one, and one containing `'all'` — which is either the whole thing or a slip, and answering
          every method quietly is exactly the shape `validate-entries.ts` exists to prevent. A bad *member* is
          named rather than the array printed, so `['get', 'HEAD']` still gets the "use 'get'" advice.
          `methodsOf` flattens a list the same way it expands `'all'`, so the shadowing check holds for both.
          The testbed grew a real two-method endpoint, asserted over HTTP for both listed methods and two that
          are not.

- [x] ~~**5.3 — `staticPaths` is not typed against its own path.**~~ — ✅ resolved in `43993c0`. `src/router.ts:189` returns
      `Array<Record<string, string>>`, so a typo in a param key is a build-time throw from `interpolatePath`
      (`staticPaths for "…" returned a param set without "…"`, `src/server/ssg.ts:53`) rather than a type error.
      `PathParams<P>` already exists. Using it here means either making `PageRoute` generic over `path` or
      extending the `ValidateRoute` conditional that already captures `P` for the `component` check — worth
      doing while the type is still free to move.

      _The second one._ Making `PageRoute` generic would not have worked: the contextual type comes from the
          `Route` constraint, so `staticPaths` would still be checked against `Record<string, string>`.
          Extending `ValidateRoute` brands the `staticPaths` field the same way a props mismatch brands
          `component`.

          **Keys, not assignability** — that was the one real decision. `[Awaited<Sets>] extends
          [ReadonlyArray<PathParams<P>>]` looked right and was wrong: `Record<string, string>` is not assignable
          to `{ slug: string }`, so a `staticPaths` annotated as returning exactly the type the field declares
          became a type error. Comparing `keyof PathParams<P>` against `keyof Set` accepts an index signature
          (nothing to check, so the build stays the backstop) and still rejects a wrong or missing key. A
          param-less path is skipped, since `staticPaths` is never called for one.

          Verified both ways against the testbed: `{ wrong: 'a' }` and `{}` for `/docs/:slug` are errors naming
          the path; an inferred `{ slug }`, extra keys beside it, a synchronous return and an explicit
          `Record<string, string>` annotation all still compile.

- [x] ~~**5.4 — `RequestContext` has eight throw-only stubs.**~~ — ✅ resolved in `b511c2b`. `redirect`, `notFound`, `json`, `text`, `html`,
      `body`, `status`, `header` (`src/runtime/context.ts:400,408,413,418,423,428,436,444`). The intent is
      right and the messages are excellent, but they are public members marked `@deprecated` that will never be
      un-deprecated and never removed. **Decide now:** keep them and say in the class doc that they are
      permanent teaching stubs, or drop them and rely on the type error.

      **Decided: keep, and say so.** The type error is not a substitute — `ctx.redirect('/x')` would become
          "property does not exist", which says what is wrong and not what to do, and in a JavaScript app nothing
          at all until `ctx.redirect is not a function` at runtime. The class doc now states that the eight are
          permanent and that `@deprecated` is there for the strike-through an editor draws with it rather than
          for its meaning; the API reference says the same, so the tag need not be read as a promise. No
          behaviour change — the eight were already asserted in the unit suite.

- [x] ~~**5.5 — `PageProps.ctx` is a non-enumerable getter**~~ — ✅ resolved in `d9b6cc9`. So `<Page {...props} />` and any `{...props}`
      spread silently drop it. Documented at `src/router.ts:67-87` and at `entry.rsc.tsx:184-197`, and
      unavoidable given the React serialization constraint (an enumerable `ctx` would ship `ctx.hono.env` — every
      binding and secret — to the browser in dev). But it is the one place the API breaks a JavaScript
      expectation. Worth a dev-only tripwire, or at minimum a line in the pages docs.

      **Documented, in all three places someone would look** — the `ctx` JSDoc, the page-props docs and the
          README's limitations — each naming the fix, which is that nested server components call
          `getRequestContext()` rather than being handed the context. The docs covered the *client* spread
          already; the case worth writing down is a spread into another **server** component, which fails at
          nothing and leaves `ctx: undefined` while the type says otherwise.

          **A dev-only tripwire was considered and rejected.** A spread reaches the getter through the same
          `get` a legitimate `props.ctx` read does, so the only way to tell them apart is to guess from a
          preceding `ownKeys` — which React's own prop enumeration would trip. Making `ctx` enumerable in dev
          is the one thing the property exists to prevent.

- [x] ~~**5.6 — `RshonoConfig.trustProxy`'s doc block does not say it is compile-time only.**~~ — ✅ resolved
      in `b761f22`, with 5.7. `src/runtime/context.ts:114` reads it from the `DefinePlugin` constant, so one
      artifact cannot be promoted from a direct-exposure staging box to a proxied production one.
      `README.md` states this plainly; the JSDoc a user actually hovers (`src/config.ts:55-72`) did not — it
      now carries both that and the `vercel` exception from 5.7.

- [x] ~~**5.7 — The `vercel` target derives the request scheme from `X-Forwarded-Proto` regardless of
      `trustProxy`.**~~ — ✅ resolved in `b761f22`, folded into 5.6 as suggested. `browserScheme` (`src/deploy/vercel/runtime.ts:18-22`) reads the header and defaults to
      `https`, and `serveApp` rewrites `incoming.url` with it before Hono sees the request — so `publicUrl(c)`,
      `ctx.url` and a page's `url` prop reflect it even with `trustProxy: false`. This is **intended and well
      reasoned** (the doc comment at `:13-16` explains that on this target the header is not client-supplied),
      and `test/deploy-targets.test.mjs` asserts it. What is missing is that neither the `trustProxy` doc block
      (`src/config.ts:55-72`) nor the deployment docs mention the exception. Fold into 5.6.

      *Scope note:* the `Host` header is **not** part of this. `@hono/node-server` builds every request URL as
                      `` `${scheme}://${host}${path}` `` from `incoming.headers.host`, so `Host` is equally load-bearing on the
                      `node` target and on every Node server ever written. Only the scheme is vercel-specific.

          _Re-checked while fixing:_ the **deployment** docs did already have it ("This needs no `trustProxy`:
          on this target the header is not client-supplied"). What was missing was the field's own JSDoc, and a
          precise word in the configuration docs' proxy-header section — which said "leave it off on vercel"
          without saying that the scheme is honoured regardless. Both now say the exception is the **scheme
          only**, and the scope note above is stated where a reader will meet it.

- [x] ~~**5.8 — `require('@rshono/core')` fails outright** — verified `ERR_PACKAGE_PATH_NOT_EXPORTED`, since
      `packages/core/package.json:25-31` declares only `types` and `import` conditions. Correct for an ESM-only
      framework; worth one documented sentence rather than a discovery.~~ — ✅ resolved in `ecd1731`.
      Re-verified (`ERR_PACKAGE_PATH_NOT_EXPORTED` against the installed package), then written into the
      README's limitations and the API reference, each naming the two things that do work: `import`, or
      `await import()` from CommonJS.

- [x] ~~**5.9 — `ErrorPageInfo.stack` is optional in the type and present only in dev**
      (`src/runtime/entry.rsc.tsx:503-508`). The `error` page is app-authored, so make the dev-only-ness
      explicit in the `ErrorPageProps` example.~~ — ✅ resolved in `ecd1731`.

      _Done, and the field's own doc says why it is optional_ — dev-only, not "some errors lack one" — so a
          page guards on the stack rather than on a mode flag, there being no mode flag to guard on. The example
          now shows that guard; the routing docs and the API reference say the same. (Both scaffolded and testbed
          `error` pages already did it correctly; the example was the only place that did not.)

- [x] ~~**5.10 — The prerendered-page `Cache-Control` is hardcoded.**~~ — ✅ resolved in `328e056`.
      `SSG_CACHE_CONTROL = 'public, max-age=300'` (`src/runtime/entry.rsc.tsx:46`) has no config field and no
      documented override, and a prerendered site is exactly where a longer `max-age` or a
      `stale-while-revalidate` belongs. Either expose it or document the supported recipe — and if the recipe
      is middleware, say explicitly that it has to run **after** `await next()`, since the SSG path passes
      `cache-control` in the `c.body(...)` header bag (`:446-453`).

      **Decided: document the recipe, keep the constant.** A cache policy is a per-response header and
          `rshono.config.ts` is compiled into the bundle, so a value that takes a rebuild to change is the wrong
          shape for one — middleware is the interface the framework already has for response headers. The recipe
          is now at the constant, in the caching docs and in the static-rendering list, and it says **after
          `await next()`** as the review asked — verified against Hono directly rather than assumed: a response
          built with `cache-control` in the `c.body(...)` bag beats a header prepared with `c.header(...)`.
          (A *dynamic* page is the easier case, since its default is only applied if nothing else set one.)

          Pinned in `prod-config.test.mjs` under a `TESTBED_SSG_CACHE` profile that keeps the `c.header(...)`
          line which does **not** survive, so the test pins the ordering rather than just the outcome — plus what
          the edit leaves alone: the `ETag` (revalidation still costs a 304) and the `Vary`.

- [x] ~~**5.11 — `index.ts`'s `@packageDocumentation` omits `publicUrl`.**~~ — ✅ resolved in `2fd1eae`,
      with the ESM-only note from 5.8 beside it. `src/index.ts:6` describes
      `@rshono/core/server` as "request context, `redirect`, `notFound`, `onServerError`". `publicUrl` is
      exported too and is the documented way to give `csrf()` the real origin — the single most important line
      in the scaffolded `src/server.ts`. (`src/runtime/server.ts`'s own module doc _does_ mention it; the two
      disagree.)

---

## 6. Test coverage

192 tests over 30 suites. The e2e layers (production, hardened config, per-target, dev, minimal, postcss) plus
a Playwright suite for the client runtime are genuinely thorough — richer than most frameworks ship. **The gaps
are concentrated in the unit layer, which imports 12 of the ~49 source modules** (verified from
`test/unit.test.mjs:11-22`).

_As of `b0039f0`: **281 tests over 42 suites**, the unit layer importing 15 modules, and a coverage floor of
82 lines / 90 branches / 75 functions over `dist/**` ([6.9](#missing-behavioural-coverage)) so the number
cannot quietly slide back._

### Tests that are wrong today

- [x] ~~**6.0 — `test/unit.test.mjs:344-351` has one assertion that proves nothing, and a comment that is
      wrong.**~~ — ✅ resolved in `86f3a0c`, with **one half of the finding withdrawn** — see below. "refuses to escape the ssg directory, decoded form included" runs three paths against a _freshly
      created empty_ temp dir. `/../` and `/docs/../../etc` are genuinely rejected by the guard; **`/..%2f` is
      not** — verified directly against `dist/server/prerendered.js`:

      ```
                      /../             -> null              (rejected by guard)
                      /..%2f           -> "..%2f/index.html"   ** NOT rejected by guard **
                      /docs/../../etc  -> null              (rejected by guard)
                      ```

                      The regex at `src/server/prerendered.ts:43` requires a literal `..` followed by `/` or end-of-string, so
                      `/..%2f` returns `null` from `readPrerendered` **only because the file is absent**. The comment claims
                      the encoded form is "decoded *before* the check", which no code in `readPrerendered` does — the actual
                      decoding happens upstream in Hono's `getPath`.
                      → **Fix:** assert on `prerenderedRelPath` directly, plant a real file outside the root, and — since the
                      safety of the encoded case rests entirely on an upstream Hono behaviour — pin that behaviour with a test
                      of its own. (It *is* safe today; see [Appendix A](#appendix-a--dismissed).)

  **The "proves nothing" half was real and is fixed.** The test now plants the file a traversal is aiming at,
  one `..` from the root, with a control assertion that the bytes are readable from there — so only the guard
  can refuse the request. Five attempts including the escaped forms, plus a page of the same name _inside_ the
  root, so the guard is not simply refusing everything.

  **The `/..%2f` half does not hold against the current tree.** Re-measured: `ssgFilePath('/..%2f')` is
  `null`, because it decodes **each segment** before checking it — `..%2f` decodes to `../`, which holds a
  `/` and is not a storable name. `/..%2F` and `/%2e%2e/secret` likewise. The earlier reading was taken
  against a build from before the per-segment decode ([1.2](#12--blocker-prerendered-pages-whose-params-need-percent-encoding-are-built-and-then-never-served)),
  and the comment about decoding before the check is accurate — `ssgFilePath` is where it happens.

  **The upstream half was still worth pinning**, and is: the URL parser resolving `%2e%2e` when the `Request`
  is built, and Hono handing a handler a `decodeURI`'d path. That second test turned up the detail worth
  having in writing — `decodeURI` leaves reserved escapes alone, so `%2F` reaches the router as an escape
  rather than a separator, and the framework's own per-segment `decodeURIComponent` is what refuses it as a
  name. Plus `/..%252f`, pinned as the literal directory name it is so nobody "fixes" it into a traversal.

- [x] ~~**6.0b — `test/prod.test.mjs:141` passes for the wrong reason.**~~ Done with 3.4 in `4f4ae3e`; see 3.4(b) and 3.4(e) for what the replacement can and cannot pin. See
      [3.4](#34--redirect-raised-after-the-ssr-shell-has-flushed-never-becomes-a-real-3xx), now decided. The
      replacement needs a `<Suspense>` child that genuinely loses the race, for both `redirect()` and
      `notFound()`, and must assert the **digest survives the abort** — not merely that a redirect eventually
      happens. A test that only checks the end state would pass even if the `setImmediate` in 3.4(b) were
      dropped, which is the exact regression that would break every JavaScript client.

### Missing unit coverage

- [x] ~~**6.1 — `src/runtime/request.ts` has no unit tests at all.** It classifies every request as document /
      flight / form-action / client-action (`:49-57`), and both the CSRF guard and the `Vary` behaviour hang off
      that classification. Table-drive `parseRenderRequest` over method × `x-rsc-action` × content-type × `RSC`
      header, and round-trip `createRscRequest` through it.~~ Done with
      [2.7](#27--write-down-that-client-initiated-actions-rely-on-the-cors-preflight) in `e3b181c`.
- [x] ~~**6.2 — `publicUrl` has no unit test.**~~ — ✅ resolved in `1d73740`, every case listed plus a
      blank first hop, a non-http(s) scheme (compared case-sensitively) and that each call returns a fresh
      URL. The `trustProxy: true` branch needed a fresh module instance with the `DefinePlugin` global set,
      since the flag is read once when the module is evaluated. It is reached only through `test/prod-config.test.mjs:122`'s
      `csrf()` assertions. Cover it directly: `trustProxy` off, `trustProxy` on, a comma-separated forwarded
      chain (only the first hop is honoured, `src/runtime/context.ts:107-110`), a forwarded host carrying no
      port (the internal port must be dropped — asserted end-to-end at `test/prod-config.test.mjs:119`, never in
      isolation), and an unparseable `X-Forwarded-Host`.
- [x] ~~**6.3 — `src/server/load-config.ts`'s error branches are untested.**~~ — ✅ resolved in `1d73740`:
      all four branches, plus the `{ts,js,mjs}` scan and its precedence, a relative `--config`, a config that
      throws being let through as itself, and the `.ts` hint asserted down to the original error surviving as
      `cause` — with the advice it gives shown to work, from a second directory, because Node's module
      registry keeps the failed load under its URL. The happy path of `--config` is
      covered indirectly (`prod-config.test.mjs` builds with `trust-proxy.config.mjs`). Nothing covers: no
      config file at all (`:30`, returns `{}`), an explicit `--config` pointing at a missing file (`:32`), a
      config with no default export (`:50`), or the bespoke `.ts`-imports-a-`.js`-specifier hint (`:39-46`).
- [x] ~~**6.4 — The error-reporting funnel has no unit test.**~~ — ✅ resolved in `1d73740`: the three cases
      listed, plus the shape a handler is handed, that stderr still gets it, a primitive throw being reported
      wherever it is caught (nothing can track it), and `waitUntil` on a platform with no execution context
      — a no-op that swallows a rejection rather than letting a failed report end the process. `reportServerError`'s `alreadyReported`
      de-duplication (`src/runtime/context.ts:611`), an `onServerError` handler that itself throws (handled at
      `:616-620` — must be caught, must not fail the request), and re-registration replacing the previous
      handler (`:598`). `test/prod.test.mjs:385` covers the happy path only.
- [x] ~~**6.5 — `refusesCrossSiteForm` is tested for three shapes; the ones the §2 items turn on are missing.**~~
      — ✅ closed: all three were added with 2.3 (`5f296e1`) and 2.4 (`a084b69`); see the note at the end of
      the item.
      `test/minimal-app.test.mjs` covers no `Sec-Fetch-Site` + foreign `Origin` (`:73-87`), `cross-site` +
      mismatched `Origin` (`:95-100`), and `cross-site` + the app's own `Origin` (`:104-109`). **Add:**
      `same-site` + foreign `Origin` (the subdomain hole,
      [2.3](#23--the-built-in-csrf-guard-leaves-a-same-site-cross-origin-form-post-to-csrf)), `cross-site` with
      **no** `Origin` ([2.4](#24--hardening-refusescrosssiteform-allows-sec-fetch-site-cross-site-with-no-origin)),
      and `Origin: null` (sandboxed iframe or `data:` URL). — ✅ all three added with 2.3 (`5f296e1`) and 2.4
      (`a084b69`), plus a `same-origin` post whose `Origin` a proxy rewrote.
- [x] ~~**6.6 — `defineRoutes` has no negative type test.**~~ — ✅ resolved in `18bf56b`:
      `apps/testbed/types/routes.tsx`, ten `@ts-expect-error` assertions and eleven cases that must still
      compile — the props mismatch in both overloads, a wrong and an empty `staticPaths` key beside the forms
      that have to keep working, and the endpoint `method` union. Outside `src/` so nothing bundles it, and
      inside the testbed's `tsconfig` `include`, so the existing "typecheck against the published types" job
      runs it with no new CI step. Each directive sits above the whole `defineRoutes(...)` call: inside the
      array literal it lands a line early and asserts nothing. The `ValidateRoutes` machinery
      (`src/router.ts:305`) is the most intricate type in the package and its whole job is to _fail_. CI
      typechecks the testbed, which covers the positive case; nothing asserts that a `PageProps<'/a/:b'>`
      mismatch is still an error. An `@ts-expect-error` fixture keeps a refactor from silently switching the
      check off.

### Missing behavioural coverage

- [x] **6.7 — No `HEAD` request anywhere in the suite** — ✅ done with [3.5](#35--a-head-on-a-page-route-renders-the-page-and-throws-the-result-away) in `a9da318`. _(original text below)_ (verified: no `HEAD` in any test source outside built
      fixtures). Add status, headers, empty body, and that the render is released — see
      [1.3](#13--blocker-httpmethod-advertises-head-which-can-never-match) and
      [3.5](#35--a-head-on-a-page-route-renders-the-page-and-throws-the-result-away).
- [x] ~~**6.8 — No test that two concurrent in-flight requests keep separate `AsyncLocalStorage` contexts.**~~
      — ✅ resolved in `fe679bd`, at both levels: a `runWithContext` unit test that interleaves four flows
      (the longest starts first and finishes last) and reads the context on **both sides of an await**, so
      what is asserted is that the store survives a suspension; and eight concurrent HTTP requests to
      `/whoami`, which awaits before reading the context and echoes a header and a cookie back, so each
      response must carry its own values and none of the other seven's. The
      request context is one of the four boundaries `SECURITY.md` owns; every existing context test is
      sequential (verified: the only `concurren*` match in the suite is
      `test/prod-config.test.mjs:14`, a comment about the test runner).
- [x] ~~**6.9 — No coverage measurement anywhere**~~ — ✅ resolved in `b0039f0`: `test:coverage` is `test`
      plus Node's own coverage with three thresholds — 82 lines / 90 branches / 75 functions, just under the
      82.72 / 90.94 / 76.04 measured — and a CI job on Ubuntu runs it. Scoped to `dist/**`, which is the
      difference between a gate and noise: unscoped, the report fills with the testbed's bundle and the temp
      directories the e2e suites boot servers from, and the aggregate swings on how many servers a run
      happened to start. Both directions verified: it passes at those floors and fails when one is raised
      past what the suite reaches. The number is what the suite reaches **in process**, which is written down
      beside it so 82% is not read as "18% untested" — the e2e suites run the app in a child process, and
      `entry.client.tsx` is browser-only. (no `c8` / `nyc` / `--experimental-test-coverage` in
      `packages/core/package.json:58-59` or `ci.yml`). Wire it with a floor so a new branch cannot land
      untested; `src/runtime/entry.client.tsx` (471 LOC, browser-only) and the deploy runtimes are the likely
      blind spots.

### Tests that pin the fixes above

- [x] ~~**6.10** — the [1.2](#12--blocker-prerendered-pages-whose-params-need-percent-encoding-are-built-and-then-never-served)
      encoded-param SSG round-trip, end to end rather than `interpolatePath` in isolation.~~ — ✅ closed:
      already covered, in three places. `prod.test.mjs:658` asserts the `café` slug over HTTP in **both**
      representations, with the `ETag` proving it came off disk, and reads the file at its decoded name;
      `cloudflare.test.mjs:160` does the same through the asset store; and the unit round trip
      (`prerenderStaticRoutes` → `readPrerendered`) covers `a b` as well. Ticked rather than added to.
- [x] ~~**6.11** — the [2.1](#21--the-env-shadow-does-not-cover-processenv-processenv-or-an-aliased-process)
      env-shadow bypass table, as a loader unit test.~~ — ✅ closed: already there, all six shapes of the
      table plus `typeof process !== 'undefined'`, beside the `globalThis.process` warning (five spellings),
      the directive-prologue cases and the fail-the-build-if-the-layer-is-unreadable branch.
      `env-shadow-loader.cjs` is at 100% line, branch and function coverage.
- [x] ~~**6.12** — the [3.1](#31--port-binds-a-random-port-instead-of-the-default) `PORT=""` / `PORT=abc` /
      out-of-range cases for `rshono start`.~~ Done with [3.1](#31--port-binds-a-random-port-instead-of-the-default)
      in `f71f16a`, plus a `parsePort` table in the unit suite.
- [x] ~~**6.13** — the [3.2](#32--an-action-request-that-fails-before-its-payload-is-produced-makes-the-browser-throw-a-typeerror)
      action-then-`onError` payload shape, and a non-flight (413) action response.~~ Done with 3.2 in `ae127b0`:
      two `prod.test.mjs` cases for the payload shape, one `test/browser` case for the 413 — which only the
      client runtime can observe, so it does not run under `pnpm test` (see **8.3**).
- [x] ~~**6.14** — endpoint routes with `method: 'options'`; duplicate route paths; a `routes.ts` that does not
      use `defineRoutes` — once [1.4](#14--blocker-srcroutests-and-srcserverts-are-cast-not-validated) adds
      validation, assert the messages.~~ — ✅ resolved in `b0039f0`. The duplicate-path and no-`defineRoutes`
      messages were already asserted by 1.4's `validateRoutesModule` suite. `method: 'options'` was the gap,
      and it is the method that matters: no page route will ever answer one, and a cross-origin action needs
      it answered, since a CORS preflight _is_ an OPTIONS. The testbed now has that endpoint, and the
      404-not-405 test asserts both halves — the named method reaches the handler, and the same path asked for
      as a page is still the notFound page.
- [x] ~~**6.15** — `test:browser` is a separate CI job and not part of `pnpm test`. Fine as a split — worth one
      line in `CONTRIBUTING.md` so a contributor knows a local `pnpm test` does not cover the client runtime.~~
      — ✅ resolved in `b0039f0`, in the testing section, naming what only that job can see and when to run it.

---

## 7. Docs and repo hygiene

- [x] ~~**7.1** — `packages/core/README.md:20` — "`react-server-dom-rspack` is still `0.0.x`" contradicts the
      manifest (`0.1.0`).~~ Resolved with [1.1](#11--blocker-the-published-dependency-versions-have-never-been-tested)
      in `ee25131`, along with the same claim in the website's `getting-started.md`, the `.d.ts` header and
      `packages/benchmarks/README.md`; all four now say "pre-1.0" rather than naming a digit.
- [ ] **7.2** — `packages/core/README.md` "Requirements & limitations" should gain: the `/_static` middleware
      exception ([2.2](#22--srcserverts-middleware-never-runs-for-_static)), the `HTTPMethod`/`HEAD` note
      ([1.3](#13--blocker-httpmethod-advertises-head-which-can-never-match)), the prerendered-param encoding
      constraint ([1.2](#12--blocker-prerendered-pages-whose-params-need-percent-encoding-are-built-and-then-never-served)),
      the late-control-signal limitation and its app-side fix (3.4(d), **decided**), and the page-route
      405-vs-404 choice (3.6, **decided**).
- [ ] **7.3** — Root `tsconfig.json:17` sets `baseUrl`, which `packages/core/README.md:52` tells users
      TypeScript 7 removed. Harmless (the root builds on TS 6) but it is the repo doing the thing its own docs
      advise against.
- [x] ~~**7.4** — `CHANGELOG.md` `[Unreleased]` is empty while `packages/core/package.json` carries an unrecorded
      dependency bump ([1.1](#11--blocker-the-published-dependency-versions-have-never-been-tested)).~~ Recorded
      in `ee25131`: `[Unreleased]` now carries the bump, why the pair moves together, and the `check:pins` guard.
      Anything later items add goes beside it.
- [ ] **7.5** — Re-read `SECURITY.md` against the code once [2.3](#23--the-built-in-csrf-guard-leaves-a-same-site-cross-origin-form-post-to-csrf)
      and [2.7](#27--write-down-that-client-initiated-actions-rely-on-the-cors-preflight) are settled. It is a
      public commitment about what counts as a vulnerability; the wording is defensible today but narrower than
      it reads.
- [ ] **7.6** — State the semver story for a pre-1.0 dependency. `README.md` is candid that
      `rspack.experiments.rsc` is experimental and that `react-server-dom-rspack` is pinned. A `1.0.0` that
      promises semver on an API built over two pre-1.0 dependencies should say in the README — not only in the
      changelog — what a breaking upstream change means for the major version.

---

## 8. Release checklist

- [ ] **8.1** — [1.1](#11--blocker-the-published-dependency-versions-have-never-been-tested) resolved and the
      full suite re-run against the _published_ resolution. **1.1 is resolved** (`ee25131`) and everything that
      runs without a browser is green against 2.2.1 / 0.1.0 — lint, typecheck, 192/192, testbed, and `scaffold`
      at 42/42. This stays open on **8.3** alone: `test:browser` has not run against the new pair.

      _Re-run at `e23b5b1`, end of the §4–§6 pass:_ `pnpm check:pins` ✅ (all four pins agree across
          manifests, overrides, lockfile and `node_modules`), `pnpm lint` ✅, `@rshono/core typecheck` ✅,
          `@rshono/core test` **281/281** ✅, `testbed typecheck` ✅ (which now runs the negative type tests from
          [6.6](#missing-unit-coverage)), `@rshono/create typecheck` ✅ and `@rshono/create test` **36/36 + 6
          skipped** ✅ (the six are the `CREATE_RSHONO_E2E=1` cases). Still open on **8.3** alone.

- [x] ~~**8.2** — `pnpm lint` green.~~ ✅ _Clean at `e23b5b1`, and after every commit of this pass — an
      earlier review reported two errors; that was stale._
- [ ] **8.3** — `pnpm --filter @rshono/core test:browser` green on a machine with Chromium. It is the only
      coverage the client runtime has, it did not run for either review, and
      [3.4](#34--redirect-raised-after-the-ssr-shell-has-flushed-never-becomes-a-real-3xx)'s recovery path
      depends on it.

      **Attempted and blocked, not skipped.** Every spec fails at `browserType.launch` with
          `Received signal 11 SEGV_ACCERR` — Chromium segfaults on launch in this environment (a sandboxed macOS
          container), before a single page loads. That is environmental and says nothing about the suite: the
          build step ahead of it succeeds and the failure is identical for all 30 specs. **This is the one item
          in this document that needs a machine, not a change** — run it on Linux or an unsandboxed macOS
          checkout. `CONTRIBUTING.md` now says what only this job can see
          ([6.15](#tests-that-pin-the-fixes-above)), so it is at least hard to forget.

- [x] ~~**8.4** — `pnpm --filter @rshono/core test` green (192+).~~ ✅ **281/281 over 42 suites** at
      `e23b5b1`, and `test:coverage` green at its floor
      ([6.9](#missing-behavioural-coverage)): 82.72 lines / 90.94 branches / 76.04 functions over `dist/**`.

      _Windows caveat, found in CI and fixed in `556a580`._ The two `minimal-app` cases that assert a build
      *fails* with a named validation error were failing on Windows for the wrong reason: the build died first
      on `Can't resolve '@rshono/core'`. They copy the fixture and borrowed its `node_modules` through a
      `'junction'` from the OS temp directory — a reparse point to another volume, which the bundler's
      resolver does not traverse there. `react` and `hono` hid the shape of it, being answered by the
      *framework's* own tree. The copy now lives one level **inside** the fixture with no `node_modules` of
      its own, so the resolver walks up and finds the real one: no link, no volume boundary, the same path on
      every platform. The identical junction in `unit.test.mjs` was never needed and is gone too.
- [x] ~~**8.5** — CHANGELOG entry under `[Unreleased]` for whatever of the above ships.~~ — ✅ written in
      `e23b5b1`. `[Unreleased]` carried only the dependency work from 1.1; it now covers the whole pass as
      **Changed / Added / Fixed / Security**, written for someone upgrading rather than as a commit log, with
      the two entries that can require a change named up front — the `@rspack/core` /
      `react-server-dom-rspack` pair, and `HTTPMethod` losing `'head'`.
- [ ] **8.6** — `SECURITY.md` and `README.md` re-read against the code (7.2, 7.5, 7.6).

      _Partly done, and deliberately not closed._ `README.md` gained what §5 turned up — the non-enumerable
          `ctx` prop ([5.5](#5-api-surface--the-parts-that-freeze-at-100)) and the ESM-only surface
          ([5.8](#5-api-surface--the-parts-that-freeze-at-100)) — and the docs gained the `onServerError`,
          `method`, `staticPaths`, `trustProxy`, `ErrorPageInfo` and prerendered-cache entries. But this item is
          gated on **7.2, 7.5 and 7.6**, which are §7 and outside this pass: the remaining README additions, the
          `SECURITY.md` re-read, and the semver story for a pre-1.0 dependency. Leave it open until §7 lands.

---

## Suggested order

1. ~~**[1.1](#11--blocker-the-published-dependency-versions-have-never-been-tested) first.** The dependency drift
   invalidates every other result in this document, including the 192 passing tests.~~ ✅ **Done** (`ee25131`) —
   resolved to `@rspack/core` 2.2.1 / `react-server-dom-rspack` 0.1.0, re-verified, and guarded by
   `pnpm check:pins`. Every measurement below was taken against 2.1.7 / 0.0.3; the suite is green on the new
   pair, but any _specific_ line number or byte count in this document is worth re-checking as you reach it.
2. The rest of §1 — [1.2](#12--blocker-prerendered-pages-whose-params-need-percent-encoding-are-built-and-then-never-served)
   silently disables a headline feature for non-ASCII routes;
   [1.3](#13--blocker-httpmethod-advertises-head-which-can-never-match) and
   [1.4](#14--blocker-srcroutests-and-srcserverts-are-cast-not-validated) are type/validation gaps that get
   harder to close after the freeze.
3. The two `SECURITY.md`-boundary items in §2: the `process?.env` shadow gap
   ([2.1](#21--the-env-shadow-does-not-cover-processenv-processenv-or-an-aliased-process)) and the `/_static`
   middleware gap ([2.2](#22--srcserverts-middleware-never-runs-for-_static)). Then settle the CSRF wording
   ([2.3](#23--the-built-in-csrf-guard-leaves-a-same-site-cross-origin-form-post-to-csrf)).
4. §3, starting with [3.1](#31--port-binds-a-random-port-instead-of-the-default) — the only item that
   misbehaves silently in an otherwise normal deployment — then
   [3.2](#32--an-action-request-that-fails-before-its-payload-is-produced-makes-the-browser-throw-a-typeerror)
   and [3.3](#33--a-notfound-or-error-page-that-itself-throws-a-control-signal-produces-a-bodiless-unlogged-500).
   [3.4](#34--redirect-raised-after-the-ssr-shell-has-flushed-never-becomes-a-real-3xx) and
   [3.6](#36--any-method-other-than-getpost-on-a-page-route-is-a-404-not-a-405) are **decided** — 3.4 is
   abort + dev warning + docs, 3.6 is documentation only. Take 3.4(b), the `setImmediate` ordering, with its
   test rather than after it.
5. §6 alongside each fix rather than as a batch, plus the coverage gate (6.9) and the concurrency test (6.8).
6. §5 and §7 last, but **before the tag**: they are the parts that cannot change after 1.0.0 without a major.

---

## Appendix A — dismissed

Findings raised across the two reviews that did **not** survive verification. Recorded so they are not
re-raised.

- **"Percent-encoded dot segments (`%2e%2e`) can escape the prerender store."** False. Two independent upstream
  layers strip them before `src/server/prerendered.ts:43` is reached: the URL parser normalises `%2e%2e` as a
  double-dot segment when the `Request` is constructed (verified:
  `new URL('/__ssg/docs/%2e%2e/x', base).pathname === '/__ssg/x'`), and Hono's `getPath` then runs `decodeURI`
  on any path containing `%`. Verified end to end: `GET /docs/%2e%2e` → **404**, never reaching a `/docs/:slug`
  handler at all. `c.req.path` cannot carry `%2e`.
  → What _is_ left is a test that passes for the wrong reason and a guard whose correctness depends on an
  unpinned upstream behaviour — kept as [6.0](#tests-that-are-wrong-today), not as a vulnerability.

- **"A route `path` without a leading `/` silently never matches."** False. Verified: Hono registers `'docs'`
  and serves `GET /docs` with 200. No fix needed.

- **"`RouterProvider`'s memo never hits."** False. `RouterProvider` is a `'use client'` component whose `href` /
  `params` props are deserialized from the flight payload, so they are referentially stable across re-renders of
  the same payload. The `useMemo` at `src/runtime/navigation.tsx:67` busts only when the payload changes or when
  `router` changes (`pending` toggling) — both times the value genuinely changed. `pageProps` rebuilding
  `params` per request is irrelevant: that object is serialized, not shared.

- **"Add `Cross-Origin-Opener-Policy` to the baseline header set."** The justification was that an app "cannot
  retrofit it as easily", which is false — `secureHeaders()` sets COOP in one line, and the framework's stated
  position is that per-request security is Hono middleware. No defect, no recommendation.

- **"`pnpm lint` fails with 2 errors."** Stale. Verified clean at merge time. (The source review also carried a
  dangling cross-reference to a section "B" that did not exist in that document.)

- **"The `vercel` target trusts the `Host` header regardless of `trustProxy`."** Corrected rather than dropped.
  It does — but so does every other target: `@hono/node-server` builds the request URL from `Host` on all of
  them. Only the `X-Forwarded-Proto` half is vercel-specific, and [5.7](#5-api-surface--the-parts-that-freeze-at-100)
  says so.

## Appendix B — reconciliation notes

Where the two source reviews disagreed, and how it was settled:

| Disagreement                                                                                                 | Resolution                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint state (eval 1: 2 errors; eval 2: clean)                                                                 | **Clean.** Verified at merge time. Eval 1's baseline was `554fb76`; its line numbers throughout are stale and have been re-derived against the working tree.                                                                                                                                                                                                  |
| What triggers the client `TypeError` on an action (eval 1: a render error; eval 2: `loadPage`/`decodeReply`) | **Eval 2.** `renderComponent` returns the stream at `entry.rsc.tsx:256` before the render can throw, so the response is already committed. Merged as [3.2](#32--an-action-request-that-fails-before-its-payload-is-produced-makes-the-browser-throw-a-typeerror), keeping eval 1's separate 413 measurement as shape (a).                                     |
| `cross-site` with no `Origin` (eval 1: fail-open defect; eval 2: no browser shape reaches it)                | **Eval 2.** Per Fetch, a browser always appends `Origin` to a non-GET/HEAD request. Downgraded to hardening ([2.4](#24--hardening-refusescrosssiteform-allows-sec-fetch-site-cross-site-with-no-origin)); eval 1's substantive `same-site` subdomain point promoted to [2.3](#23--the-built-in-csrf-guard-leaves-a-same-site-cross-origin-form-post-to-csrf). |
| `HEAD` on a page route (eval 1: "fine, 200 empty body"; eval 2: wasted render, leaked listener)              | **Both true, not contradictory.** Eval 1 measured the status; eval 2 measured the cost. Merged as [3.5](#35--a-head-on-a-page-route-renders-the-page-and-throws-the-result-away).                                                                                                                                                                             |
| Whether a throwing error page is logged (eval 2: "unlogged")                                                 | **Partly.** The `error`-page path at `:509-513` _is_ guarded and logged; the control-signal re-entry at `:491` is not. Narrowed in [3.3](#33--a-notfound-or-error-page-that-itself-throws-a-control-signal-produces-a-bodiless-unlogged-500).                                                                                                                 |
| Flight trailer split across batches (eval 1: defect)                                                         | **Downgraded to defence-in-depth** ([4.2](#42--injectflightpayload-has-no-guard-for-a-document-trailer-straddling-two-batches)). The module documents the assumption at `:97-99` and it holds for React today — but this injector exists because a dependency made the same class of assumption and was wrong, so it still warrants a guard.                  |

**Duplicates collapsed:** action-response decoding (eval 1 A2 + eval 2 §3.2) → 3.2 · CSRF guard (C1 + §2.4) →
2.3 + 2.4 · plain-text 404 cache-control (C3 + §3.5) → 3.8 · 405 vs 404 (E2 + §3.6) → 3.6 · CLI port handling
(D5 + §3.1) → 3.1 · README `0.0.x` (D8 + §1 + §6.1) → 1.1 + 7.1 · error-funnel tests (F5 + §4.4) → 6.4 ·
CSRF-shape tests (F3 + §2.4) → 6.5 · browser suite (G2 + §4) → 8.3 + 6.15.
