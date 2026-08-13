/**
 * ESLint with type-aware rules, which is the reason to reach for it over a linter that only reads syntax.
 *
 * **This app's `typescript` is pinned below the one rshono is built with.** typescript-eslint reads the
 * compiler API directly and accepts nothing from TypeScript 6.1 up, so `package.json` holds the newest
 * version it takes. Your editor and `tsc` are unaffected — rshono's declarations compile the same under
 * either — but the rules below reason about your program through the *older* compiler.
 *
 * The practical consequence: `lint:fix` can rewrite code that `tsc` then rejects. Run `typecheck` after it,
 * not instead of it. When typescript-eslint widens its peer range, drop the `typescript` pin from
 * `package.json` and this note with it.
 */
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Build output, all of it generated: `dist/` from `rshono build`, `.rshono/` from `rshono dev`, and
  // whatever the deploy target assembles beside them. Without this, linting after a dev run reports on
  // bundles rather than on anything you wrote.
  { ignores: ['dist/**', '.rshono/**', '.wrangler/**', '.vercel/**', '.netlify/**'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  reactHooks.configs.flat['recommended-latest'],
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ['**/*.{js,mjs,cjs}'], extends: [tseslint.configs.disableTypeChecked] },
);
