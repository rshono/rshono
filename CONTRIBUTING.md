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
  release, and the whole suite is the check. Move the manifests, the overrides and the lockfile in one commit:
  a manifest pin is what a consumer resolves and an override is what this repo resolves, so drifting them
  makes the suite green against a resolution nobody can install. `pnpm check:pins` is what holds them
  together, and it runs in CI and again before a release.
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
pnpm check:pins                        # the exact pins agree: manifests, overrides, lockfile, node_modules
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

The two published packages share a version and ship together. Releases are cut from a laptop; nothing on CI
publishes. Bump, changelog, commit, tag:

```bash
pnpm version:set 1.0.0            # bumps both manifests, no tag
# update CHANGELOG.md: move Unreleased under the new heading
git commit -am "Release v1.0.0"
git tag -a v1.0.0 -m v1.0.0       # -a matters, see below
```

The `-a` is not decoration: `--follow-tags` pushes annotated tags only, so a lightweight `git tag v1.0.0`
leaves the tag on your machine while the branch pushes without it. The tag also has to exist before the
publish, because the script refuses to release without one at HEAD.

Then upload:

```bash
pnpm release                      # --tag rc keeps a prerelease off the latest dist-tag
pnpm release:dry                  # every check, both packages packed, nothing uploaded
pnpm release --help               # --otp, --skip-tests, --any-branch
```

`scripts/release.mjs` applies every gate itself, because nothing else is standing between a mistake and the
registry: on main, no uncommitted changes to tracked files, both manifests on the same version, an annotated
`v<version>` tag at HEAD, that version not already published, and the whole suite green. Then it hands the
terminal to `pnpm -r publish` so npm's two-factor prompt reaches you. Pushing the tag and drafting the release
notes stay yours — it prints both commands when it finishes:

```bash
git push --follow-tags
gh release create v1.0.0 --title v1.0.0 --notes-file CHANGELOG.md --draft
```

Nothing published this way carries an npm provenance attestation. That signature is minted from a CI runner's
OIDC token, so it is the one thing a laptop release gives up.

## Pull requests

Branch off `main`, keep the change to one thing, and say in the description what would have gone wrong
without it. If a fix is subtle, the test that fails before it is the most useful thing in the diff.

`pnpm format` runs Prettier over everything.
