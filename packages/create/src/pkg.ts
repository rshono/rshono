import type { Feature } from './features/index.js';
import type { Answers } from './options.js';
import type { PackageManager } from './pm.js';
import { buildScripts } from './scripts.js';
import { FRAMEWORK_DEPS, NODE_ENGINE, RSHONO_RANGE } from './versions.js';

/** Field order in the emitted file — the conventional reading order, and stable so snapshots are too. */
const FIELD_ORDER = ['name', 'version', 'private', 'type', 'engines', 'packageManager', 'scripts', 'dependencies', 'devDependencies'];

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * pnpm's settings for the new app, or `null` when no feature has anything to put in them.
 *
 * It exists for one field, `allowBuilds`: pnpm fails an install until the project has said whether a
 * dependency's install script should run. Nothing rshono installs has one, so most apps get no file. A file
 * rather than a `pnpm` key in `package.json`, which pnpm 11 no longer reads.
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
 * Assembles `package.json` from the answers and whatever the selected features contribute. Dependencies are
 * sorted and scripts keep {@link buildScripts}'s order, so two runs with the same answers are byte-identical.
 */
export function buildPackageJson(answers: Answers, features: Feature[], pm: PackageManager): string {
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
    scripts: buildScripts(features),
    dependencies: sorted(dependencies),
    devDependencies: sorted(devDependencies),
  };

  // Only when the environment told us the exact version: this field pins the tool for Corepack, and a guess is
  // worse than leaving it out.
  if (pm.version) manifest.packageManager = `${pm.name}@${pm.version}`;

  const ordered = Object.fromEntries(FIELD_ORDER.filter((field) => field in manifest).map((field) => [field, manifest[field]]));
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
