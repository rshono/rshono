# Contributing

Thanks for looking. This file covers the things about the repository that are not obvious from reading it —
the parts that will otherwise cost you an afternoon.

## Setup

```bash
pnpm install
pnpm --filter @rshono/core build   # the apps import dist/, so nothing else works until this has run
```

Node **≥ 22.18** and pnpm **11** (the version is pinned in `packageManager`; Corepack will pick it up).

## Layout

| Path                  | What it is                                              |
| --------------------- | ------------------------------------------------------- |
| `packages/core`       | the framework, and the `rshono` CLI                     |
| `packages/create`     | the scaffolder                                          |
| `packages/benchmarks` | rshono vs Next.js vs TanStack Start                     |
| `apps/website`        | rshono.com, built with rshono                           |
| `apps/testbed`        | a deliberately over-configured app the e2e suite drives |

The fixture apps under `packages/core/test/fixtures/*` are real workspace members, so they resolve
`@rshono/core` through `node_modules` exactly the way an installed app does — which is half of what they are
there to check.

## Things that will surprise you

- **Two TypeScripts.** `packages/core` builds with TypeScript 7; the root pins 6 because
  `typescript-eslint` accepts nothing above `<6.1.0`. So **ESLint lints with TS 6 and the build compiles with
  TS 7**, and `eslint --fix` can produce code the build then rejects. Always run `pnpm --filter @rshono/core
typecheck` after `pnpm lint:fix`.
- **`@rspack/core` and `react-server-dom-rspack` are pinned exactly, in `pnpm-workspace.yaml` overrides as
  well as in the manifests.** RSC internals are coupled across the two compilers and the two React builds; a
  split resolution fails inside minified React at render time. Don't bump them casually — a bump is a
  release, and the whole suite is the check.
- **The apps import the framework through its published `exports`, which point at `dist/`.** A source change
  is invisible to them until `pnpm --filter @rshono/core build` has run. `pnpm dev` runs `tsc --watch` for
  exactly this.
- **`rshono dev` and `rshono build` write to different directories** (`.rshono/` and `dist/`) so that running
  one cannot delete the chunks the other is serving. If a dev server seems to be serving stale output, check
  that a build did not just run in another terminal.
- **Comments carry the reasoning.** Most non-obvious lines in this codebase have a comment saying why, and
  several say what was tried first. If you change one of those lines, the comment is part of the change.

## Testing

```bash
pnpm lint                              # one ESLint config, every package
pnpm --filter @rshono/core typecheck
pnpm --filter @rshono/core test        # unit + minimal-app + postcss + dev + production e2e + deploy targets
pnpm --filter @rshono/core test:browser  # Playwright: hydration, soft nav, actions, boundaries
pnpm --filter @rshono/create test      # every combination of scaffolder options, asserted in memory
CREATE_RSHONO_E2E=1 pnpm --filter @rshono/create test   # …and really installed and built
```

CI runs all of it on Ubuntu and Windows, on Node 22 and 24. Windows is in the matrix because the framework
resolves and compares absolute paths in several places, which is exactly where it breaks.

A change to request handling, routing, the env split or a deploy target wants a test. The suite is
structured by what a test needs in order to observe something — `test/unit.test.mjs` for anything pure,
`test/prod.test.mjs` for anything a real production server can show over HTTP, `test/browser/` only for what
needs a live client runtime. Reach for the cheapest one that can actually see the behaviour.

## Releasing

The two published packages share a version and ship together. A `v*` tag is what publishes them — nothing
is published from a laptop, so the npm tarball always carries a provenance attestation pointing back at the
commit and workflow that built it.

```bash
pnpm version:set 1.0.0            # bumps both manifests, no tag
# update CHANGELOG.md: move Unreleased under the new heading
git commit -am "Release v1.0.0"
git tag v1.0.0
git push --follow-tags
```

`.github/workflows/release.yml` re-runs lint, typecheck and the whole suite against the tagged tree, refuses
to publish if the tag and the manifests disagree, publishes with `--provenance`, and opens a draft release.

## Pull requests

Branch off `main`, keep the change to one thing, and say in the description what would have gone wrong
without it. If a fix is subtle, the test that fails before it is the most useful thing in the diff.

`pnpm format` runs Prettier over everything.
