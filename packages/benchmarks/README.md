# @rshono/benchmarks

One application, implemented three times — [`@rshono/core`](../core), Next.js App Router, TanStack
Start — and measured on what the framework costs rather than on who renders React faster.

```bash
pnpm --filter @rshono/benchmarks setup:apps   # build + pack core, install all three apps
pnpm --filter @rshono/benchmarks bench        # everything, then write results/latest.md
```

**Re-run `setup:apps` after every change to `packages/core`.** The rshono app installs the framework
from a packed tarball, not a workspace link (see `harness/install.mjs` for why), and nothing re-packs
it except that command — so a `bench` after an unpacked change measures whatever core was current the
last time you ran it. Every runner now refuses to start when the installed core differs from what this
checkout builds, and says so; before that guard existed, a `/ssr` route that 500'd on every request
against a four-release-candidates-old core was published at **2,828 rps against ~270 for the other
two**, because an error response skips the render and so reads _faster_ than a working server.

Script names here avoid pnpm's built-in commands on purpose. `pnpm --filter <pkg> setup` resolves
pnpm's own `setup` rather than the script and fails with `Unknown option: 'recursive'`; `clean` is
taken too. Hence `setup:apps` and `clean:apps`.

## Why not a throughput shootout

All three render through the same React and stream through the same `react-dom`. rshono's render path
is a thin shell over `react-server-dom-rspack` and `react-dom/server` — the same two packages Next
drives, and the same `react-dom` TanStack Start drives. A requests-per-second headline over that
shared machinery mostly measures whose HTTP layer is in front of it, and any gap it does show is as
likely to be React version skew as framework design.

So throughput is in here as a **floor check** — proof that nothing is pathological — and the metrics
that carry weight are the ones a framework actually decides:

| Metric                               | Runner          | Why it means something                                                                                                           |
| ------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Initial-load payload per route       | `payload.mjs`   | What the framework commits the browser to before the route is usable. The one number a minimalist framework should be judged on. |
| Cold + warm build                    | `build.mjs`     | Rspack vs Turbopack vs Vite/Rolldown, on identical input.                                                                        |
| Dev server startup                   | `devstart.mjs`  | Paid many times a day.                                                                                                           |
| Cold start + server bundle size      | `coldstart.mjs` | What a scale-from-zero request pays.                                                                                             |
| Throughput, latency, memory          | `load.mjs`      | Floor check, and `/api/health` isolates the HTTP layer with React off the path.                                                  |
| Production install + app source size | `footprint.mjs` | What the dependency costs before a request is served.                                                                            |

## The rules

[`spec/APP_SPEC.md`](spec/APP_SPEC.md) is the authority on what the three apps must do. The parts that
decide whether the numbers are honest:

- **Same data, no I/O.** `fixtures/data.json` — 100 users, committed, deterministic, parsed once at
  module scope. A benchmark that touches a database measures the database.
- **Same visible output**, asserted. `payload.mjs` runs text-content checks per route and marks a
  target `⚠` when its render doesn't contain what the spec says it should. A byte count for a route
  that quietly 404'd or rendered an empty list is worse than no number.
- **Same client-component count.** Nobody wins a payload metric by shipping less behaviour.
- **No app-level compression.** All three run with their compressor off; the harness applies gzip 9
  and brotli 11 itself, identically, so the table reflects bytes rather than three compressor configs.
- **The same old-space budget.** `load.mjs` starts all three with `--max-old-space-size=256`
  (`--heap=N`, or `--heap=0` to opt out). V8 grows the old generation against the allocation rate, so
  left at the default the after-load RSS measures throughput rather than memory: the fastest server
  churns the most garbage in the fixed eight seconds and so ends up looking the worst.
- **`/` prerendered and `/ssr` genuinely dynamic in all three.** Both are easy to get wrong in a
  direction that flatters somebody — Next will happily prerender `/ssr` unless told not to, and
  TanStack's prerender crawler follows the nav links off `/` unless `crawlLinks: false` stops it.

## Routes

| Route          | Kind                                    | What it isolates                                               |
| -------------- | --------------------------------------- | -------------------------------------------------------------- |
| `/`            | prerendered, no client components       | The floor: JS shipped for a page whose content needs none.     |
| `/ssr`         | dynamic, 100 rows, no client components | Server render + streaming.                                     |
| `/interactive` | dynamic, three client components        | Hydration, the serialized boundary payload, the mutation path. |
| `/api/health`  | JSON                                    | The HTTP layer with React entirely off the path.               |

## Reading the output

`results/latest.md`, regenerated by `pnpm report`. `results/latest.json` holds every sample, not just
the medians. A full `bench` also snapshots a dated file next to them; laptop snapshots are gitignored
because they aren't comparable to anything, including each other.

Timings print with their relative spread (`±12%`). Treat anything inside the spread as a tie.

**No memory row is a retained-memory figure.** RSS is a high-water mark including garbage V8 hasn't
collected yet — on this app a forced GC gave back 362 MB of an uncapped 472 MB run, and retention per
request measured under 20 B. That is why the budget above is capped, why the report prints churn per
1,000 requests rather than raw growth (the load runs for a fixed time, so a server answering five times
the requests allocates five times as much), and why there is a per-route sequence: flat means the server
had levelled off, a climb means the single after-load figure is wherever the run happened to stop.

## Caveats that change how you should read this

These are limitations of the comparison, not of the frameworks. Read them before quoting a number.

1. **Timings from a laptop are indicative only.** Thermal throttling and background indexing move
   build and throughput numbers more than most of the differences being measured. `run.mjs` prints a
   warning on macOS outside CI. Payload and size numbers are exact anywhere — they're bytes on disk.
2. **React version skew is real and is reported, not hidden.** Next vendors its own React copy under
   `next/dist/compiled`, so the three do not run identical renderers and cannot be made to. The
   version table in every report exists so a few percent on a render path is read as what it probably
   is. This is the single most likely reason a render-path difference here is not about the framework.
3. **TanStack Start is served by `vite preview`.** That is the official way to run its production
   build locally, but it is a connect-based preview server, not a deployment target — a real
   TanStack deploy goes through a platform preset. Its `/` throughput in particular (a prerendered
   file served by preview middleware) should not be read as its deployed static performance. rshono
   and Next are both served by their own production servers, which is the asymmetry to keep in mind.
4. **TanStack Start is a client-router-first framework.** Its components run in the browser too, so
   the fixture is reached through `createServerFn` rather than imported directly — otherwise all 100
   users would be bundled into the client graph and the payload number would measure a mistake. Its
   loader data is then serialized into the document for the client router to hydrate, which an RSC
   framework does not pay. That is an architectural difference, not a defect.
5. **rshono pays a production-install cost the other two don't.** `@rspack/core` sits in
   `@rshono/core`'s `dependencies` rather than `devDependencies` — the bundler is what the CLI it ships
   builds with — so it lands in a production install. `footprint.mjs` measures it.
6. **rshono is built on experimental `rspack.experiments.rsc` and a pre-1.0 `react-server-dom-rspack`.**
   Those move under it, which is why this is CI infrastructure to re-run per release rather than a
   number to publish once.
7. **Not measured:** client-side navigation (three different protocols; measuring it badly is worse
   than not measuring it), HMR round-trip (needs a browser asserting the patch arrived), real
   serverless cold start (platform overhead is a property of the platform), progressive enhancement
   (rshono and Next have it, TanStack has no equivalent, so the shared client component deliberately
   doesn't use it).

## Runners

Each writes its own section into `results/latest.json` and can run alone. Pass target ids to narrow:
`node harness/payload.mjs rshono next`.

| Command                | Notes                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm setup:apps`      | Builds `@rshono/core`, packs it to a tarball, installs all three apps. Run after core changes.                                     |
| `pnpm bench`           | Every stage, then a snapshot and a report. `--footprint` adds the install measurement.                                             |
| `pnpm bench:build`     | `--trials=N` (default 3).                                                                                                          |
| `pnpm bench:payload`   | `--strict` exits non-zero on a failed spec check.                                                                                  |
| `pnpm bench:load`      | `--connections=32 --duration=8 --warmup=2 --heap=256`, or `--quick`. A route that serves non-2xx is reported as `—`, never as rps. |
| `pnpm bench:coldstart` | `--trials=N` (default 5).                                                                                                          |
| `pnpm bench:devstart`  | Clobbers the production builds and rebuilds them afterwards; `--no-restore` skips that.                                            |
| `pnpm bench:footprint` | Three real `npm install --omit=dev` runs. Slow. `--source-only` skips them.                                                        |
| `pnpm report`          | Re-render `results/latest.md` from whatever sections exist.                                                                        |
| `pnpm site:publish`    | Copy the report into the website — see below.                                                                                      |
| `pnpm clean:apps`      | Build outputs; `--deep` also removes `node_modules` and lockfiles.                                                                 |
| `pnpm fixtures`        | Regenerates the committed `fixtures/data.json`, invalidating every result in `results/`.                                           |

### Publishing to the website

`apps/website` serves these results at `/benchmarks`. `results/latest.md` is generated and gitignored, so
the website cannot import it — a fresh clone would have nothing to read. `site:publish` writes a committed
copy into `apps/website/content/benchmarks.md` instead:

```bash
pnpm --filter @rshono/benchmarks bench
pnpm --filter @rshono/benchmarks site:publish
```

Only the measured tables are copied. The framing on that page — what the numbers mean, the caveats, the
rows rshono loses — is authored JSX in `apps/website/src/components/benchmarks.tsx`, so regenerating data
can never overwrite prose that took judgement. Re-running `bench` without `site:publish` leaves the site
showing the previous run, which is why the published file carries the date it was measured.

### Why the apps are not workspace members

The root `pnpm-workspace.yaml` pins React, `react-server-dom-rspack` and `@rspack/core` with `overrides`. Forcing
those onto Next and TanStack Start would benchmark a configuration nobody ships, so all three apps are
installed with plain `npm` into isolated `node_modules` — which is also what makes the footprint
numbers mean anything.

The rshono app installs `@rshono/core` from a packed tarball rather than a `file:` link. A link
resolves core's own `react` import to `packages/core/node_modules/react` while the app's components
resolve to their own copy: two real paths, two React instances, and a null hook dispatcher the moment
a client component is server-rendered. A tarball extracts into the app's `node_modules`, so everything
walks up to one React — and it is what `npm i @rshono/core` actually does.

### Load generator

`load.mjs` drives requests from Node worker threads rather than shelling out to `oha` or
`bombardier`, so it is always present and behaves the same everywhere. It handicaps all three targets
identically, which is what a comparison needs; its absolute rps is a lower bound on what the servers
can do. When the spread across targets drops under 5% the report says so, because at that point the
driver is the thing being measured.

## Adding a fourth framework

1. Implement `spec/APP_SPEC.md` under `apps/<id>/`, including `src/touch-marker.ts` (`build.mjs`
   edits it to force an incremental rebuild) and a `src/generated/data.json` that `setup:apps` fills in.
2. Bind the server to `127.0.0.1` and honour `PORT` — the harness probes IPv4, and a server that
   binds `::1` only looks like a server that never started.
3. Add an entry to `TARGETS` in `harness/lib/targets.mjs`.
4. Run `pnpm bench:payload <id>` and fix whatever the spec checks flag before trusting any timing.
