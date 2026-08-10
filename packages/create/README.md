<p align="center">
  <img src="https://raw.githubusercontent.com/rshono/rshono/main/logo.svg" alt="" width="72" height="72" />
</p>

<h1 align="center">@rshono/create</h1>

<p align="center">
  Scaffolds a new <a href="https://github.com/rshono/rshono">rshono</a> app — Hono + Rspack + React Server Components.
</p>

```bash
npx  @rshono/create@latest my-app
pnx  @rshono/create my-app
bunx @rshono/create my-app
yarn create @rshono my-app
```

The package manager that ran it is the one the project gets: it is read from `npm_config_user_agent`, which
every one of these runners sets, and it is used for the install, written into `packageManager` for Corepack,
and used in every command the closing summary prints. Nothing asks you which one you meant.

Yarn is the odd row out because `yarn dlx` is Berry-only, while `yarn create` works in either — and `pnx`
arrived in pnpm 10.16, before which it is `pnpm dlx`.

## The questions

Six, each with a default, and each answerable by a flag instead:

| Question              | Default            | Flag                                                           |
| --------------------- | ------------------ | -------------------------------------------------------------- |
| Where should it go?   | `my-rshono-app`    | first positional argument, or `.`                              |
| Where is it deployed? | `node`             | `-d, --deploy node\|cloudflare\|vercel\|aws-lambda`            |
| Styling               | plain CSS          | `--tailwind` / `--no-tailwind`                                 |
| Formatting & linting  | Prettier + oxlint  | `--quality prettier-oxlint\|prettier-eslint\|biome\|oxc\|none` |
| Install dependencies? | yes                | `--no-install`                                                 |
| Initialize git?       | yes, unless nested | `--no-git`                                                     |

Plus `--formatter prettier\|biome\|oxfmt\|none` and `--linter oxlint\|eslint\|biome\|none` to set either half
of the quality preset on its own, `--pm npm\|pnpm\|yarn\|bun` to override the package manager that was
detected, `--force` to scaffold into a directory that is not empty, `--dry-run` to see the file list and write
nothing, and `-y` to take the defaults for everything not given. **A non-interactive terminal implies `-y`**,
so this is one command in CI or from an agent:

```bash
npx @rshono/create@latest my-app -y --deploy cloudflare --tailwind --quality biome
```

The deploy targets, and the deploy command each one prints, are generated from the framework's own presets —
a target added to rshono appears here with no edit.

## What you get

```
package.json            scripts, and the exact dependency versions rshono is tested against
rshono.config.ts        the chosen deploy target; every other setting takes its default
tsconfig.json           strict, with @/* → ./src/*
.env                    committed defaults; secrets go in .env.local
.gitignore              plus whatever each chosen feature adds, under a heading naming it
README.md               the app's own commands, layout and deploy step
AGENTS.md               where an agent finds the framework docs; CLAUDE.md imports it
public/                 favicon.svg, robots.txt
src/routes.ts           one page, a 404 and a 500
src/server.ts           error reporting, trailing-slash and old-path redirects, AppType
src/components/         layout, home, 404, 500
src/styles.css          element-level CSS, or the Tailwind entry
src/env.d.ts            the CSS-import declaration the compiler needs
pnpm-workspace.yaml     pnpm only: which dependency install scripts this app runs (none of them)
```

Scaffolding runs the install and nothing else — no formatter, no linter. The templates are written to satisfy
every formatter option at its configured width, so a fresh project passes its own `format:check` without a
write pass first.

`react` and `react-dom` are pinned **exactly**, at the versions the framework is tested against, and those
pins are generated from rshono's own manifest. That is not tidiness: the RSC runtime reaches into React's
internals, and an app installed with npm or bun has no workspace overrides to keep a single copy of it.

## Two things worth knowing

**The ESLint preset pins TypeScript 6.** Linting TypeScript with ESLint means `typescript-eslint`, which reads
the compiler API directly rather than through a stable interface, so its peer range is
`typescript >=4.8.4 <6.1.0` — below the TypeScript rshono is built and tested against. An app that chooses
ESLint therefore gets `typescript ~6.0.3`, the newest that range allows: `npm install` would otherwise fail
outright on the conflict, and forcing past it hands you a linter running against a compiler API it was never
built for. The framework's declarations compile identically under either version, which is what makes this the
app's pin and not the framework's — every other preset leaves TypeScript alone. What you trade for type-aware
rules is a compiler one major behind, and the JavaScript implementation rather than the native one, so
`typecheck` on a large app is several times slower. When upstream widens the range, the pin in
`features/quality.ts` is the only thing to delete.

**Tailwind is four packages, a `postcss.config.mjs` and one rule in `rshono.config.ts`.** rshono compiles CSS
natively and has no PostCSS in it — that is deliberate, and it means an app that wants a plugin chain brings
its own, through the `rspack` hook. The overlay writes all of it, with a comment saying what to delete to go
back to plain CSS.

## Adding an option

Every difference between two scaffolds is a `Feature` — files to overlay, dependencies, scripts,
`.gitignore` lines, a closing note. Nothing in the generator knows what Tailwind is. So an option is three
edits and no new machinery:

1. A `Feature` in `src/features/` — `templates/<id>` for the files it brings, plus whatever it adds to the
   manifest.
2. The template directory itself, as **real files**. They are copied over the base, so an overlay replaces a
   file rather than patching it, and template files stay valid TypeScript that an editor can check. `_name`
   becomes `.name` on write, because npm strips a literal `.gitignore` out of a published tarball.
3. A prompt in `src/cli.ts`, if it deserves a question of its own — and a flag, which it always does.

`plan(answers, pm)` is pure: answers in, a `Map` of path → contents out, no directory touched. That is what
makes the whole matrix of options testable in milliseconds (`test/plan.test.mjs`) and `--dry-run` free. It is
also exported, for a tool that wants to scaffold without the prompts:

```ts
import { plan, writePlan } from '@rshono/create';
```

## Development

```bash
pnpm --filter @rshono/create build       # codegen, then one bundled dist/cli.mjs with no runtime deps
pnpm --filter @rshono/create test        # builds, then the plan matrix and the CLI — seconds, no installs
CREATE_RSHONO_E2E=1 pnpm --filter @rshono/create test   # also: pack, install and build real apps
```

`plan.test.mjs` is the fast one — the whole matrix of answers in memory, no directory touched.
`cli.test.mjs` spawns the real bin against temp directories, which is where argument parsing and the refusal
to overwrite somebody's files are checked. `e2e.test.mjs` is the opt-in one, and the only one that installs
anything.

`src/generated/framework.ts` — the rshono version, the Node range, the dependency pins and the deploy target
list — is written by `scripts/codegen.mjs` from `packages/core`, so `pnpm --filter @rshono/create codegen` is
what picks up a change there.

`@clack/prompts` (MIT) is bundled rather than depended on, so `npx @rshono/create` downloads one tarball
before it can ask its first question.
