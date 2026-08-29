---
title: Benchmarks
description: One app built three ways — rshono, Next.js and TanStack Start — measured on payload bytes, build time, cold start and install size.
---

_Generated from `packages/benchmarks` on 2026-08-29 (build, payload, coldstart, load, devstart). One run, one machine. Regenerate with
`pnpm --filter @rshono/benchmarks bench` and `pnpm --filter @rshono/benchmarks site:publish`._

## Environment

| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Machine  | Apple M1 · 8 cores · 16 GB                             |
| Platform | darwin 25.5.0 arm64                                    |
| Node     | v22.22.2                                               |
| CI       | no — laptop numbers, treat spreads under ~10% as noise |

### Versions

React version skew across the three is unavoidable — Next vendors its own copy — so it is reported rather than hidden. A render-path difference of a few percent is more likely this than the framework.

| Package                   | rshono      | Next.js | TanStack Start |
| ------------------------- | ----------- | ------- | -------------- |
| `react`                   | 19.2.8      | 19.2.8  | 19.2.8         |
| `react-dom`               | 19.2.8      | 19.2.8  | 19.2.8         |
| `@rshono/core`            | 1.0.0-rc.17 | —       | —              |
| `hono`                    | 4.13.5      | —       | —              |
| `@rspack/core`            | 2.2.0       | —       | —              |
| `react-server-dom-rspack` | 0.1.0       | —       | —              |
| `next`                    | —           | 16.2.12 | —              |
| `@tanstack/react-start`   | —           | —       | 1.168.33       |
| `@tanstack/react-router`  | —           | —       | 1.170.18       |
| `vite`                    | —           | —       | 7.3.6          |

## Initial-load payload

Brotli-compressed bytes the browser is committed to fetching before the route is interactive: the document, the inline flight payload, and every statically referenced script and stylesheet. Compression is applied by the harness, identically for all three.

### `/` — prerendered

| Metric              | rshono           | Next.js            | TanStack Start    |
| ------------------- | ---------------- | ------------------ | ----------------- |
| Document (br)       | 875 B            | 1.7 kB             | 1.1 kB            |
| Inline script (raw) | 2.3 kB           | 5.7 kB             | 1.3 kB            |
| External JS (br)    | 58.5 kB · 1 file | 160.0 kB · 9 files | 97.2 kB · 2 files |
| CSS (br)            | 657 B · 1        | 615 B · 1          | 611 B · 1         |
| **Total (br)**      | **60.0 kB**      | **162.3 kB**       | **98.8 kB**       |
| Total (raw)         | 222.4 kB         | 627.8 kB           | 356.6 kB          |
| Requests            | 3                | 11                 | 4                 |
| Spec checks         | ✓                | ✓                  | ✓                 |

### `/ssr` — dynamic

| Metric              | rshono           | Next.js            | TanStack Start    |
| ------------------- | ---------------- | ------------------ | ----------------- |
| Document (br)       | 4.3 kB           | 5.2 kB             | 5.3 kB            |
| Inline script (raw) | 35.1 kB          | 38.9 kB            | 37.4 kB           |
| External JS (br)    | 58.5 kB · 1 file | 160.0 kB · 9 files | 97.0 kB · 2 files |
| CSS (br)            | 657 B · 1        | 615 B · 1          | 611 B · 1         |
| **Total (br)**      | **63.5 kB**      | **165.8 kB**       | **102.9 kB**      |
| Total (raw)         | 267.6 kB         | 673.4 kB           | 404.3 kB          |
| Requests            | 3                | 11                 | 4                 |
| Spec checks         | ✓                | ✓                  | ✓                 |

### `/interactive` — dynamic

| Metric              | rshono            | Next.js             | TanStack Start    |
| ------------------- | ----------------- | ------------------- | ----------------- |
| Document (br)       | 2.8 kB            | 3.7 kB              | 3.8 kB            |
| Inline script (raw) | 13.4 kB           | 17.6 kB             | 15.7 kB           |
| External JS (br)    | 59.7 kB · 4 files | 160.9 kB · 10 files | 98.5 kB · 4 files |
| CSS (br)            | 657 B · 1         | 615 B · 1           | 611 B · 1         |
| **Total (br)**      | **63.1 kB**       | **165.2 kB**        | **102.9 kB**      |
| Total (raw)         | 238.4 kB          | 644.7 kB            | 376.6 kB          |
| Requests            | 6                 | 12                  | 6                 |
| Spec checks         | ✓                 | ✓                   | ✓                 |

### `/api/health` — json

| Metric              | rshono        | Next.js       | TanStack Start |
| ------------------- | ------------- | ------------- | -------------- |
| Document (br)       | 32 B          | 32 B          | 32 B           |
| Inline script (raw) | 0 B           | 0 B           | 0 B            |
| External JS (br)    | 0 B · 0 files | 0 B · 0 files | 0 B · 0 files  |
| CSS (br)            | 0 B · 0       | 0 B · 0       | 0 B · 0        |
| **Total (br)**      | **32 B**      | **32 B**      | **32 B**       |
| Total (raw)         | 28 B          | 28 B          | 28 B           |
| Requests            | 1             | 1             | 1              |
| Spec checks         | ✓             | ✓             | ✓              |

## Build

Median of 3 trials. Cold clears the framework's cache directory first; warm keeps it and touches one source file the interactive route imports.

| Metric        | rshono     | Next.js    | TanStack Start |
| ------------- | ---------- | ---------- | -------------- |
| Cold build    | 845ms ±64% | 3.00s ±31% | 3.01s ±16%     |
| Warm rebuild  | 651ms ±11% | 3.02s ±0%  | 3.05s ±2%      |
| Build output  | 4.16 MB    | 5.92 MB    | 1.57 MB        |
| Output files  | 19         | 198        | 30             |
| Server bundle | 771.5 kB   | —          | 804.3 kB       |

## Cold start

Process spawn to first answered request, fresh process each trial. Not a real serverless cold start — no container, no network — it isolates the JavaScript the framework has to parse and run before it can respond.

| Metric                 | rshono    | Next.js   | TanStack Start |
| ---------------------- | --------- | --------- | -------------- |
| Spawn → first response | 213ms ±2% | 328ms ±0% | 530ms ±0%      |
| Server bundle          | 771.5 kB  | —         | 804.3 kB       |

## Throughput

32 connections, 8s per route after a 2s warmup, driven by the harness's own Node load generator.

**Read this as a floor check, not a headline.** All three render through the same React and stream through the same react-dom, so a large gap would mean an HTTP layer is pathological rather than that one framework renders faster. The in-process driver is identically handicapping for all three, and its absolute rps is a lower bound. `/api/health` is the informative row: no React on the path, so it is router and response construction alone.

All three put React server components on the request path for `/ssr` and `/interactive` (APP_SPEC.md rule 8), so those two rows compare implementations of one architecture. They are not a perfect match: rshono and Next encode and decode the whole document, TanStack Start only the route body its RSC helpers wrap — its shell and nav stay on the cheaper non-RSC path. The flight round trip dominates both rows; on `/ssr` it is roughly 85% of the request.

### `/`

| Metric       | rshono | Next.js | TanStack Start |
| ------------ | ------ | ------- | -------------- |
| Requests/sec | 51,348 | 6,495   | 5,045          |
| p50          | 0.56ms | 4.47ms  | 5.85ms         |
| p99          | 1.22ms | 9.51ms  | 15ms           |
| Errors       | 0      | 0       | 0              |

### `/ssr`

| Metric       | rshono | Next.js | TanStack Start |
| ------------ | ------ | ------- | -------------- |
| Requests/sec | 604    | 305     | 287            |
| p50          | 52ms   | 105ms   | 110ms          |
| p99          | 103ms  | 131ms   | 215ms          |
| Errors       | 0      | 0       | 0              |

### `/interactive`

| Metric       | rshono | Next.js | TanStack Start |
| ------------ | ------ | ------- | -------------- |
| Requests/sec | 2,076  | 651     | 985            |
| p50          | 14ms   | 45ms    | 29ms           |
| p99          | 28ms   | 63ms    | 58ms           |
| Errors       | 0      | 0       | 0              |

### `/api/health`

| Metric       | rshono | Next.js | TanStack Start |
| ------------ | ------ | ------- | -------------- |
| Requests/sec | 44,185 | 4,667   | 12,784         |
| p50          | 0.66ms | 6.39ms  | 2.10ms         |
| p99          | 1.41ms | 14ms    | 6.19ms         |
| Errors       | 0      | 0       | 0              |

### Memory

Resident memory of the whole process tree, and of the single largest process in it — which is the server itself in all three. The tree total carries whatever `npm run start` left running and double-counts pages the processes share, so the **server** row is the one to compare.

**None of these are retained-memory figures.** RSS is a high-water mark that includes garbage V8 has not collected yet, and V8 sizes the old generation against the *allocation rate* — so under a fixed-duration load the fastest server churns the most and grows the largest heap. On this app a forced GC returned 362 MB of the 472 MB an uncapped `/api/health` run reported. All three are therefore given the same old-space budget (`--max-old-space-size=256`), which is what makes the rows comparable; the per-route sequence is there so a plateau is distinguishable from a climb. Retention per request measured on the rshono app, after a full GC, was under 20 B — a leak is not what these numbers show.

| Metric                  | rshono                                        | Next.js                                       | TanStack Start                                |
| ----------------------- | --------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| RSS idle — tree         | 161.23 MB (2 procs)                           | 160.72 MB (2 procs)                           | 242.47 MB (3 procs)                           |
| RSS idle — server       | 96.00 MB                                      | 95.33 MB                                      | 159.50 MB                                     |
| RSS after load — tree   | 243.39 MB (2 procs)                           | 265.45 MB (2 procs)                           | 295.78 MB (3 procs)                           |
| RSS after load — server | 180.95 MB                                     | 203.13 MB                                     | 215.78 MB                                     |
| RSS per route — server  | 129.36 MB → 174.08 MB → 180.95 MB → 180.95 MB | 141.42 MB → 192.20 MB → 202.25 MB → 203.13 MB | 192.16 MB → 209.63 MB → 215.55 MB → 215.78 MB |
| Requests served         | 785,833                                       | 97,040                                        | 152,935                                       |
| Churn per 1k requests   | 110.7 kB                                      | 1.11 MB                                       | 376.8 kB                                      |

## Dev server startup

`dev` command to a served `/interactive` — which every one of these compiles lazily, so it includes compiling a route with three client components rather than just binding a socket. Cold clears the dev cache first.

HMR round-trip is the other number worth having here and is not measured: it needs a browser driving the page to assert the patch arrived.

| Metric         | rshono    | Next.js   | TanStack Start |
| -------------- | --------- | --------- | -------------- |
| Cold dev start | 522ms ±8% | 1.48s ±1% | 2.22s ±3%      |
| Warm dev start | 529ms ±1% | 1.40s ±2% | 2.14s ±0%      |

## Footprint

A production-only install (`--omit=dev`) into a throwaway directory, and the application code the spec took to express.

| Metric              | rshono   | Next.js   | TanStack Start |
| ------------------- | -------- | --------- | -------------- |
| Prod install size   | 72.82 MB | 291.09 MB | 57.47 MB       |
| Packages installed  | 16       | 22        | 101            |
| Direct dependencies | 4        | 3         | 4              |
| App source files    | 16       | 16        | 18             |
| App source lines    | 462      | 458       | 670            |
