# Follow-ups from fixing the follow-ups

What fixing [`PRODUCTION-FOLLOWUPS.md`](./PRODUCTION-FOLLOWUPS.md) turned up: things that were not in either
review, or that those fixes themselves left behind. Nothing here blocks 1.0.0, and nothing here is a
regression of anything struck through in the other two documents.

**Environment.** `@rshono/core@1.0.0-rc.19` · Rspack 2.2.2 · React 19.2.8 · Hono 4.13.5 · Node 22.22.2
**Baseline.** `npm test` **330/330** · `typecheck` clean · `eslint .` clean · `prettier --check .` clean ·
coverage 84.95 / 92.13 / 79.28 against floors of 82 / 90 / 75
**Verified.** 2026-09-02, after F1–F10. Each item was reproduced against a real build, or is marked as
reading rather than observation.

---

## Summary

| #          | Issue                                                                                            | Severity | Origin                   |
| ---------- | ------------------------------------------------------------------------------------------------ | -------- | ------------------------ |
| ~~**G1**~~ | ~~One unloadable `'use server'` module disables **every** server action in the app~~ — **fixed** | ~~Low~~  | Found while fixing F3    |
| **G2**     | H1's justification for a textual substitution was wrong about DefinePlugin                       | Nit      | Cost of H1, found via F8 |
| **G3**     | The browser suite has never run in this environment, and now has a new test in it                | Low      | Environment              |

---

# ~~G1 — One unloadable `'use server'` module disables every server action in the app~~ ✅ FIXED

**Severity: low.** The bundling is upstream and stays as it is. What the framework could do about it — find it
at build time instead of on the first click — it now does.

### Issue

Rspack concatenates every `'use server'` module in an app into **one** server module. In the testbed's
production bundle all five of `src/actions.ts`'s ids resolve to the same module id, and adding a second
action file put its id in the same one:

```
3860(e,t,r){r.r(t),r.d(t,{"0004c477…":()=>f,"0019c78d…":()=>u,"4096cb98…":()=>i,…})
```

`loadServerAction` is `__webpack_require__(serverManifest[id].id)[id]`, so **every** action in the app is
behind a single module evaluation. A `'use server'` module that throws as it evaluates — the action-side twin
of the testbed's `/unloadable` page, and what a chunk missing after a partial deploy looks like from the
runtime's side — therefore takes every other action down with it, including actions in files that are
perfectly fine.

Found while building a fixture for F3: a deliberately broken action module made `/dashboard`'s logout action
fail too, with the _other_ module's error.

### Consequence

Nothing to fix in rshono — this is how the bundler emits the layer, and one module for the whole `'use server'`
graph is also what makes an action call one lookup. What it changes is the shape of the failure:

- A partial deploy does not lose _an_ action, it loses _all_ of them. That makes F3's split — a reported 500
  rather than a silent 400 — worth more than the "rare, needs a broken deployment" framing suggested.
- A test for a single broken action cannot be written as a fixture. `prod.test.mjs` breaks a copy of the
  build's server manifest instead, which is the one way to reach a single id.

### Fix — done

"Nothing to fix in rshono" was too quick. The bundling is upstream, but the reason this reached production at
all is that **a build never touched these modules**: nothing on the server imports one until an action is
called, since a `'use client'` component that calls one gets a `createServerReference` stub. Every other
module an app owns is loaded by `assertRouteModules` during the build. This was the hole.

So the build loads them too. `checkRouteModules` — now `checkAppModules`, since it is no longer only routes —
follows the route pass with the app's server actions, one `loadServerAction` per _module_ rather than per id:
that is the granularity of the failure, and evaluating a module that throws once per action would repeat
whatever it did before throwing. The remaining ids in a module that loaded are then cache hits, so they are
checked too — `loadServerAction` also refuses an export that is not a function.

```
  ⚠ the module holding 1 of the app's 1 server action(s) could not be loaded at build time — this module cannot be evaluated
    Calling one of those actions loads that module first, so if it fails the same way at run time, each of them answers 500.
```

A **warning**, and the build still exits 0, for the same reason `assertRouteModules` warns about a page
module: a module can legitimately decline to evaluate in a build — one that reads a secret out of the
environment, say — and a build is not where that gets decided. Entries declaring `chunks` are skipped, since
`loadServerAction` is a bare `__webpack_require__` and a module in an unloaded chunk would fail here for a
reason that says nothing about the app.

Both sides are tested: `minimal-app.test.mjs` builds a throwaway app whose action module throws and asserts
the warning and the exit code, and `prod.test.mjs` asserts the testbed's build — six actions that all load —
says nothing at all. A check that cannot be quiet is one every app learns to ignore.

The README's server-actions section now states the shape as well: one module for the whole graph, so a module
that will not evaluate takes every action with it.

---

# ~~G2 — H1's justification for a textual substitution was wrong about DefinePlugin~~ ✅ CORRECTED

**Severity: nit.** A wrong sentence that made a real risk look already-taken.

### Issue

H1 added a regex substitution of `process.env.NODE_ENV` to `env-shadow-loader.cjs`, and justified its being
textual like this, in the code and again in F8:

> Textual, like the prelude insertion it sits beside: a `process.env.NODE_ENV` inside a string literal is
> rewritten too, **which is the same class of risk DefinePlugin's own substitution carries for every other
> module in the bundle.**

DefinePlugin does not carry that risk. It replaces expressions through the parser's hooks — it works on the
parsed module, so it cannot reach inside a string literal at all. The risk was this loader's alone, and the
sentence said the opposite of what a reader needed to know.

Nothing shipped wrong because of it: the shapes React's entry wrappers use are all code. But "someone else
already takes this risk" is exactly the kind of reasoning that stops a fix from being written, and here it
did — F8 was filed as a nit on that basis.

### Fix — done

F8 replaced the substitution with a scan that skips comments, strings and templates, and both comments now
say what DefinePlugin actually does. What was left was the claim itself, still standing in `PRODUCTION.md`'s
H1 section — so it is **struck through there and answered with a correction**, which is what that document
already does with the four other supporting details it got wrong. Its header now says five.

**Measured rather than asserted**, since the whole point of this item is a claim that was believed and never
checked. A throwaway app with a `'use client'` component holding both shapes:

```tsx
const LITERAL = 'set process.env.NODE_ENV before starting';
const READ = process.env.NODE_ENV;
```

built for production, gives in **both** bundles:

```
"data-literal":"set process.env.NODE_ENV before starting","data-read":"production"
```

The client chunk is DefinePlugin's work alone and the string survives it, which is the claim. The server
bundle is the SSR layer, where the env-shadow loader substitutes, and the string survives there too — so F8's
scan holds in a real build and not only in its unit tests, while the read it exists for is still inlined.

---

# G3 — The browser suite has never run in this environment, and now has a new test in it

**Severity: low.** Not a defect — a gap in what could be verified, carried forward from the previous round.

### Issue

`pnpm --filter @rshono/core test:browser` still cannot execute here: Chromium segfaults on launch
(`<process did exit: exitCode=null, signal=SIGSEGV>`), before any test body runs. That was already recorded
under [Not verified here](./PRODUCTION-FOLLOWUPS.md#not-verified-here), and it has not changed.

What has changed is that F6 **added** a test to that suite — an action POST answered with an ordinary page
payload, expecting the client's "produced no result" notice. It is modelled on the 413 test two above it,
uses the same `page.route` / `route.fulfill` shape, and `playwright test --list` parses the file (28 tests).
Its body has not been observed to run.

### Fix

Run `pnpm --filter @rshono/core test:browser` before tagging. If it is red, the new test is the first place
to look — everything else in the suite is unchanged by this work.
