# Follow-ups from fixing the pre-production review

Everything in [`PRODUCTION.md`](./PRODUCTION.md) is fixed and struck through — 11 commits, `541e062..b86a3f5`.
This is what fixing it turned up: things that were not in the review, or that the fixes themselves left
behind. Nothing here blocks 1.0.0.

**F1 has since been fixed too** and is struck through below. F2–F10 are open.

**Environment.** `@rshono/core@1.0.0-rc.19` · Rspack 2.2.2 · React 19.2.8 · Hono 4.13.5 · Node 22.22.2
**Baseline now.** `npm test` **322/322** pass (was 303 at the review, 320 when this document was written) ·
`typecheck` clean · `eslint packages/core` clean · coverage **85.30 / 92.25 / 80.24** against floors of
82 / 90 / 75 (was 83.44 / 91.39 / 78.42)
**Verified.** 2026-09-02, written at `b86a3f5`. Each item below was reproduced against a real build and a
running server, or is marked as reasoning rather than observation.

---

## Summary

| #          | Issue                                                                                    | Severity   | Origin                |
| ---------- | ---------------------------------------------------------------------------------------- | ---------- | --------------------- |
| ~~**F1**~~ | ~~A `[rshono]` failure from `dev` or `build` still prints a raw Node stack~~ — **fixed** | ~~Medium~~ | New — found via L2    |
| **F2**     | Under a global nonce CSP, prerendered documents are built and never served               | Low        | Residue of L4         |
| **F3**     | A deploy-drift `loadServerAction` failure is now a silent 400                            | Low        | Cost of M3            |
| **F4**     | `decodeFormState` sits outside M3's guard, so one 500 path survives                      | Low        | Cost of M3            |
| **F5**     | The two action `400`s carry no `cache-control` and no `Vary: RSC`                        | Low        | Pre-existing          |
| **F6**     | The client's "produced no result" branch is now close to unreachable                     | Nit        | Residue of M3         |
| **F7**     | The coverage number still cannot see the request hot path                                | Low        | L5 documented it only |
| **F8**     | The `NODE_ENV` substitution added by H1 is textual, not syntactic                        | Nit        | Cost of H1            |
| **F9**     | `prettier --check` fails on five files and nothing in CI runs it                         | Nit        | Pre-existing          |
| **F10**    | The shadow check compares regex constraints as text                                      | Nit        | Limit of L1           |

**Also worth knowing:** the Playwright suite could not be run in this environment — see
[Not verified here](#not-verified-here) at the end. Run it before tagging.

---

# ~~F1 — A `[rshono]` failure from `dev` or `build` still prints a raw Node stack~~ ✅ FIXED

**Severity: medium.** The likeliest first-run failure there is, and it got the output L2 was about.

### Issue

L2 wrapped `parseArgs`, so a typo'd flag is now a sentence. But the _other_ thing a new project gets wrong —
no `src/routes.ts` — still arrives as a Node `Error` object with framework frames, from both commands:

```
$ rshono dev                     # in a directory with no src/routes.ts
Error: [rshono] src/routes.ts not found in /tmp/emptyapp2 — it is the one required file.
    at createConfigs (…/packages/core/src/builder/rspack-config.ts:144:11)
    at Module.devCommand (…/packages/core/src/cli/dev.ts:126:40)

$ rshono build                   # the same, one frame deeper
  • building client + server bundles…
Error: [rshono] src/routes.ts not found in /tmp/emptyapp2 — it is the one required file.
    at createConfigs (…/packages/core/src/builder/rspack-config.ts:144:11)
    at Module.buildCommand (…/packages/core/src/cli/build.ts:58:19)
    at main (…/packages/core/src/cli/index.ts:111:43)
```

The message itself is good — it names the file and says it is the required one. Everything after it is noise,
and it is the first thing anyone scaffolding by hand will see.

### Cause

`build.ts` already has the right idea: `phase()` catches an error whose message starts with `[rshono]`, prints
`✗ <message>` and exits 1 — "a `[rshono]` message was written for whoever is running the build". But
`createConfigs` is called at `build.ts:58`, _outside_ any `phase()`, and `dev.ts:126` calls it with no
equivalent at all. Both escape to `main().catch`, which is `console.error(error)` — the same raw-object
handler L2 removed for `parseArgs`.

### Fix — done

`phase()` is gone and its rule now lives in `main().catch`, where it covers every command rather than three
stages of one. A message starting with `[rshono]` is a message for the user, so it is printed as the line it
is; anything else keeps its stack, because that stack is the report. `phase()` collapsed rather than stayed —
two implementations of one rule is how they drift.

Both commands now answer identically, exit 1:

```
$ rshono dev        # and `rshono build`, after its "building client + server bundles…" line

  ✗ [rshono] src/routes.ts not found in /tmp/f1 — it is the one required file.
```

And the other half of the rule holds — a config module throwing a plain `Error` still comes out with its
frames, `at loadConfig`, `at main` and all.

Removing `phase()` is the part that could have regressed silently, since the three stages it wrapped were
covered by tests that asserted only on the message. Those two tests now also assert no stack, so the move is
guarded from both ends: with the new handler reverted, the missing-`routes.ts` case and both build-stage cases
fail.

---

# F2 — Under a global nonce CSP, prerendered documents are built and never served

**Severity: low.** L4's other half — the one it could not fix from where it sat.

### Issue

L4 stopped the build-time nonce shipping. It did not, and could not, change the fact that under a **global**
nonce policy the prerendered _document_ is never read: `mustRenderForNonce` is true for every request, so each
one renders fresh. Confirmed against a `TESTBED_CSP=1` build and server — two successive requests to
`/docs/getting-started` return different nonces under `cache-control: private, no-cache`, while the file on
disk sits untouched.

So the build still reports

```
  • prerendered 3 static page(s): /docs/getting-started, /docs/deployment, /docs/café
```

for three documents the deployment will never serve. (Their `index.rsc` siblings _are_ served — a flight
payload carries no nonce — so this is half a page each, not a whole one.)

That the document cannot be prerendered under a nonce CSP is correct and unavoidable. Being told it was
prerendered is the part that is wrong.

### Fix

The prerender pass can tell: it renders through the app's own middleware, so `c.get('secureHeadersNonce')` is
set during the pass even though `cspNonce` now masks it. Have the pass notice a nonce on a path it is
prerendering and warn once — _"`/docs/*` mints a CSP nonce, so its prerendered documents will be re-rendered
per request; only the flight payloads will be served"_ — and count those pages honestly in the summary line.

---

# F3 — A deploy-drift `loadServerAction` failure is now a silent 400

**Severity: low.** A deliberate trade M3 made, worth writing down rather than rediscovering.

### Issue

M3 pulled `loadServerAction` inside the guard that answers 400, on the finding's recommendation and on the
strength of React's own message for it — _"This request might be from an older or newer deployment"_, which
frames it as a stale caller. For the reachable case that is right.

But the id has already passed `Object.hasOwn(serverManifest, …)` by then, so `resolveServerReference` cannot
be what throws. What is left is `__webpack_require__(actionModId)` failing — a chunk missing from
`dist/server/chunks/` after a partial deploy. That is a server fault, and it went from a reported 500 to a
silent 400 with nothing in the log.

Rare, and it needs a broken deployment to reach. But it is the one case in that guard that an operator would
want paged about, and it is now the one case they will not be.

### Fix

Either leave it (a broken deploy has louder symptoms) or split the guard: everything that reads or decodes the
_body_ answers 400, and `loadServerAction` keeps its own `catch` that reports and 500s. The `hasOwn` check
above it is what makes the split safe — a client cannot reach the second branch with an id of its choosing.

---

# F4 — `decodeFormState` sits outside M3's guard, so one 500 path survives

**Severity: low.** Deliberate, and probably right, but not currently written down anywhere.

### Issue

M3 guards `request.formData()` and `decodeAction` in the form branch. It stops there, and that is on purpose:
`decodeFormState` runs _after_ `decodedAction()` has already executed, so answering 400 at that point would
tell the caller their request was rejected when the action has already had its effects.

The consequence is that a body which `decodeAction` accepts but `decodeFormState` chokes on is still a 500 and
still reaches `reportServerError`. Not reproduced — `decodeFormState` returns early unless `$ACTION_KEY` is a
string, so it looks defensive — but the shape M3 closed is open here, and the reasoning for leaving it that way
lives only in this document.

### Fix

Confirm whether it is reachable at all with a crafted `$ACTION_KEY`. If it is, the honest answer is a 500 that
is _not_ reported as a request fault — the action ran, so the request was fine — or a comment at the call site
saying why the guard stops where it does.

---

# F5 — The two action `400`s carry no `cache-control` and no `Vary: RSC`

**Severity: low.** Consistency, not correctness.

### Issue

The framework's header floor gives page content types `Vary: RSC` and `private, no-cache`, and the plain 404
sets both explicitly. The refusals around the action path do not agree with each other:

```
POST /login (undecodable body)     → 400  content-type: text/plain    (no cache-control, no vary)
POST /login (cross-site form)      → 403  vary: RSC                   (no cache-control)
GET  /nope-nothing-here            → 404  cache-control: private, no-cache   vary: RSC
```

Both 400s — `unknown server action` and the `malformed server action request` M3 added beside it — pass
through `c.text(…, 400)` with no header bag, and the floor only decorates page content types.

This is **not** a caching bug: RFC 9111 lists the statuses a shared cache may store heuristically, and 400 is
not among them, so nothing will store these without being told to. It is that three sibling refusals on one
route make three different choices, and the next one added will have to guess which.

### Fix

Give the action refusals the same bag the 404 has — `vary: RSC` and `PAGE_CACHE_CONTROL` — or say in the header
floor why a 4xx that is not a 404 needs neither.

---

# F6 — The client's "produced no result" branch is now close to unreachable

**Severity: nit.**

### Issue

`entry.client.tsx` throws _"the server action produced no result"_ when an action reply carries no
`returnValue`. Before M3 that branch had a real cause — an undecodable body produced a 500 error-page payload —
and its comment said so.

After M3 there is no route to it that this codebase produces: an unknown id and an undecodable body are both
refused with a `text/plain` 400 before any render, which `payloadResponse` turns into its own error first; an
action that ran has its result carried across by `actionResults`; and `redirect()` / `notFound()` are handled
two lines above. The comment is corrected and the branch is kept as a defensive floor for a payload shaped by
another deployment or replaced by a proxy.

### Fix

Nothing, unless you would rather it were gone. Recorded so the next reader does not spend the time working out
what reaches it, and so nobody deletes it as dead code without noticing it is load-bearing against a
_mismatched_ server rather than this one.

---

# F7 — The coverage number still cannot see the request hot path

**Severity: low.** L5 documented the gap; the gap is still there.

### Issue

`test:coverage` reports 85.30 / 92.25 / 80.24, and `entry.rsc.js`, `entry.client.js`, `entry.ssr.js`,
`boundaries.js`, `navigation.js` and every `deploy/*/runtime.js` appear nowhere in it — they only ever execute
inside the bundled testbed, in a child process. `runtime/` in the report means `context`, `control`,
`flight-inject`, `hot-update`, `request` and `validate-entries` and nothing else.

L5's fix was to say so where a contributor reads it (the README's Testing section; `ci.yml` already said it in
a comment on the coverage job). Saying so is the honest minimum, but the number still describes the build
tooling while looking like it describes the framework.

### Fix

`NODE_V8_COVERAGE` on the child processes `startTestbed` spawns, merged into the parent's report. The e2e
suites already drive nearly all of the hot path over HTTP, so this is a measurement change rather than new
tests — and it would let the floors mean what they appear to.

---

# F8 — The `NODE_ENV` substitution added by H1 is textual, not syntactic

**Severity: nit.** Called out in the code, repeated here so it is on a list.

### Issue

H1 has `env-shadow-loader.cjs` replace `process.env.NODE_ENV` with a string literal before the prelude shadows
the binding. The regex is anchored — a negative lookbehind rejects `this.process.env.NODE_ENV` and `myprocess`,
and `\b` rejects `NODE_ENVIRONMENT` — but it is still a text substitution, so a `process.env.NODE_ENV` inside a
string literal or a template in an SSR-layer module would be rewritten too.

The same class of risk DefinePlugin carries for every other module in the bundle, which is why it was
acceptable. It is not the same _size_ of risk, because this one is hand-rolled.

### Fix

If it ever matters, do the substitution in the swc rule beside it as a real visitor rather than a regex. Until
then the unit tests cover the shapes that are substituted and the four that are declined.

---

# F9 — `prettier --check` fails on five files and nothing in CI runs it

**Severity: nit.** Pre-existing; verified against `14d385d`, before any of this work.

### Issue

```
$ npx prettier --check .        # at 14d385d, the review's own baseline
[warn] apps/website/content/benchmarks.md
[warn] packages/benchmarks/apps/next/next-env.d.ts
[warn] packages/core/src/runtime/entry.client.tsx
[warn] packages/core/test/cloudflare.test.mjs
[warn] PRODUCTION.md
```

`package.json` has `format` (`prettier --write .`) but no `format:check`, and `ci.yml` runs `lint` and the test
matrix and never Prettier. So the formatter is advisory, and the tree has drifted from it.

The files this work touched were run through Prettier and the tree is back to exactly those five.

### Fix

Add `format:check` and a CI step, then fix the five — or drop Prettier from the repo's story, since a formatter
nothing enforces is a formatter that will keep being out of date.

---

# F10 — The shadow check compares regex constraints as text

**Severity: nit.** A deliberate limit of L1, recorded so it is not mistaken for an oversight.

### Issue

L1 normalises a parameter's name away, treats a non-trailing `*` as one segment, expands an optional parameter
into both the forms it answers, and gives a trailing `*` its subtree — each verified against Hono 4.13.5
directly. What it does not do is compare two `{regex}` constraints for equivalence:

```
/a/:id{[0-9]+}  then  /a/:n{[0-9]+}   → REFUSED   (identical text, correctly caught)
/a/:id{[0-9]+}  then  /a/:id{\d+}     → ACCEPTED  (equivalent, second route is dead)
```

Deciding regex equivalence in general is not something a route validator should attempt, and the failure mode
is the safe one: a dead route that slips through, never a live route wrongly refused. The same applies to a
constraint containing `/`, which the key round-trips unchanged rather than trying to interpret.

### Fix

None proposed. Worth a line in `assertNothingIsShadowed`'s doc comment so the next person to widen it knows
where the line was drawn and why.

---

# Not verified here

**The Playwright suite did not run.** `pnpm --filter @rshono/core test:browser` cannot execute in this
environment: Chromium segfaults on launch, every failure being

```
Error: browserType.launch: Target page, context or browser has been closed
  - [pid=…] <process did exit: exitCode=null, signal=SIGSEGV>
```

That is the sandbox, not the code — no test body ever ran. Two of the fixes change response shapes the client
runtime consumes, so **run it before tagging**:

- **M3** makes an undecodable action body a `text/plain` 400 where it used to be a 500 flight payload. The
  client handles this through `payloadResponse`, which gates on the content type precisely so a non-payload
  reply becomes a readable error — and `client-runtime.spec.mjs:197` already covers exactly that shape with a 413. The reasoning is sound and the covering test is unchanged, but it has not been _observed_ to pass.
- **M2** only changes the text of a 403 that no client-side code parses.

Everything else in this work is server-side, build-side or documentation, and is covered by the 320 tests that
did run.
