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
