import type { Feature } from './features/index.js';
import type { Answers } from './options.js';
import type { PackageManager } from './pm.js';
import { BASE_SCRIPTS } from './scripts.js';
import { FRAMEWORK_DEPS, NODE_ENGINE, RSHONO_RANGE } from './versions.js';

/** Field order in the emitted file — the conventional reading order, and stable so snapshots are too. */
const FIELD_ORDER = ['name', 'version', 'private', 'type', 'engines', 'packageManager', 'scripts', 'dependencies', 'devDependencies'];

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * pnpm's settings for the new app, written only when a feature has something to put in them. `null`
 * means there is nothing to say, so no file is written.
 *
 * It exists for one field, `allowBuilds`. pnpm fails an install — and every `pnpm dev` after it —
 * until the project has said whether a dependency's install script should run. Nothing rshono itself
 * installs has one, so most apps get no file; the packages that do (wrangler's esbuild and workerd)
 * declare their answer on the feature that brings them.
 *
 * A file rather than a `pnpm` key in `package.json`, which pnpm 11 no longer reads.
 */
export function buildPnpmSettings(features: Feature[]): string | null {
  const allowBuilds: Record<string, boolean> = {};
  for (const feature of features) Object.assign(allowBuilds, feature.allowBuilds);
  const entries = Object.entries(sorted(allowBuilds));
  if (entries.length === 0) return null;

  return [
    '# Which dependencies may run an install script. pnpm runs none it has not been told about, and',
    '# fails the install rather than skip one quietly — so anything added later belongs here too.',
    '# `false` means the script was looked at: these ship their real binary as an optional dependency.',
    'allowBuilds:',
    ...entries.map(([name, allowed]) => `  ${name}: ${allowed}`),
    '',
  ].join('\n');
}

/**
 * Assembles `package.json` from the answers and whatever the selected features contribute.
 *
 * Dependencies are sorted by name and scripts are left in contribution order (the base ones, then each
 * feature's, in the order features were selected) — so two runs with the same answers produce byte-
 * identical output, which is what makes the generated manifest snapshot-testable.
 */
export function buildPackageJson(answers: Answers, features: Feature[], pm: PackageManager): string {
  const scripts: Record<string, string> = { ...BASE_SCRIPTS };
  const dependencies: Record<string, string> = {
    '@rshono/core': RSHONO_RANGE,
    hono: FRAMEWORK_DEPS.hono,
    react: FRAMEWORK_DEPS.react,
    'react-dom': FRAMEWORK_DEPS['react-dom'],
  };
  const devDependencies: Record<string, string> = {
    '@types/node': FRAMEWORK_DEPS['@types/node'],
    '@types/react': FRAMEWORK_DEPS['@types/react'],
    typescript: FRAMEWORK_DEPS.typescript,
  };

  for (const feature of features) {
    Object.assign(scripts, feature.scripts);
    Object.assign(dependencies, feature.dependencies);
    Object.assign(devDependencies, feature.devDependencies);
  }

  const manifest: Record<string, unknown> = {
    name: answers.packageName,
    version: '0.1.0',
    private: true,
    type: 'module',
    // Generated from the framework's own manifest, so the app's floor cannot drift below rshono's.
    engines: { node: NODE_ENGINE },
    scripts,
    dependencies: sorted(dependencies),
    devDependencies: sorted(devDependencies),
  };

  // Only when the environment told us the exact version: `packageManager` pins the tool for Corepack,
  // and a guess at the version is worse than leaving the field out.
  if (pm.version) manifest.packageManager = `${pm.name}@${pm.version}`;

  const ordered = Object.fromEntries(FIELD_ORDER.filter((field) => field in manifest).map((field) => [field, manifest[field]]));
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
