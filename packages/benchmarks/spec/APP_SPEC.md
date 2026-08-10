# APP_SPEC

The contract every benchmark app implements. A number is only comparable if the thing producing it
is the same on both sides, so this file is the authority: if an app deviates from it, the app is
wrong, not the spec.

Three implementations live in `../apps/`: `rshono`, `next`, `tanstack-start`.

## Rules

1. **Same data, no I/O.** Every route reads `fixtures/data.json` (100 users, committed, deterministic).
   It is imported/parsed once at module scope. No database, no network, no `fs` per request, no
   artificial delay. A benchmark that hits a data source measures the data source.
2. **Same visible output.** The rendered text content of a route must match across apps. Markup
   structure may differ where a framework forces it (root elements, hydration wrappers); content
   must not. `harness/payload.mjs` asserts the text-content checks listed per route below.
3. **Same client-component count.** Where the spec says a component is interactive, it is interactive
   in all three apps — same state, same handlers. Nobody gets to win a payload metric by shipping
   less behaviour.
4. **No compression at the app layer.** Every app runs with its own compressor off
   (`compress: false`, `compress: false`, no plugin respectively). The harness measures
   uncompressed transfer and applies gzip + brotli itself, identically, so the numbers reflect the
   bytes and not three different compressor settings.
5. **No caching beyond what the route explicitly declares.** `/ssr` must be genuinely dynamic in all
   three — re-rendered per request. `/` must be prerendered at build time in all three.
6. **Single process, no clustering.** Production mode, one Node process per app, default GC flags.
7. **No images, no web fonts, no third-party anything.** One stylesheet, inline SVG only. Network
   waterfalls are not what is being measured.
8. **Server components on both dynamic routes, in all three.** `/ssr` and `/interactive` put React's
   flight encode/decode round trip on the request path everywhere, so the throughput rows compare
   three implementations of one architecture rather than two architectures. See below for the part
   this does _not_ equalise.

## Server components

rshono and Next render the **whole document** as a server component tree: layout, route and every
host element in it are encoded to a flight payload and decoded again on each request.

TanStack Start's RSC support is **opt-in per boundary** — the router, root route and shell stay
client components rendered by Fizz, and only what you wrap goes through flight. The two dynamic
routes wrap their entire body (`renderServerComponent` for `/ssr`, `createCompositeComponent` for
`/interactive`), which is as close to whole-document as its model allows, but the shell and nav
still do not cross the boundary. Its flight payload is therefore a little smaller than the other
two's for the same visible output, and a little of its render stays on the cheaper path.

Read the throughput rows with that in mind: they are no longer RSC vs no-RSC, but they are not a
perfect match either. Enabling it is what `rsc: { enabled: true }` plus the `@vitejs/plugin-rsc`
plugin in `apps/tanstack-start/vite.config.ts` does; reverting those two and restoring the plain
route components turns the app back into the non-RSC datapoint, which is worth having on its own.

## Fixtures

`fixtures/data.json`:

```jsonc
{
  "users": [
    { "id": 1, "name": "…", "email": "…", "role": "admin" | "editor" | "viewer", "score": 0-999 },
    // … 100 total
  ],
}
```

Generated once by `fixtures/generate.mjs` from a fixed seed and committed. Do not regenerate it to
"refresh" the data — every historical result in `results/` was measured against these exact bytes.

## Routes

### `/` — prerendered, zero client JS

A marketing-style page: heading, subtitle, three feature cards, a footer. Rendered **once at build
time** and served from disk.

- rshono: `render: 'static'`
- Next: default (statically rendered at build; no dynamic APIs read)
- TanStack Start: prerendered via the `prerender` option

Contains **no client component**. This is the floor measurement: how much JavaScript does the
framework ship for a page whose content needs none?

Text-content checks: `Benchmark Suite`, `Server Components`, `Server Actions`, `HTTP Endpoints`.

### `/ssr` — dynamic, 100 rows, zero client JS

Renders all 100 fixture users as a table: id, name, email, role, score. Plus a computed summary line
(`count`, `sum of score`, `admin count`) so the render is not purely a map over strings.

Must be re-rendered per request:

- rshono: `render: 'dynamic'` (the default) and reads `ctx` so it cannot be hoisted
- Next: `export const dynamic = 'force-dynamic'`
- TanStack Start: excluded from `prerender`; the table is a server component rendered through
  `renderServerComponent` in the route's `createServerFn` (see **Server components**, below)

Contains **no client component**. Isolates server render cost + the streaming path.

Text-content checks: `100 users`, `Ada Lovelace` (fixture user 1), `admins`.

### `/interactive` — dynamic, three client components

A server-rendered shell that passes fixture data into three client components:

1. **Counter** — `useState`, a button that increments. The minimal hydration unit.
2. **Filter** — receives all 100 users as a prop, `useState` for a query string, filters the list
   client-side and renders matches. Exercises a non-trivial serialized payload crossing the boundary.
3. **SignupForm** — a form calling a server function (rshono: `'use server'` action; Next: `'use server'`
   action; TanStack Start: `createServerFn`), rendering the returned result. Exercises the
   mutation path.

The server function validates `{ name, email }` and returns `{ ok: true, id }` or
`{ ok: false, error }`. It does not mutate the fixture — a benchmark run must be idempotent.

The shell is a server component in all three. TanStack Start builds it with
`createCompositeComponent` and slots the three in as **component props** — the only one of its three
slot kinds through which the server can hand data across the boundary, which `Filter` needs.

Text-content checks: `Counter`, `Filter`, `Sign up`, `Ada Lovelace`.

### `/api/health` — JSON, no React

Returns `{"ok":true,"route":"health"}` with `content-type: application/json`. No React on the path at
all. Isolates the HTTP layer: router lookup, middleware, response construction.

- rshono: `{ type: 'endpoint' }` route
- Next: `app/api/health/route.ts`
- TanStack Start: a server route

## What is deliberately not in here

- **Nested layouts / route groups.** They differ too much between the three to compare fairly.
- **Suspense boundaries with delayed data.** Any delay dominates the measurement; the streaming
  behaviour is asserted by each framework's own test suite, not here.
- **Client-side navigation.** Worth measuring eventually, but the three have such different
  navigation models (flight payload vs flight payload vs client router + loader) that measuring it
  well means three different protocols, and measuring it badly is worse than not measuring it. Not
  in this version.
- **Real serverless cold start.** `coldstart.mjs` measures process spawn to first response on the
  local machine, which isolates the framework's own startup cost. Platform container overhead is a
  property of the platform, not of these three.
