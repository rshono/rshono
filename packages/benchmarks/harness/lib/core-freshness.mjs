/**
 * Proves the rshono app is measuring the `@rshono/core` in this checkout, not an older one. The app installs
 * core from `.pack/rshono-core.tgz` (see install.mjs), and nothing re-packs that except `setup:apps` — so every
 * `bench` after a change to packages/core would otherwise measure whatever was packed last.
 *
 * The comparison is over file *contents*, not the version in `package.json`: npm writes that field from the
 * lockfile rather than the tarball, so a re-pack at the same path leaves the old version over a new `dist`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A content hash of every file under `dir`, path-sensitive and order-independent. `null` if absent.
 *
 * Dotfiles are skipped on both sides: npm refuses to pack several of them whatever `files` says, so counting
 * one would put it in the workspace hash and never in the installed one — and the two could never agree.
 */
function hashTree(dir) {
  if (!existsSync(dir)) return null;
  const hash = createHash('sha256');
  const walk = (absolute, relative) => {
    const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = path.join(absolute, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child, rel);
      else if (entry.isFile()) hash.update(rel).update(readFileSync(child));
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

/**
 * `null` when the installed core matches the workspace build, otherwise a sentence saying how it
 * doesn't. Compares `dist`, which is the whole of what the tarball ships that a benchmark can execute.
 */
export function coreStaleness(benchmarksRoot, appDir) {
  const workspace = path.resolve(benchmarksRoot, '..', 'core', 'dist');
  const installed = path.join(appDir, 'node_modules', '@rshono', 'core', 'dist');

  if (!existsSync(workspace)) return 'packages/core has not been built, so there is nothing to compare against.';
  if (!existsSync(installed)) return 'the app has no @rshono/core installed.';
  return hashTree(workspace) === hashTree(installed) ? null : 'the app has an older @rshono/core installed than this checkout builds.';
}

/**
 * Stops the stage rather than letting it measure the wrong code. Prints and exits rather than throwing, unlike
 * the rest of `resolveTargets`: the whole value is the two lines saying what to run.
 */
export function assertCoreFresh(benchmarksRoot, targets) {
  const app = targets.find((t) => t.id === 'rshono');
  if (!app) return;
  const stale = coreStaleness(benchmarksRoot, app.dir);
  if (!stale) return;
  console.error(
    [
      `✗ Refusing to benchmark a stale @rshono/core — ${stale}`,
      '  Every number this run produced would describe code that is not in the working tree.',
      '',
      '  Fix:  pnpm --filter @rshono/benchmarks setup:apps',
      '        (rebuilds core, re-packs it, reinstalls, and drops the rshono build that linked the old one)',
      '  Then: pnpm --filter @rshono/benchmarks bench      — or rebuild just the app before a single stage',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
