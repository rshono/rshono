import { DEPLOY_TARGETS, type DeployTargetName } from './generated/framework.js';

export type { DeployTargetName };

export type Styling = 'css' | 'tailwind';

/*
 * The names each option accepts, spelled once: the types below are derived from them, the CLI validates its
 * flags against them and prints them in `--help`, and `pm.ts` recognises a package manager by them.
 */
export const FORMATTER_NAMES = ['prettier', 'biome', 'oxfmt', 'none'] as const;
export const LINTER_NAMES = ['oxlint', 'eslint', 'biome', 'none'] as const;
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

export type Formatter = (typeof FORMATTER_NAMES)[number];
/** ESLint comes with a TypeScript pin the others do not — see {@link QUALITY_PRESETS}. */
export type Linter = (typeof LINTER_NAMES)[number];
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

/**
 * Everything the generator needs to know. One prompt or flag per field, and every field has a default.
 *
 * Which package manager the app is for is *not* here: it reaches the generator as `plan`'s second argument,
 * because the same value drives the install and the printed commands.
 */
export interface Answers {
  /** An npm-safe package name, written into `package.json`. */
  packageName: string;
  deploy: DeployTargetName;
  styling: Styling;
  formatter: Formatter;
  linter: Linter;
}

export const DEPLOY_TARGET_NAMES: readonly DeployTargetName[] = DEPLOY_TARGETS.map((target) => target.name);

export function deployHint(name: DeployTargetName): string {
  return DEPLOY_TARGETS.find((target) => target.name === name)?.hint ?? '';
}

/**
 * The curated formatter/linter combinations the prompt offers. The two axes stay independent in
 * {@link Answers} — `--formatter` and `--linter` address them separately — but presenting them as one question
 * keeps nonsense combinations, like Biome formatting beside a second linter, out of the flow.
 *
 * The ESLint presets pin TypeScript 6 (`ESLINT_TYPESCRIPT` in `versions.ts`), which is all typescript-eslint
 * accepts. That is why ESLint is a preset a user picks rather than the default.
 */
export interface QualityPreset {
  id: string;
  label: string;
  hint: string;
  formatter: Formatter;
  linter: Linter;
}

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  {
    id: 'prettier-oxlint',
    label: 'Prettier + oxlint',
    hint: 'the conventional formatter, with a fast linter',
    formatter: 'prettier',
    linter: 'oxlint',
  },
  {
    id: 'prettier-eslint',
    label: 'Prettier + ESLint',
    hint: 'type-aware rules — pins TypeScript 6, which is all typescript-eslint accepts',
    formatter: 'prettier',
    linter: 'eslint',
  },
  { id: 'biome', label: 'Biome', hint: 'formatter and linter in one tool', formatter: 'biome', linter: 'biome' },
  { id: 'oxc', label: 'oxfmt + oxlint', hint: 'the oxc toolchain — fastest, newest', formatter: 'oxfmt', linter: 'oxlint' },
  { id: 'none', label: 'None', hint: 'add your own later', formatter: 'none', linter: 'none' },
];

/**
 * Turns whatever the user typed into a name npm will accept, or `null` when nothing usable is left.
 * Lowercasing and replacing runs of invalid characters covers the ordinary cases (`My App`, `my_app`).
 *
 * The promise is checked rather than assumed: the result goes through {@link isValidPackageName} on the way
 * out. It used to be spelled as a rule per character class here and the check made again by the caller, which
 * left the exported function able to return a name npm refuses — `_leading` was one, because a leading
 * underscore is stripped by npm's rule and not by this one.
 */
export function toPackageName(input: string): string | null {
  const trimmed = input
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!trimmed || trimmed === '.') return null;

  // A scoped name is a name, not a path: `@scope/pkg` stays whole. Anything else is a path, whose last
  // segment names the project.
  const scoped = /^@[^\\/]+[\\/][^\\/]+$/.test(trimmed);
  const base = scoped ? trimmed : (trimmed.split(/[\\/]/).filter(Boolean).pop() ?? '');
  if (!base) return null;

  const name = base
    .toLowerCase()
    .replace(/[\\/]/g, '/')
    .replace(/[^a-z\d\-._~/@]+/g, '-')
    // `_` alongside `-`: npm refuses a leading underscore too, and it is what `My_App` and `_internal` leave
    // behind once the invalid runs are replaced.
    .replace(/^[-_]+/, '')
    .replace(/-+$/, '');

  const trimmedName = name.slice(0, 214);
  return isValidPackageName(trimmedName) ? trimmedName : null;
}

/** npm's own rule, narrowed to what we ever generate: no uppercase, no leading dot or underscore. */
export function isValidPackageName(name: string): boolean {
  return /^(?:@[a-z\d\-*~][a-z\d\-*._~]*\/)?[a-z\d\-~][a-z\d\-._~]*$/.test(name) && name.length <= 214;
}
