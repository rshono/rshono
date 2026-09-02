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

| #      | Issue                                                                             | Severity | Origin                   |
| ------ | --------------------------------------------------------------------------------- | -------- | ------------------------ |
| **G1** | One unloadable `'use server'` module disables **every** server action in the app  | Low      | Found while fixing F3    |
| **G2** | H1's justification for a textual substitution was wrong about DefinePlugin        | Nit      | Cost of H1, found via F8 |
| **G3** | The browser suite has never run in this environment, and now has a new test in it | Low      | Environment              |

---

# G1 — One unloadable `'use server'` module disables every server action in the app

**Severity: low.** Upstream behaviour, not an rshono defect — but it changes what a partial deploy looks like,
and nothing says it anywhere.

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

### Fix

None proposed for the framework. Worth a line in the deployment docs if the "chunks can go missing between
deploys" story is ever written up: for server actions it is all or nothing.

---

# G2 — H1's justification for a textual substitution was wrong about DefinePlugin

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
say what DefinePlugin actually does. Recorded here because the error was in the _review_, not in the code:
the same claim appears in `PRODUCTION.md`'s H1 section, which is a historical document and is left as
written.

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
