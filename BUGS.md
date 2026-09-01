# `@rshono/core` — production-readiness audit

Full read of `packages/core/src` (~7k LOC, 50 files) against the criteria: correctness, graceful
failure, safety (abuse, secrets, deployment environments), and memory/CPU behaviour.

Every item below was **reproduced or demonstrated**, not inferred from reading — except the client
half of #3, which is marked. Line numbers are against `packages/core/src` at `af50484`, and every one
of them was re-checked. The suite (`npm run build` + `unit.test.mjs`, 154 tests) passes on this tree;
none of these are covered by it.

**Nothing here is applied.** This is a report: every fix below is a patch to apply deliberately, and
`packages/core` is untouched.

## Fixes at a glance

| # | Finding | Severity | Fix | Touches |
|---|---|---|---|---|
| 1 | Flight payload with binary rows loses bytes, and can error the response outright | medium | Decode per chunk, not streaming; `ignoreBOM`; drop the final flush | `runtime/flight-inject.ts` |
| 2 | Prerendered `index.rsc` corrupted at build time | high | Carry bytes, not a string, through `renderVariant` → `write` | `server/ssg.ts` |
| 3 | `notFound()` by soft navigation paints the framework overlay on the second visit | medium | Release the reload bound when the reloaded document *is* the 404 | `runtime/entry.client.tsx` |
| 4 | A failing `rshono build` truncates its own error report in CI | medium | An `exit(code)` helper that drains both streams first | `cli/exit.ts` (new), `cli/build.ts`, `cli/index.ts` |
| 5 | `redirect()` responses get neither `Cache-Control` nor `Vary` | low | Set both by hand in `respondToControlSignal` | `runtime/entry.rsc.tsx` |
| 6 | `RSHONO_DEPLOY=constructor` is accepted as a deploy target | low | One `Object.hasOwn` lookup helper, used by both readers | `deploy/presets.ts` |

How far each patch was taken before being written down, all of it outside the tree:

- **1** — both algorithms fuzzed over 5000 random byte streams cut at random offsets (`current` 399
  lossy, `patched` 0), and the BOM hazard the change introduces found and closed.
- **2** — every reader of the value whose type changes enumerated; there are two, both pass-through.
- **3** — checked against the one existing test that asserts the key it touches.
- **4** — the helper and all five call sites type-checked with the repo’s `tsc`. That caught a bad hunk:
  `readPort` is synchronous, so `return exit(1)` fails with `TS2322`. Corrected below.
- **5** — header mutation on a `c.redirect()` response executed against `hono@4.13.5`.
- **6** — the prototype-key lookups executed against the built `dist/`.

None of the six changes an assertion any current test makes — see the per-item notes.

---

## 1. A flight payload containing binary data can be silently corrupted in the inlined HTML

**Severity: medium** (silent data corruption → the page fails to hydrate; reaching it needs a byte alignment)
**`src/runtime/flight-inject.ts:257-293`** (`writeFlight`; the decoder at `:261`, the fallback at `:278`, the final flush at `:292`)

The payload is decoded chunk-by-chunk with `new TextDecoder('utf-8', { fatal: true })` and
`{ stream: true }`, with a base64 fallback for a chunk that will not decode — which is how a binary
row (a `Uint8Array` / `ArrayBuffer` / `Blob` returned from a server component or action) is meant to
survive the trip through a `<script>` tag. The client reads both forms back (`entry.client.tsx:23`).

The fallback re-encodes **only the chunk that threw**. It does not account for the bytes the decoder
was already holding: with `{ stream: true }` a chunk ending mid-multi-byte-character leaves its lead
bytes buffered inside the decoder, to be emitted with the *next* chunk. When that next chunk throws,
those buffered bytes are dropped on the floor — they were never returned by `decode()` and they are
not in `value`.

Node's behaviour confirms the mechanism — after the throw the decoder resumes cleanly on the next
chunk, so exactly the buffered prefix is lost and nothing else:

```
A -> "a"        (E2 82 buffered)
B threw: TypeError
C -> "cd"
```

Fed those chunks, the built `dist/` injector loses them:

```
payload scripts: [ '"0:\\""', 'Uint8Array.from(atob("rCIKMTr//go="), m => m.codePointAt(0))' ]
want bytes: 303a22 e282ac 220a313afffe0a (13)
got  bytes: 303a22     ac 220a313afffe0a (11)   ← the two lead bytes of '€' are gone
```

The client then reassembles a payload two bytes short, the flight parser fails on it, and the visitor
gets the fatal overlay ("the client runtime failed to start") on a page the server rendered correctly.

### What actually produces such a split

Binary rows are real: `emitChunk` (`react-server-dom-rspack-server.node.production.js:1934`) sends
`ArrayBuffer`, `DataView` and all eleven typed-array kinds through `emitTypedArrayChunk` (`:1909`),
which pushes the typed array itself onto the wire; `serializeBlob` (`:1527`) funnels a `Blob`'s bytes
through the same path. Anything a server component hands a client component, or an action returns,
can be one.

A *text* split cannot trigger this, though. `writeChunk` (`:99-157`) writes every string with
`textEncoder.encodeInto`, which only ever writes whole code points — so a view flushed after a string
write ends on a character boundary, and a string too big for a view (`4096 < 3 * chunk.length`) is
encoded whole. There are no precomputed UTF-8 byte chunks in the build: `textEncoder.encode` appears
once, on the large-string path.

The split that does trigger it is in the **binary** branch. A typed array of ≤4096 bytes that does not
fit the current view is cut at an arbitrary offset —
`currentView.set(chunk.subarray(0, target), writtenBytes)` → flush → `chunk = chunk.subarray(target)` —
and a flush cycle also ends by writing `currentView.subarray(0, writtenBytes)`, which can land
immediately after a row's bytes. When the binary bytes left in that view happen to be valid UTF-8
ending in an incomplete sequence, the decoder buffers them; the next chunk carries the rest of the
same row, throws, and the prefix is gone.

That is a byte-alignment coincidence, not a routine occurrence — but it is reachable from plain React
output with no injector-side staging. Sweeping the length of a leading `Uint8Array` in
`{ big, small }`, where `small` starts with a UTF-8 lead byte, one length in the sweep loses a byte:

```
lossy: 1 of 107 typed-array sizes
{ L: 4083, boundaries: [ 4096, 35 ], wantLen: 4131, gotLen: 4130, lostAt: 4095 }
```

### 1b. The same decoder state makes the final flush throw, which errors the response

Found while building the fix, and worth its own note because the symptom is worse. The last three
lines of `writeFlight` are:

```ts
if (cancelled) return;
const remaining = decoder.decode();
if (remaining.length) await push(escapeScript(JSON.stringify(remaining)));
```

`decoder.decode()` is the end-of-stream flush, and on a `fatal` decoder holding an incomplete sequence
it **throws** — outside any `try`. The rejection reaches `.catch((error) => controller.error(error))`,
which errors the response stream. The visitor gets a truncated document with no trailer, on a page the
server rendered fine. Against the built `dist/`, with a payload whose last chunk ends mid-character:

```
response stream ERRORED: TypeError: The encoded data was not valid for encoding utf-8
bytes received: "<html><body>hi<script>…push("0:\"hi\"\n")</script><script>…push("1:\"")</script>"
```

Reachability is narrower than #1: I could not construct it through React's own writer, because
`serializeTypedArray` emits the row *then* returns the reference that the parent row carries, so the
typed-array bytes are always followed by at least that parent row's text — the payload's last chunk
ends with `\n`. Treat it as latent rather than live. The same one-line change removes it.

### Fix

Decode each chunk on its own. A chunk that is not valid UTF-8 by itself — binary bytes, or a split
character — then throws and the existing fallback re-encodes *that whole chunk* byte-exactly, and no
state survives between chunks for the fallback to miss.

```diff
--- a/packages/core/src/runtime/flight-inject.ts
+++ b/packages/core/src/runtime/flight-inject.ts
@@ -257,9 +257,17 @@
   async function writeFlight(controller: TransformStreamDefaultController<Uint8Array>): Promise<void> {
     const reader = (flightReader = rscStream.getReader());
-    // `fatal`, so a chunk that split a multi-byte character throws instead of emitting U+FFFD; the catch
-    // below falls back to a byte-exact encoding for it.
-    const decoder = new TextDecoder('utf-8', { fatal: true });
+    // One chunk at a time, deliberately *not* `{ stream: true }`: anything that is not valid UTF-8 on its
+    // own — a binary row's bytes, or a chunk that split a multi-byte character — throws, and the catch below
+    // re-encodes that whole chunk byte-exactly.
+    //
+    // Streaming is what makes that fallback wrong. A chunk ending mid-character leaves its lead bytes inside
+    // the decoder to be emitted with the next chunk; when the next chunk is a binary row and throws, those
+    // bytes are in neither `decode()`'s return nor `value`, and the client reassembles a payload short by
+    // them. It also left the end-of-stream flush below able to throw from outside any `try`.
+    //
+    // `ignoreBOM` because a per-chunk decode re-runs the BOM check on every call: without it any chunk whose
+    // first three bytes are EF BB BF would silently lose them.
+    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
     const push = async (literal: string): Promise<void> => {
@@ -274,7 +282,7 @@
       let literal: string;
       try {
-        literal = escapeScript(JSON.stringify(decoder.decode(value, { stream: true })));
+        literal = escapeScript(JSON.stringify(decoder.decode(value)));
       } catch {
         literal = `Uint8Array.from(atob(${JSON.stringify(btoa(latin1(value)))}), m => m.codePointAt(0))`;
       }
@@ -289,9 +297,7 @@
       }
     }
-    if (cancelled) return;
-    const remaining = decoder.decode();
-    if (remaining.length) await push(escapeScript(JSON.stringify(remaining)));
+    // No end-of-stream flush: a non-streaming decoder holds nothing between calls, so there is nothing left
+    // to emit — and the flush this replaces could throw, erroring the response mid-document. See above.
   }
```

**Verified.** Replaying the two algorithms over 5000 random byte streams cut at random offsets — the
shape the 4096-byte view boundary produces:

```
current:  399 lossy, of which 97 also threw from the unguarded final decoder.decode()
patched:  0 lossy
```

and on the synthetic case above, `303a22e282ac220a313afffe0a` in, the same 13 bytes out.

**The `ignoreBOM` is not optional.** A per-chunk decode resets the BOM check per call, so without it a
chunk beginning `EF BB BF` loses three bytes to the very fix that removed the other loss:

```
default   decode(BOM+'A') -> "A"
ignoreBOM decode(BOM+'A') -> "﻿A"
```

**Cost.** A chunk that merely split a character is now base64'd whole (~33% on that chunk) instead of
being stitched to its neighbour. Per the analysis above React never splits text mid-character, so in
practice this only re-encodes chunks that straddle a binary row — which were being base64'd anyway.
If that ever shows up in a payload-size measurement, the zero-inflation variant is to split the
trailing incomplete sequence off each chunk yourself and prepend it to the next, which keeps the bytes
somewhere the fallback can see them.

**Test impact.** None. Every case in `describe('injectFlightPayload')` feeds ASCII payloads (`0:"hi"\n`,
`0:"</script><!--x"\n`), which decode identically either way.

**Test to add.** The `atob` branch has no coverage at all: a payload of
`['0:"' + <bytes ending mid-character>, <continuation> + <invalid bytes>]` asserting the reassembled
bytes equal the input, plus one whose last chunk ends mid-character asserting the response completes
with a trailer.

---

## 2. A prerendered `index.rsc` is corrupted at build time

**Severity: high** (silent corruption, baked into the build)
**`src/server/ssg.ts:181`** (`RenderedVariant`), **`:189`** (`renderVariant`) and **`:284-286`** (`write`)

`renderVariant` reads every representation with `await response.text()` and `write` puts it back with
`writeFileSync(path, body)`. `Response.text()` is a *non-fatal* UTF-8 decode: every byte that is not
valid UTF-8 becomes U+FFFD, and writing the string back out encodes the replacement character as
three real bytes.

The HTML variant is safe *from this* (its inlined payload is already JSON-escaped or base64 by the time
`.text()` sees it — it is corrupted by #1 instead). The flight variant is the raw payload, so a
`render: 'static'` page whose payload carries binary data is written to disk already broken. Round-tripped
through `Response.text()` + `writeFileSync` + read back:

```
original:                303a226869220a313a fffe   0a  (12 bytes)
after .text() + write:   303a226869220a313a efbfbdefbfbd 0a  (16 bytes)
```

Unlike #1 this needs no alignment: one non-UTF-8 byte anywhere in the payload is enough, and
`emitChunk` puts them there for every typed-array row. The build reports the page as prerendered and
every soft navigation to it afterwards is served a payload the client cannot parse.
`toPrerenderedPage` (`prerendered.ts:171`) derives both `content-length` and the weak `ETag` from
whatever bytes are on disk — on the filesystem targets from `readPrerendered` (`ssg.ts:113-118`), on
Workers from the asset body (`deploy/cloudflare/runtime.ts:118`) — so nothing downstream notices.

### Fix

Carry bytes end to end. The string never buys anything: both readers of `body` hand it straight to
`writeFileSync`, which takes an `ArrayBufferView` as happily as a string.

```diff
--- a/packages/core/src/server/ssg.ts
+++ b/packages/core/src/server/ssg.ts
@@ -181,7 +181,7 @@
-type RenderedVariant = { ok: true; body: string } | { ok: false; reason: string; failed: boolean };
+type RenderedVariant = { ok: true; body: Uint8Array } | { ok: false; reason: string; failed: boolean };
 
 async function renderVariant(fetch: PrerenderOptions['fetch'], url: string, variant: PrerenderVariant): Promise<RenderedVariant> {
@@ -189,7 +189,10 @@
-  return { ok: true, body: await response.text() };
+  // Bytes, not `response.text()`. That is a *non-fatal* UTF-8 decode, so every byte of a binary row in a
+  // flight payload — `emitChunk` puts raw typed-array bytes on the wire — becomes U+FFFD, and writing the
+  // string back out spends three real bytes on each one. The page is then prerendered and unparseable.
+  return { ok: true, body: new Uint8Array(await response.arrayBuffer()) };
 }
@@ -284,7 +287,7 @@
-    const write = (variant: PrerenderVariant, body: string) => {
+    const write = (variant: PrerenderVariant, body: Uint8Array) => {
       mkdirSync(pageDir, { recursive: true });
       writeFileSync(join(pageDir, VARIANTS[variant].file), body);
```

**Scope check.** `grep -n '\.body\|RenderedVariant' src/server/ssg.ts` returns five lines: the type, the
signature, one comment, and the two `write(...)` calls at `:291` and `:297`. Nothing reads `body` as a
string — no `.length`, no concatenation, no `includes` — so the type change is fully local.

**Test impact.** None: the assertions are on the files' contents as read back from disk, and an
all-ASCII page round-trips identically.

**Test to add.** A `render: 'static'` fixture page whose payload carries a `Uint8Array`, asserting the
`index.rsc` on disk is byte-identical to the same route's per-request payload. That single assertion
covers this and would have caught it.

---

## 3. `notFound()` reached by soft navigation shows the framework's overlay on the second visit

**Severity: medium** (user-visible; breaks an entirely ordinary pattern)
**`src/runtime/entry.client.tsx:283-309`** (`reloadOnceForLateNotFound`)

`renderComponent` hands the flight stream to `c.body(...)` before React has rendered anything
(`entry.rsc.tsx:345-348`), so on an `RSC: 1` request a `notFound()` raised anywhere in the page —
including the first line of the component — can only ride the payload as a digest under a 200. This is
deliberate and asserted (`test/prod.test.mjs:259-270`, "the digest is what reaches the client, not a
404 payload"), and the client's answer is to reload: the hard load re-renders the page, `notFound()`
is thrown before the shell, `respondToControlSignal` renders the app's `notFound` page, and the
visitor gets a real 404 — also asserted, in the same test.

That recovery is bounded to **one reload per URL per tab**, keyed in `sessionStorage`, and the key is
never removed — `grep -rn sessionStorage src/` finds one `getItem` and one `setItem`, nothing else.
The bound exists for the *structural late* case (`/late-signal?signal=notfound`), where the reload gets
a byte-identical 200 and would otherwise spin forever. But it is applied to the *ordinary* case too,
where the reload always works.

So, with the testbed's own `/profile/:id` (`components/profile.tsx`: `if (!user) notFound()`, linked
from `user-list.tsx`):

1. Soft-navigate to `/profile/9999` → 200 + digest → key set → reload → real 404 page. Correct.
2. Navigate away, soft-navigate back to `/profile/9999` → key is already spent → `showLateNotFound()`
   paints a fixed-position dark panel reading "Page not found / This page is not available." over the
   app, with no reload button and no way out but a manual refresh.

The URL commits before an intercepted handler runs, so `documentUrl()` names the destination in both
steps and the key matches. The app's own 404 page is perfectly reachable — the framework just stops
asking for it. Worse, the panel is appended to `<body>` from outside React's tree and `paintOverlay`
only clears a previous `[data-rshono-fatal]` when it paints a new one (`:77`), so no later soft
navigation has anything that would take it down again.

The server half of this is asserted by the suite. The client half is a reading of
`loadPayload` → `handleControlDigest` → `reloadOnceForLateNotFound` (and of the `onCaughtError` /
`onUncaughtError` hooks, which route the same digest to the same place): it is not reproduced, because
the browser suite only covers `/late-signal` as a hard load
(`test/browser/client-runtime.spec.mjs:459-490`) and has nothing that soft-navigates to a `notFound()`
page twice. That missing test is itself the finding's other half.

### Fix

The client can already tell the two cases apart, and does not look: `RscPayload.notFound`
(`entry.rsc.tsx:91`) is set in exactly two places, and both mean "this document is the app's `notFound`
page": `respondToControlSignal` (`:521`) and the `app.notFound` handler for an unmatched path (`:628`).
So a reloaded document carrying `notFound` **is** the 404 the soft navigation could not be given — the
recovery worked, and the bound is spent on nothing. The structural case commits its 200 before it
signals, so its reloaded document never carries the flag and its loop stays bounded.

```diff
--- a/packages/core/src/runtime/entry.client.tsx
+++ b/packages/core/src/runtime/entry.client.tsx
@@ -265,6 +265,9 @@
 /** How long the recovery reload is given to replace this document before the panel is painted instead. */
 const RELOAD_GRACE_MS = 2000;
 
+/** The `sessionStorage` key bounding the recovery reload for one URL. Written here, cleared in `main()`. */
+const lateNotFoundKey = (): string => `rshono:late-not-found:${documentUrl()}`;
+
@@ -283,7 +286,7 @@
 function reloadOnceForLateNotFound(): void {
-  const key = `rshono:late-not-found:${documentUrl()}`;
+  const key = lateNotFoundKey();
   let spent: boolean;
@@ -452,6 +455,18 @@
   const initialPayload = await createFromReadableStream<RscPayload>(flightStream);
 
+  // The recovery reload landed: this document is the `notFound` page, so the signal that could only be a
+  // digest on the `RSC: 1` request became a real 404 on the document request. The one-reload bound was spent
+  // on a recovery that worked and has to be released — otherwise the *next* soft navigation to this URL sees
+  // a spent key and paints `showLateNotFound()` over a page the app can still render.
+  //
+  // This is the discriminator the bound was missing. A structurally late `notFound()` commits its 200 before
+  // it signals, so its reloaded document is the page itself and carries no `notFound`: the key survives and
+  // that loop stays bounded at one reload, which is the whole reason the bound exists.
+  if (initialPayload.notFound) {
+    try {
+      sessionStorage.removeItem(lateNotFoundKey());
+    } catch {
+      // Blocked site data. `reloadOnceForLateNotFound` already treats that as the terminating case.
+    }
+  }
+
   function BrowserRoot() {
```

**Why `main()` and not the navigation path:** the flag is only trustworthy on a document the server
just rendered. Clearing it from `loadPayload` would clear it on any soft navigation that *received* a
404 payload, including ones that never spent a reload.

**Test impact.** None, and specifically not on the one test that asserts this key.
`client-runtime.spec.mjs:480` expects `sessionStorage` to hold exactly
`['rshono:late-not-found:/late-signal?signal=notfound']` after the structural case — that document is
`/late-signal` rendering itself under a committed 200, not the `notFound` page, so `initialPayload.notFound`
is absent and the key is left alone.

**Test to add.** The missing direction, in the browser suite: soft-navigate to `/profile/9999`, assert
the app's 404 heading; navigate away; soft-navigate back; assert the 404 heading again and
`[data-rshono-fatal]` at count 0. It fails on `main` at the second visit.

---

## 4. A failing `rshono build` truncates its own error report in CI

**Severity: medium** (a large build failure prints a report that stops mid-error)
**`src/cli/build.ts:69-72`**

```ts
if (stats.hasErrors()) {
  console.error(stats.toString({ preset: 'errors-warnings', colors: true }));
  process.exit(1);
}
```

`process.exit()` does not drain a pipe. When stdout/stderr is a pipe — i.e. every CI job, and any
`rshono build | tee` — the write is asynchronous and everything past the pipe buffer is discarded:

```
$ node -e "console.error('E'.repeat(300000)); process.exit(1)" 2>&1 | wc -c
   65536          ← 64 KiB, the pipe buffer
$ node -e "console.error('E'.repeat(300000))"                  2>&1 | wc -c
  300001
```

The cut is at the buffer, not at zero: output that fits still lands, so this is a *truncated* report
rather than a missing one. How much fits, measured against this repo's Rspack: an `errors-warnings`
dump with `colors: true` runs ~819 bytes per module-resolution error (40 errors → 32,761 bytes) and
~600 bytes per syntax error with a code frame. `rspack(configs)` is a multi-compiler
(`createConfigs` returns `[clientConfig, serverConfig]`), so a mistake in a shared module is reported
by both compilations. That puts the ceiling around 40–80 distinct broken imports — a renamed export or
a missing dependency, not an exotic failure — after which the report stops mid-error.

The same file already recognises the problem and guards the *success* path against it (`:122-125`,
"a piped stdout is asynchronous, and exiting drops whatever has not drained"); the failure path, where
the output matters more, is unguarded.

`phase()` (`:43-44`) and `cli/index.ts:89-92` have the same shape but print short messages, so they
only matter behind output that has already filled the buffer.

### Fix

Lift the existing drain into a helper, cover `stderr` too, and route every exit through it. Typed
`Promise<never>` so `return exit(1)` still satisfies `phase<T>`'s `Promise<T>` and TypeScript keeps
treating the branch as terminal.

```ts
// packages/core/src/cli/exit.ts — new file
/**
 * `process.exit`, once both output streams have drained.
 *
 * A piped stdout/stderr — every CI job, and any `rshono build | tee` — is asynchronous, and exiting drops
 * whatever has not left the pipe buffer (64 KiB on Linux and macOS). On the failure paths that is the report
 * saying *why* the build failed, cut mid-error. A zero-length write's callback fires behind the real ones, so
 * awaiting one per stream is enough.
 *
 * `Promise<never>`, so a caller can `return exit(1)` and keep the branch terminal for control-flow analysis.
 */
export async function exit(code: number): Promise<never> {
  await Promise.all(
    [process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write('', () => resolve()))),
  );
  process.exit(code);
}
```

```diff
--- a/packages/core/src/cli/build.ts
+++ b/packages/core/src/cli/build.ts
@@ -11,6 +11,7 @@
 import { prerenderStaticRoutes } from '../server/ssg.js';
+import { exit } from './exit.js';
 
@@ -41,7 +42,7 @@
     if (!message.startsWith('[rshono]')) throw error;
     console.error(`\n  ✗ ${message}\n`);
-    process.exit(1);
+    return exit(1);
   }
 }
@@ -69,7 +70,7 @@
   if (stats.hasErrors()) {
     console.error(stats.toString({ preset: 'errors-warnings', colors: true }));
-    process.exit(1);
+    return exit(1);
   }
@@ -122,6 +123,5 @@
-  // Rspack's worker pool can keep the loop alive after `close()`, so the exit is explicit — but a piped
-  // stdout is asynchronous, and exiting drops whatever has not drained. In CI that is exactly the lines
-  // saying what was built and where it went. A zero-length write's callback fires behind the real ones.
-  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
-  process.exit(0);
+  // Rspack's worker pool can keep the loop alive after `close()`, so the exit is explicit. `exit` drains
+  // first: in CI the tail is the lines saying what was built and where it went.
+  await exit(0);
 }
```

```diff
--- a/packages/core/src/cli/index.ts
+++ b/packages/core/src/cli/index.ts
@@
+import { exit } from './exit.js';
@@ -83,11 +84,11 @@
     default:
       console.error(`rshono: unknown command "${command}"\n`);
       console.log(HELP);
-      process.exit(1);
+      return exit(1);
   }
 }
 
-main().catch((error) => {
+main().catch(async (error: unknown) => {
   console.error(error);
-  process.exit(1);
+  await exit(1);
 });
```

**`readPort` (`:33`) deliberately keeps its bare `process.exit(1)`.** It is synchronous, so
`Promise<never>` is not assignable to its `number | undefined` return — `tsc` rejects `return exit(1)`
there with `TS2322`. Making it async would ripple through `parseArgs` handling to protect the one path
that cannot need it: it runs before any output exists, so the pipe buffer is empty.

**Test impact.** `start.test.mjs` asserts `result.status === 1` and the message text on four failure
paths (`:34`, `:42`, `:93`, `:102`); the helper only awaits two zero-length writes before the same
`process.exit(code)`, so both stay true.

**Test to add.** A build fixture with ~100 broken imports, asserting the piped stderr both exceeds
64 KiB and ends with the Rspack footer rather than mid-frame.

---

## 5. `redirect()` responses get neither `Cache-Control` nor `Vary`

**Severity: low** (narrow, but it breaks a stated default)
**`src/runtime/entry.rsc.tsx:486-488`** (the gate) and **`:517`** (the redirect)

The framework's outermost middleware gates its `Vary: RSC` and `private, no-cache` defaults on the
response's content type:

```ts
if (!PAGE_CONTENT_TYPE.test(headers.get('content-type') ?? '')) return;
```

`c.redirect(location, status)` builds a bodiless response with **no** content type, so the document
representation of a `redirect()` gets neither header. Reproduced against `hono@4.13.5` with the same
gate:

```
content-type seen by the middleware: null
-> gate skipped the response
status 308 headers [ [ 'location', '/dashboard' ] ]
```

The README states the defaults as "`private, no-cache` plus `Vary: RSC` on dynamic pages"
(`packages/core/README.md:227`), and every other framework-owned answer — `plainNotFound` (`:175`),
the last-resort 500 (`:664`), and the *flight* form of the same redirect at `:513-515`, which is
`text/x-component` and so does get both — carries them for exactly this reason.

It matters for `301` and `308`, both of which `RedirectStatus` accepts (`context.ts:30`) and both of
which are cacheable with no explicit `Cache-Control` at all — 301 is on RFC 9110 §15.1's
heuristically-cacheable list, and RFC 7538 §3 defines 308 as cacheable by default. A
request-dependent permanent redirect out of a page — `redirect('/dashboard', 308)` behind a session
check — can be stored by a shared cache and replayed to a different visitor, and the missing `Vary`
lets one URL's document redirect be served to an `RSC: 1` fetch that needs the payload instead. `303`
(the default), `302` and `307` are not heuristically cacheable, so most apps never reach this.

### Fix

Set the two headers where the redirect is built. `:517` is the only `c.redirect` in the file and every
control-signal path funnels through `respondToControlSignal` (`:532`, `:575`, `:635`), so one place
covers all of them — and doing it here rather than widening the middleware's gate leaves that gate
saying what it says now, that it decorates page representations.

```diff
--- a/packages/core/src/runtime/entry.rsc.tsx
+++ b/packages/core/src/runtime/entry.rsc.tsx
@@ -515,7 +515,16 @@
       }
-      return c.redirect(signal.location, signal.status as RedirectStatusCode);
+      // Both page defaults by hand: `c.redirect` builds a bodiless response with no content type, so the
+      // middleware that would apply them skips it on `PAGE_CONTENT_TYPE`. They are not decoration here —
+      // `301` and `308` are cacheable with no explicit `Cache-Control` at all, so a session-gated permanent
+      // redirect could otherwise be stored by a shared cache and replayed to another visitor, and without
+      // `Vary` this document redirect could answer an `RSC: 1` fetch that needs the payload at `:513`.
+      const redirected = c.redirect(signal.location, signal.status as RedirectStatusCode);
+      appendVary(redirected.headers, RSC_VARY_HEADER);
+      if (!redirected.headers.has('cache-control')) {
+        redirected.headers.set('cache-control', PAGE_CACHE_CONTROL);
+      }
+      return redirected;
     }
```

`appendVary` and `RSC_VARY_HEADER` are already imported in this file (`:31`, `:38`); `PAGE_CACHE_CONTROL`
is local (`:71`).

**Verified mutable.** A `c.redirect()` response has a `Headers` with the "response" guard, which
forbids only forbidden response-header names — setting `vary` and `cache-control` is allowed, and the
values survive Hono's dispatch:

```
final: 308 [ [ 'cache-control', 'private, no-cache' ], [ 'location', '/dashboard' ], [ 'vary', 'RSC' ] ]
```

**Test impact.** `prod.test.mjs` asserts redirect status and `location` for the `redirect()` routes and
`getSetCookie` on the action redirect; adding two headers touches none of those assertions.

**Test to add.** One line beside the existing redirect tests: assert `vary` contains `RSC` and
`cache-control` is `private, no-cache` on the document form.

---

## 6. `RSHONO_DEPLOY=constructor` is accepted as a deploy target

**Severity: low** (bad error message, no security impact)
**`src/deploy/presets.ts:184`** (and `:162`)

`PRESETS` is a plain object literal and the lookup is a bare bracket access, so `Object.prototype`
keys resolve to inherited values and pass the `if (!preset)` guard:

```
nope            -> throws: [rshono] unknown deploy target "nope" — expected one of: node, cloudflare, vercel, aws-lambda.
constructor     -> preset returned, runtimeModule=undefined
__proto__       -> preset returned, runtimeModule=undefined
toString        -> preset returned, runtimeModule=undefined
valueOf         -> preset returned, runtimeModule=undefined
hasOwnProperty  -> preset returned, runtimeModule=undefined
```

`createConfigs` then does `preset.runtimeModule.split('/')` (`builder/rspack-config.ts:317`) on
`undefined` and the build dies with a `TypeError` from there instead of the message written for this.
Reachable from `--deploy`, `RSHONO_DEPLOY` and the `deploy` config field. Not exploitable — it is a
self-inflicted typo — but the codebase already uses `Object.hasOwn` for precisely this reason two files
over (`entry.rsc.tsx:404` on the server-action manifest, `server-only-imports.ts:51`), so this is an
inconsistency rather than a judgement call.

`deployHintFor` (`:162`) has the same lookup but reads through `?.deployHint ?? null`, so a prototype
key comes back as `null` there — the same shape, no visible symptom.

### Fix

One lookup helper, used by both readers, so the two cannot drift.

```diff
--- a/packages/core/src/deploy/presets.ts
+++ b/packages/core/src/deploy/presets.ts
@@ -154,12 +154,21 @@
 /** Every target `deploy` accepts, for error messages and docs. */
 export const DEPLOY_TARGETS = Object.keys(PRESETS) as DeployTarget[];
 
+/**
+ * `PRESETS[target]` for a target that really is one.
+ *
+ * `Object.hasOwn` rather than a bare bracket access, which resolves every `Object.prototype` key —
+ * `constructor`, `__proto__`, `toString` — to an inherited value that then passes a truthiness guard. A typo
+ * that happens to be one of those used to reach the builder and die on `preset.runtimeModule.split('/')`
+ * instead of getting the message written for an unknown target.
+ */
+function presetFor(target: string): DeployPreset | undefined {
+  return Object.hasOwn(PRESETS, target) ? PRESETS[target as DeployTarget] : undefined;
+}
+
 /**
  * How to deploy what a given target built, or `null` for a name this rshono does not know — which a `dist/`
  * from a newer version can legitimately carry.
  */
 export function deployHintFor(target: string): string | null {
-  return (PRESETS as Record<string, DeployPreset | undefined>)[target]?.deployHint ?? null;
+  return presetFor(target)?.deployHint ?? null;
 }
@@ -184,7 +193,7 @@
-  const preset = (PRESETS as Record<string, DeployPreset | undefined>)[target];
+  const preset = presetFor(target);
   if (!preset) {
```

The helper also retires both `as Record<string, DeployPreset | undefined>` casts — the assertion that
was papering over the unsound index in the first place.

**Test impact.** None. `unit.test.mjs:1330-1356` covers precedence, blank values, the unknown-target
throw (`:1345`) and every real target round-tripping through `deployHintFor`; `deploy-targets.test.mjs`
builds the testbed for each target through `--deploy`. Only `Object.prototype` keys change answer, and
nothing asserts on those today.

**Test to add.** One case beside the existing unknown-target assertion at `unit.test.mjs:1345`:
`assert.throws(() => resolveDeployPreset({ env: 'constructor' }), /unknown deploy target/)`.

---

## Checked and found sound

Recorded so the scope of the audit is legible, and so these are not re-derived next time.

- **Secret containment.** The client bundle's `process.env` is a DefinePlugin literal; the SSR layer's
  shadow is a per-module prelude that *fails the build* if it cannot read the module's layer; the rule
  deliberately covers `node_modules`, and the base externals policy compiles every SSR-layer module in
  on every target (`rspack-config.ts:304`), so the loader always has a module to run on. `ctx` is non-enumerable on page props, `RequestContext` exposes
  only getters and methods, `ctx.env` merges bindings on Workers alone. No client source maps in a build;
  `dist/server` is not on a public path on any of the four targets.
- **Path traversal.** Guarded three independently sufficient ways — URL dot-segment normalization
  (verified: `/a/%2E%2E/b` → `/b`), `isStorableSegment` rejecting `.`/`..`/separators/control characters,
  and a `resolve()`-and-prefix check in `readPrerendered`. The double decode (Hono's `decodeURI` then
  `decodeURIComponent` per segment) round-trips correctly for spaces, `+`, and literal `%`, and turns
  `%2F` into a miss rather than a separator.
- **CSRF.** `refusesCrossSiteForm` is the right shape: `Sec-Fetch-Site` plus an `Origin` equality check,
  refusing `null` and absent `Origin`, and comparing against `publicUrl(c)` so it survives a proxy. The
  `rsc-action` branch is genuinely unreachable cross-origin (`x-rsc-action` is not CORS-safelisted and
  the framework answers no preflight). Action ids are checked with `Object.hasOwn` before the body is
  decoded.
- **Header injection.** `redirect()`, `ctx.setHeader()` and cookies all route through `Headers`, which
  rejects CRLF; a bad value is a 500, not an injected header.
- **`publicUrl` under `trustProxy`.** `X-Forwarded-Host: example.com:443` normalises to
  `https://example.com` (verified), so a strict `csrf({ origin })` comparison holds; an unparseable or
  out-of-range host is ignored rather than half-applied.
- **HEAD.** Hono dispatches HEAD to the GET route and rebuilds as `new Response(null, res)` without
  reading the body (confirmed in `hono-base.js:279-281`); the page handler cancels the stream itself, and
  `serveStatic` has its own HEAD branch, so neither leaks a render or a file descriptor.
- **Streaming lifecycle.** `flight-inject`'s permit scheme, the `cancelled`/`teardown` idempotence, the
  `carry` trailer logic and the abort-forwarder release in `renderComponent` all hold up; the request
  signal is never handed to a React renderer, and the forwarder is detached on every exit path.
- **Memory.** Every long-lived map is bounded or weak: `createPageCache` is byte-bounded and stores
  hits only, `storeIndex`/`storeIndexes` hold one entry, and `wrappers` / `rendering` / `actionResults` /
  `alreadyReported` are `WeakMap`/`WeakSet` keyed on the Hono context.
- **Route validation.** `validateRoutesModule` catches the mistakes types cannot (cross-kind keys,
  duplicate paths shadowed by registration order, `'all'` inside a method list), and `assertRouteModules`
  runs it against every module at build time.
