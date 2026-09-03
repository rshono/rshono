# Follow-ups from fixing the pre-production review

> **Superseded as a working list by [`bugs.jsonl`](./bugs.jsonl).** All ten findings here are fixed. This document stays as the
> write-up — the reproductions and the reasoning are the part worth keeping — but the status of any finding,
> and the commit that fixed it, is in `bugs.jsonl`. One JSON object per line: `id`, `severity`, `status`,
> `kind`, `title`, `files`, `fix`, `commit`, `notes`. `notes` is the regression risk, which is what
> stops a fix being reintroduced as a bug.

Everything in [`PRODUCTION.md`](./PRODUCTION.md) is fixed and struck through — 11 commits, `541e062..b86a3f5`.
This is what fixing it turned up: things that were not in the review, or that the fixes themselves left
behind. Nothing here blocks 1.0.0.

**F1–F10 are now fixed too** and are struck through below — nothing here is open. Two of them turned out to
be more than the finding said: **F4** was an unauthenticated 500 of exactly the shape M3 closed, one step
further down the same path, and **F6** stopped being true while it was open, because F3 gave its branch a
reachable cause again. What fixing this lot turned up in turn is in
[`PRODUCTION-FOLLOWUP-FOLLOWUPS.md`](./PRODUCTION-FOLLOWUP-FOLLOWUPS.md).

**Environment.** `@rshono/core@1.0.0-rc.19` · Rspack 2.2.2 · React 19.2.8 · Hono 4.13.5 · Node 22.22.2
**Baseline now.** `npm test` **330/330** pass (303 at the review, 320 when this document was written, 322
when F1 landed) · `typecheck` clean · `eslint .` clean · `prettier --check .` clean, and enforced in CI
(F9) · coverage **84.95 / 92.13 / 79.28** against floors of 82 / 90 / 75 — down a fraction from 85.30 /
92.25 / 80.24 because the new code in `build.ts` and `ssg.ts` only runs in a child process, which is F7 in
one line.
**Verified.** 2026-09-02, written at `b86a3f5`, F1–F10 fixed in `49e1c9b..`. Each item below was reproduced
against a real build and a running server, or is marked as reasoning rather than observation. Every fix was
re-checked the same way afterwards, and the ten findings of the review above with it.

---

## Summary

| #           | Issue                                                                                      | Severity   | Origin                |
| ----------- | ------------------------------------------------------------------------------------------ | ---------- | --------------------- |
| ~~**F1**~~  | ~~A `[rshono]` failure from `dev` or `build` still prints a raw Node stack~~ — **fixed**   | ~~Medium~~ | New — found via L2    |
| ~~**F2**~~  | ~~Under a global nonce CSP, prerendered documents are built and never served~~ — **fixed** | ~~Low~~    | Residue of L4         |
| ~~**F3**~~  | ~~A deploy-drift `loadServerAction` failure is now a silent 400~~ — **fixed**              | ~~Low~~    | Cost of M3            |
| ~~**F4**~~  | ~~`decodeFormState` sits outside M3's guard, so one 500 path survives~~ — **fixed**        | ~~Low~~    | Cost of M3            |
| ~~**F5**~~  | ~~The two action `400`s carry no `cache-control` and no `Vary: RSC`~~ — **fixed**          | ~~Low~~    | Pre-existing          |
| ~~**F6**~~  | ~~The client's "produced no result" branch is now close to unreachable~~ — **superseded**  | ~~Nit~~    | Residue of M3         |
| ~~**F7**~~  | ~~The coverage number still cannot see the request hot path~~ — **measured**               | ~~Low~~    | L5 documented it only |
| ~~**F8**~~  | ~~The `NODE_ENV` substitution added by H1 is textual, not syntactic~~ — **fixed**          | ~~Nit~~    | Cost of H1            |
| ~~**F9**~~  | ~~`prettier --check` fails on five files and nothing in CI runs it~~ — **fixed**           | ~~Nit~~    | Pre-existing          |
| ~~**F10**~~ | ~~The shadow check compares regex constraints as text~~ — **documented**                   | ~~Nit~~    | Limit of L1           |

**Also worth knowing:** the Playwright suite could not be run in this environment. It has since been run
elsewhere and passed — see [Not verified here](#not-verified-here) at the end, which now records that.

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

# ~~F2 — Under a global nonce CSP, prerendered documents are built and never served~~ ✅ FIXED

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

### Fix — done

The pass can tell, but not from where it sits: it runs `bundle.app.fetch`, and the middleware that mints the
nonce lives inside the server bundle, which inlines its own copy of the module graph — so nothing
`prerenderStaticRoutes` can import reaches it. So the fact travels the one channel a render already has: a
response header, `x-rshono-prerender-nonce`, set by `entry.rsc.tsx` on a **document** it rendered while
`c.get('secureHeadersNonce')` was set. Read unmasked there on purpose: `cspNonce` hides the value so none is
stamped into a file, and _whether one exists_ is exactly what decides that file's fate. The header is set only
while `RSHONO_PRERENDER` is in the environment, so it never reaches a deployed response, and never reaches
disk either, since the pass stores the body alone.

The build now says it, once, and marks the pages it applies to:

```
  ⚠ 3 page(s) mint a CSP nonce, so the framework re-renders their document per request:
    only the flight payload is served from disk. The documents are written anyway, in case the policy is
    off where this is deployed. Marked "flight only" in the summary below.
  • prerendered 3 static page(s): /docs/getting-started (flight only), /docs/deployment (flight only), /docs/caf%C3%A9 (flight only)
```

The documents are still written, deliberately: whether a nonce is minted is a request-time decision, and an
app is free to switch its policy on from the environment — the testbed does exactly that — so a build that saw
one is not proof the deployment has one. Dropping the file would cost a page its prerender on the strength of
a guess; keeping it costs bytes that are free the moment the policy is off.

Covered from both ends: a unit test drives `prerenderStaticRoutes` with a fetch that sets the header on one
path of two, and `prod-config.test.mjs` asserts the label on the output of a **real** `TESTBED_CSP=1` build —
the whole path, from `secureHeaders()` in the app's middleware to the line a person reads — plus that a served
response never carries the marker. A build with no nonce policy prints exactly what it printed before.

---

# ~~F3 — A deploy-drift `loadServerAction` failure is now a silent 400~~ ✅ FIXED

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

### Fix — done

The guard is split. Everything that reads or decodes the _body_ still answers 400; `loadServerAction` now has
a `catch` of its own that reports the error as `source: 'action'` — the request was fine, the deployment is
not — and re-throws, so the app's `error` page answers 500. `reportServerError` de-duplicates, so `onError`
reporting it again as `source: 'request'` is a no-op. The `hasOwn` check above is what makes the split safe: a
client cannot reach the second branch with an id of its choosing.

Reading `loadServerAction` in `react-server-dom-rspack@0.1.0` makes the case stronger than the finding did.
It is three lines, and none of them can fail because of the caller: a falsy `.id` on a manifest entry
(React's _"older or newer deployment"_ message, which is about the **manifest**, not the request),
`__webpack_require__` on a module the bundle does not hold, and an export that is not a function. All three
are the deployment being incomplete.

**Tested, which took some doing.** The obvious fixture — a `'use server'` module that throws as it evaluates,
the action-side twin of the testbed's `/unloadable` page — turns out to break _every_ action in the app:
Rspack concatenates all of an app's `'use server'` modules into a single server module, so all of their ids
resolve to one `__webpack_require__` and one evaluation. That is worth knowing on its own and is recorded in
[`PRODUCTION-FOLLOWUP-FOLLOWUPS.md`](./PRODUCTION-FOLLOWUP-FOLLOWUPS.md). So the test breaks a **copy** of the
build instead, the way a partial deploy does: one action's manifest entry is pointed at a module id the bundle
does not hold, and the patched bundle is imported and driven through `app.fetch`. It answers 500 with the
error page, `[rshono] server action could not be loaded:` in the log and one `[error-reporter] action …` line.
With the split reverted it answers 400 and says nothing, so the test fails — checked in both directions.

---

# ~~F4 — `decodeFormState` sits outside M3's guard, so one 500 path survives~~ ✅ FIXED

**Severity: low** as written — **the reproduction raised it**: it is the M3 shape again, reachable unauthenticated.

### Issue

M3 guards `request.formData()` and `decodeAction` in the form branch. It stops there, and that is on purpose:
`decodeFormState` runs _after_ `decodedAction()` has already executed, so answering 400 at that point would
tell the caller their request was rejected when the action has already had its effects.

The consequence is that a body which `decodeAction` accepts but `decodeFormState` chokes on is still a 500 and
still reaches `reportServerError`. Not reproduced — `decodeFormState` returns early unless `$ACTION_KEY` is a
string, so it looks defensive — but the shape M3 closed is open here, and the reasoning for leaving it that way
lives only in this document.

### Fix — done

**It is reachable, and it was worse than "one 500 path survives" suggested.** Reproduced against a running
server, unauthenticated, with a body React never writes:

```
$ curl -X POST -H "Origin: $BASE" -F '$ACTION_REF_1=' -F '$ACTION_KEY=k' \
       -F "\$ACTION_ID_$ID=" -F 'email=crafted@example.com' $BASE/subscribe
Internal Server Error                                        (500)
set-cookie: subscribed=crafted%40example.com; Path=/; HttpOnly    # the action ran first
[error-reporter] request /subscribe #…: Connection closed.
```

The trick is that the two decoders disagree about which field names the call: `decodeAction` takes the **last**
`$ACTION_` key it sees, so a `$ACTION_ID_<public id>` placed after a `$ACTION_REF_1` wins there and the action
runs; `decodeFormState` only ever looks for a `$ACTION_REF_`, finds that one, and throws decoding
`$ACTION_1:0` metadata nobody wrote. So it is the M3 shape again — an unauthenticated 500, and an
`[error-reporter]` line per request — just moved past the point where the action has already had its effects.

Which is also why it cannot be a 400: the answer is now the page, whatever this body was. The decode is
wrapped, `formState` stays `undefined` — precisely what a form _without_ `useActionState` gets — and the page
renders 200 with the action's effects intact. Silent in production for the same reason `malformedAction` is
(action ids are public, so reporting is a paging vector), with a `console.warn` in dev, where the plausible
cause is a React or bundler version whose form fields this does not understand.

Proving it took a fixture: all three of the testbed's forms are the `useActionState` shape, and the
divergence needs the _other_ one. So `/subscribe` is a form a **server component** wires straight to an action
— React posts it as a bare `$ACTION_ID_` — which also closes a real coverage gap: nothing exercised that shape
before, though `actionFormData` in the test helpers had always handled it. Two tests: the ordinary no-JS post
through that form, and the crafted body, which is a 200 with the cookie set and nothing reported. With the
guard reverted the second fails as the 500 it used to be.

---

# ~~F5 — The two action `400`s carry no `cache-control` and no `Vary: RSC`~~ ✅ FIXED

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

### Fix — done

They all go through one function now, `plainRefusal(c, message, status)`: the two 404s, both action 400s, the
cross-site 403 and the last-resort 500 — every plain-text answer the framework gives on a page route. It sets
`vary: RSC` and `private, no-cache`, and its doc comment says which of those is correctness and which is
consistency: the plain 404 answers a GET and is heuristically cacheable, so it is the one that needs the cache
policy; the rest answer a POST, which no cache stores, and saying it anyway costs a header and settles the
question. The floor above never sees any of them, because it only decorates page _content types_.

Asserted as a set rather than one at a time — the point is that they agree — beside the existing plain-404
test. The cross-site 403 is asserted in `prod-config.test.mjs`, since it is only the framework's own refusal
with `csrf()` off; with Hono's `csrf()` on, the 403 that comes back is Hono's and carries neither header,
which is its business and not this rule's.

---

# ~~F6 — The client's "produced no result" branch is now close to unreachable~~ ✅ SUPERSEDED BY F3

**Severity: nit** — and no longer true: F3 gave the branch a reachable cause again.

### Issue

`entry.client.tsx` throws _"the server action produced no result"_ when an action reply carries no
`returnValue`. Before M3 that branch had a real cause — an undecodable body produced a 500 error-page payload —
and its comment said so.

After M3 there is no route to it that this codebase produces: an unknown id and an undecodable body are both
refused with a `text/plain` 400 before any render, which `payloadResponse` turns into its own error first; an
action that ran has its result carried across by `actionResults`; and `redirect()` / `notFound()` are handled
two lines above. The comment is corrected and the branch is kept as a defensive floor for a payload shaped by
another deployment or replaced by a proxy.

### Fix — done

**F3 changed the answer while this was still open.** A `loadServerAction` failure is a 500 again, and a
client-initiated action is answered with the `error` page — a flight payload, so it reaches
`createFromFetch` rather than `payloadResponse`, and it carries no `returnValue`, because nothing ran. That
is exactly this branch. So it is not a defensive floor against a mismatched server any more: it is what a
caller sees when a partial deploy has taken the action's module with it, and the message it throws — the
failure is the server's and its log has the error — is right for that case.

The comment says so now, in place of the "no route to it that this codebase produces" it had. Both halves are
covered: the server half in `prod.test.mjs`, which asserts the drift reply is a payload carrying
`"returnValue":"$undefined"` — the branch's precondition — and the client half by a new Playwright test that
answers an action POST with an ordinary page payload and expects the notice to say the result is missing.

**That Playwright test could not be run here** — Chromium segfaults in this sandbox — so it was written
against the 413 test two above it and checked only as far as `playwright test --list` would go. **It has
since been run elsewhere and passes**, along with the rest of the suite; see
[Not verified here](#not-verified-here).

---

# ~~F7 — The coverage number still cannot see the request hot path~~ ✅ MEASURED

**Severity: low.** L5 documented the gap; it is now measurable on demand, and measured.

### Issue

`test:coverage` reports 85.30 / 92.25 / 80.24, and `entry.rsc.js`, `entry.client.js`, `entry.ssr.js`,
`boundaries.js`, `navigation.js` and every `deploy/*/runtime.js` appear nowhere in it — they only ever execute
inside the bundled testbed, in a child process. `runtime/` in the report means `context`, `control`,
`flight-inject`, `hot-update`, `request` and `validate-entries` and nothing else.

L5's fix was to say so where a contributor reads it (the README's Testing section; `ci.yml` already said it in
a comment on the coverage job). Saying so is the honest minimum, but the number still describes the build
tooling while looking like it describes the framework.

### Fix — done, though not the one proposed

`NODE_V8_COVERAGE` on the children works, and better than expected: every process the suite spawns writes its
own coverage, the testbed's bundle included, and that bundle's source map reaches all the way back to
`packages/core/src/**.ts` — through rspack's map, through `dist`'s own `.js.map`, to the TypeScript. Remapped
with `c8 report`, the production e2e suite alone comes out at:

| file                     | statements | branches | functions |
| ------------------------ | ---------- | -------- | --------- |
| `entry.rsc.tsx`          | 97.4%      | 92.3%    | 90.9%     |
| `entry.ssr.tsx`          | 100%       | 100%     | 100%      |
| `navigation.tsx`         | 100%       | 100%     | 100%      |
| `deploy/node/runtime.ts` | 100%       | 100%     | 100%      |
| `boundaries.tsx`         | 88.0%      | 66.7%    | 28.6%     |

(`boundaries.tsx`'s remainder is its client half, which belongs to the browser suite.) **So the question
underneath F7 has an answer: the code the gate cannot see is not the code that is thin.**

What it is _not_ is a gate, and that is deliberate. Merging those numbers into the existing floor needs every
bundle's sources to resolve to one path, and a full run builds the testbed four times over — production, dev,
cloudflare, vercel — so the same source appears once per bundle, each with a partial number, plus once more
from the in-process load. Making them one file means normalising the bundle's source paths
(`output.devtoolModuleFilenameTemplate`), which changes the maps that ship to users, and it means a
coverage tool in the dependency tree of a package that pins every dependency on purpose. Both are decisions
for the maintainer, not a follow-up fix; a gate assembled without them would move for reasons that have
nothing to do with the tests.

So the recipe is written down instead — in the README's Testing section, beside L5's note, with the flags
that work and the caveat that it is one suite at a time — and `ci.yml` now says _why_ the floors are loose
rather than only that they are: they cannot see the hot path, so tightening them would ratchet the build
tooling alone.

---

# ~~F8 — The `NODE_ENV` substitution added by H1 is textual, not syntactic~~ ✅ FIXED

**Severity: nit** — and the comparison it rested on was wrong, which is what made it worth doing.

### Issue

H1 has `env-shadow-loader.cjs` replace `process.env.NODE_ENV` with a string literal before the prelude shadows
the binding. The regex is anchored — a negative lookbehind rejects `this.process.env.NODE_ENV` and `myprocess`,
and `\b` rejects `NODE_ENVIRONMENT` — but it is still a text substitution, so a `process.env.NODE_ENV` inside a
string literal or a template in an SSR-layer module would be rewritten too.

The loader's own comment called that "the same class of risk DefinePlugin's own substitution carries for every
other module in the bundle". **That is not true**: DefinePlugin works on the parsed module — it replaces
expressions through the parser's hooks — so it cannot rewrite the inside of a string at all. The risk was
this loader's alone.

### Fix — done

Not an swc visitor: a scanner. The substitution regex now matches the places the same text can sit _without_
being code — a line comment, a block comment, a string, a template — ahead of the target itself, and the
replacer hands everything that is not the target straight back:

```js
source.replace(NODE_ENV_SCAN, (match) => (match.startsWith('process') ? literal : match));
```

Comments are matched ahead of strings on purpose: an apostrophe in one (`// don't`) would otherwise open a
string that swallows the code after it, which is the trap this kind of scan falls into.

It is a scanner and not a parser, so two things stay outside it: a regex literal spelled with unescaped dots
(`/process.env.NODE_ENV/`), and an interpolation inside a template, which is consumed with the template
around it. The first is the residual risk and a strange thing to write; the second only declines a
substitution that would have been valid, costing bytes and changing nothing. **Any position the scan gets
wrong leaves the text exactly as the bare `.replace()` did**, so it cannot be worse than what it replaced.

Seven cases in the unit tests, beside the shapes that were already covered. H1's win is unchanged: the
testbed's server bundle is still ~400 KB with **no** development React in it — the map has zero
`*.development.js` sources — because React's entry wrappers branch in code, not in a string.

---

# ~~F9 — `prettier --check` fails on five files and nothing in CI runs it~~ ✅ FIXED

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

### Fix — done

`format:check` (`prettier --check .`) is a root script and a step in the `lint` job, beside `pnpm lint`. The
workflow's path filter gains `.prettierrc.json` and `.prettierignore`, on the same reasoning `eslint.config.mjs`
is already there: one config governs every package, so a change to it is a change to all of them.

The five split three and two:

- **Formatted** — `packages/core/src/runtime/entry.client.tsx`, `packages/core/test/cloudflare.test.mjs` and
  `PRODUCTION.md`. All three are hand-written and the changes are cosmetic: one long `throw` wrapped, one call
  broken over its arguments, and markdown emphasis and table padding normalised.
- **Ignored** — `packages/benchmarks/apps/next/next-env.d.ts` and `apps/website/content/benchmarks.md`. Neither
  is written by a person: Next.js rewrites the first on every build, and `site:publish` copies the second out
  of `results/latest.md`, which `.prettierignore` already excludes one directory earlier. Formatting them
  would last until the next generator run, and a formatter and a generator arguing over the same bytes is how
  a check like this starts being ignored.

`prettier --check .` is now clean over the whole tree, and `npm test` still passes 329/329. One limit worth
naming: the check runs the whole tree, but this workflow only _starts_ for the paths at the top of the file,
so a change confined to the website is still formatted by whoever runs `pnpm format` rather than by CI. That
is the path filter's existing trade, not a new one — the comment in `ci.yml` now says so.

---

# ~~F10 — The shadow check compares regex constraints as text~~ ✅ DOCUMENTED

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

### Fix — done

Both cases re-confirmed against the built validator, along with the slash-in-a-constraint one:

```
/a/:id{[0-9]+}  then  /a/:n{[0-9]+}   → REFUSED    identical text, caught
/a/:id{[0-9]+}  then  /a/:id{\d+}     → ACCEPTED   equivalent, and the second route is dead
/a/:id{[0-9]+}  then  /a/:name        → ACCEPTED   genuinely two routes, both answer
/a/:id{a/b}     then  /a/:n{a/b}      → REFUSED    a constraint holding a slash still hashes alike
```

`assertNothingIsShadowed`'s doc comment now says where the line is and, more usefully, **which way it must
lean**: an unreachable route slipping through is the acceptable failure, a live route wrongly refused is not,
because that fails a build that was correct. Anything added here has to keep that asymmetry.

A test records it too — the two refusals and the accepted equivalence in one case — so the behaviour is
pinned rather than left to be rediscovered as a bug.

---

# Not verified here — since verified

> **Settled.** The maintainer ran `pnpm --filter @rshono/core test:browser` outside this environment and
> **every test passed**, including the one F6 added blind. Everything below is what was outstanding before
> that run; it is kept because the sandbox limitation is still real for the next round of work.

**The Playwright suite did not run here.** `pnpm --filter @rshono/core test:browser` cannot execute in this
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
- **F6** adds a Playwright test of its own — an action POST answered with an ordinary page payload, expecting
  the "produced no result" notice. Written against the 413 test two above it, and `playwright test --list`
  parses it (28 tests in the file), but its body has not run either. It is the only _new_ browser test in
  this work, so it is the one to look at first if the suite is red.
- **F4** changes a crafted form post from a 500 to a 200 that renders the page. No client-side code is
  involved — that shape only arrives from a non-browser client — and the browser suite drives the
  `useActionState` forms, which are unaffected.

Everything else in this work is server-side, build-side or documentation, and is covered by the 328 tests that
did run.
