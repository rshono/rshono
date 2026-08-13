import type { Formatter, Linter } from '../options.js';
import { ESLINT_TYPESCRIPT, TOOL_VERSIONS } from '../versions.js';
import type { Feature } from './types.js';

/**
 * The formatter and linter features. Biome answers to both slots and appears once, because `selectFeatures`
 * deduplicates by `id`.
 *
 * Each brings a pair of scripts, since the writing half and the CI half want different exit codes: `format`
 * rewrites and `format:check` fails, `lint:fix` rewrites and `lint` fails. Biome's `check` is both in one pass.
 */
const PRETTIER: Feature = {
  id: 'prettier',
  overlays: ['prettier'],
  devDependencies: { prettier: TOOL_VERSIONS.prettier },
  scripts: { format: 'prettier --write .', 'format:check': 'prettier --check .' },
};

const OXFMT: Feature = {
  id: 'oxfmt',
  overlays: ['oxfmt'],
  devDependencies: { oxfmt: TOOL_VERSIONS.oxfmt },
  scripts: { format: 'oxfmt .', 'format:check': 'oxfmt --check .' },
};

const OXLINT: Feature = {
  id: 'oxlint',
  overlays: ['oxlint'],
  devDependencies: { oxlint: TOOL_VERSIONS.oxlint },
  scripts: { lint: 'oxlint', 'lint:fix': 'oxlint --fix' },
};

/**
 * The one feature that changes a dependency the framework otherwise decides: typescript-eslint cannot be
 * installed alongside the TypeScript rshono is tested against, so an ESLint app pins the newest its peer range
 * accepts (see {@link ESLINT_TYPESCRIPT}). Its rules are type-aware — the reason to reach for ESLint at all —
 * so the config it ships hands the parser the whole program.
 */
const ESLINT: Feature = {
  id: 'eslint',
  overlays: ['eslint'],
  devDependencies: {
    eslint: TOOL_VERSIONS.eslint,
    '@eslint/js': TOOL_VERSIONS['@eslint/js'],
    'typescript-eslint': TOOL_VERSIONS['typescript-eslint'],
    'eslint-plugin-react-hooks': TOOL_VERSIONS['eslint-plugin-react-hooks'],
    typescript: ESLINT_TYPESCRIPT,
  },
  scripts: { lint: 'eslint .', 'lint:fix': 'eslint . --fix' },
  // The pin is invisible from the command line, and its consequence is not: the rules reason about the
  // program through an older compiler than the one that builds it, so a fix can produce code `tsc` rejects.
  // The generated eslint.config.mjs explains why; the README's table is where someone reads what to type.
  scriptHelp: { 'lint:fix': 'apply what it can — then run typecheck, see eslint.config.mjs' },
};

const BIOME: Feature = {
  id: 'biome',
  overlays: ['biome'],
  devDependencies: { '@biomejs/biome': TOOL_VERSIONS['@biomejs/biome'] },
  scripts: {
    format: 'biome format --write .',
    'format:check': 'biome format .',
    lint: 'biome lint .',
    'lint:fix': 'biome lint --write .',
    check: 'biome check .',
  },
};

const FORMATTERS: Record<Formatter, Feature | null> = {
  prettier: PRETTIER,
  oxfmt: OXFMT,
  biome: BIOME,
  none: null,
};

const LINTERS: Record<Linter, Feature | null> = {
  oxlint: OXLINT,
  eslint: ESLINT,
  biome: BIOME,
  none: null,
};

export function formatterFeature(formatter: Formatter): Feature | null {
  return FORMATTERS[formatter];
}

export function linterFeature(linter: Linter): Feature | null {
  return LINTERS[linter];
}
