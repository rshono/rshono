import { FRAMEWORK_DEPS, NODE_ENGINE, RSHONO_VERSION } from './generated/framework.js';

/** Passed straight through, so everything generated from the framework reaches the rest of the package here. */
export { FRAMEWORK_DEPS, NODE_ENGINE, RSHONO_VERSION };

/** The framework range a scaffolded app gets. The two packages are released together, so this is ours. */
export const RSHONO_RANGE = `^${RSHONO_VERSION}`;

/**
 * Versions for the optional tooling the features can add — the one place in this package where a range is typed
 * by hand, because the framework declares none of these. Everything a scaffolded app needs to *run* rshono comes
 * from {@link FRAMEWORK_DEPS}, generated from rshono's own manifest.
 *
 * Caret ranges, not exact: these are the app's own dev tools, and a scaffold made six months from now should
 * pick up their patch releases.
 */
export const TOOL_VERSIONS = {
  tailwindcss: '^4.3.3',
  '@tailwindcss/postcss': '^4.3.3',
  // The pass Tailwind runs in, installed with it rather than with the framework.
  postcss: '^8.5.23',
  'postcss-loader': '^8.2.1',
  prettier: '^3.9.6',
  '@biomejs/biome': '^2.5.6',
  oxlint: '^1.76.0',
  oxfmt: '^0.61.0',
  eslint: '^10.8.0',
  // ESLint's recommended JavaScript rules, which typescript-eslint layers on rather than replaces, and the rules
  // of hooks — the one class of React mistake no type checker sees.
  '@eslint/js': '^10.0.1',
  'typescript-eslint': '^8.65.0',
  'eslint-plugin-react-hooks': '^7.1.1',
  wrangler: '^4.115.0',
} as const;

/**
 * The TypeScript an ESLint app pins in place of the framework's own — the one deliberate exception to
 * {@link FRAMEWORK_DEPS}.
 *
 * typescript-eslint reads TypeScript's compiler API directly, so it accepts `>=4.8.4 <6.1.0` and nothing above;
 * `~6.0.3` is the newest that satisfies it. rshono's declarations compile the same under either, which is what
 * makes this the app's business. When upstream widens its range, this constant is what to delete.
 */
export const ESLINT_TYPESCRIPT = '~6.0.3';
