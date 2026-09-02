# Follow-ups from fixing the follow-ups

What fixing [`PRODUCTION-FOLLOWUPS.md`](./PRODUCTION-FOLLOWUPS.md) turned up: things that were not in either
review, or that those fixes left behind. Nothing here blocks 1.0.0, and nothing here is a regression of
anything struck through in the other two documents.

**Environment.** `@rshono/core@1.0.0-rc.19` · Rspack 2.2.2 · React 19.2.8 · Hono 4.13.5 · Node 22.22.2

---

## Summary

| #      | Issue                                                                            | Severity | Origin                |
| ------ | -------------------------------------------------------------------------------- | -------- | --------------------- |
| **G1** | One unloadable `'use server'` module disables **every** server action in the app | Low      | Found while fixing F3 |

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
