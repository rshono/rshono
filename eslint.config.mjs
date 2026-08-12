import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * One flat config for the whole workspace. `eslint .` from the root lints every package; running it from
 * inside a package finds this file by walking up, so `pnpm --filter <pkg> lint` sees the same rules.
 *
 * Keep it the only config in the repo. ESLint 10 resolves the *nearest* config file to each linted file
 * rather than one config for the run, so an `eslint.config.mjs` left inside a package silently takes over
 * that subtree — including whatever its own `ignores` forgot.
 *
 * Type-aware rules are the reason to run ESLint here rather than a syntax-only linter: `projectService`
 * builds the same program `tsc` does — picking the nearest tsconfig.json to each file, which is what makes
 * a monorepo work without listing every project — so a rule can ask what a value actually *is*. An
 * unawaited promise, a `catch` that swallows an error, a `String()` around something that is not one.
 *
 * The cost is that ESLint needs TypeScript to answer, and `typescript-eslint` accepts `<6.1.0` while the
 * packages here build with 7. The root therefore devDepends on TypeScript 6 purely for the linter; every
 * package keeps its own 7 for `tsc`, and `pnpm run typecheck` remains the thing that decides whether the
 * code compiles. These rules only ever report what a 6.0 program can see. Drop the root `typescript` pin
 * when typescript-eslint widens its peer range.
 */
export default tseslint.config(
  {
    // ESLint's own default ignores cover node_modules and nothing else, so every build artifact below
    // would otherwise be linted as if you had written it.
    ignores: [
      '**/dist/**',
      '**/.rshono/**',
      '**/.wrangler/**',
      '**/.vercel/**',
      '**/.netlify/**',
      '**/.pack/**',
      // Benchmark subjects: separate apps the harness installs on demand, not workspace members. Their
      // node_modules exist only after `setup:apps`, so linting them fails on a fresh clone rather than
      // reporting anything about this repo.
      'packages/benchmarks/apps/**',
      'packages/benchmarks/results/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  // The rules of hooks: the one class of React mistake no type checker catches, and the reason a React
  // codebase wants a linter at all.
  reactHooks.configs.flat['recommended-latest'],

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },

  // Every plain-JavaScript file in the workspace runs in Node — CLI entry points, build scripts, the test
  // suites, the harness. None are in a TypeScript program, so the type-aware rules have nothing to run
  // against and would report each file as unconfigured.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  // Fixture apps and scaffolder templates are sources the framework compiles *at test time*, against
  // dependencies that are not installed where the files sit. They are still worth parsing for the syntax
  // and hooks rules; there is no program to type-check them against.
  {
    files: ['packages/*/test/fixtures/**', 'packages/create/templates/**'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Playwright specs are Node files whose `page.evaluate` callbacks are serialised and run in the page,
  // so browser globals are genuinely in scope for part of the file and Node globals for the rest.
  {
    files: ['packages/core/test/browser/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // Ambient declarations describe a surface this repo does not own: bundler globals, and an upstream
  // package that ships no types. `declare var` is the only way to state a mutable global, and `any` is
  // sometimes the honest transcription of a signature that really is unconstrained.
  {
    files: ['**/*.d.ts'],
    rules: { 'no-var': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },

  // An underscore prefix is how this codebase already marks a binding it must declare but does not use —
  // a positional parameter before the one that matters, a destructured key being omitted.
  {
    rules: {
      // `async` here is a contract, not an implementation detail. React requires a `'use server'` action to
      // be async, a server component is allowed to be, and the CLI's command handlers share one signature —
      // in all three the keyword is part of the shape the caller relies on, and whether the body happens to
      // await today says nothing about whether it may drop the keyword. The rule assumes otherwise.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
);
