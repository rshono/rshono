/**
 * Installs each benchmark app into its own isolated node_modules.
 *
 * The apps are deliberately *not* pnpm workspace members: the root `pnpm-workspace.yaml` pins react, react-dom
 * and @rspack/core with `overrides`, and forcing those onto Next and TanStack Start would measure a configuration
 * nobody ships. Isolated installs are also what make footprint.mjs's numbers mean anything.
 */
import { existsSync } from 'node:fs';
import { mkdir, copyFile, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from './lib/proc.mjs';
import { resolveTargets, ROOT, FIXTURES } from './lib/targets.mjs';
import { ms } from './lib/stats.mjs';

// The one runner that must not demand a fresh core: rebuilding and re-packing it is what this does.
const targets = resolveTargets(process.argv.slice(2), { requireFreshCore: false });
const monorepoRoot = path.resolve(ROOT, '..', '..');
const coreDir = path.join(monorepoRoot, 'packages', 'core');
const packDir = path.join(ROOT, '.pack');

// AGENTS.md: packages/core has to be built before anything consumes it through node_modules.
console.log('› building @rshono/core');
const core = await run('pnpm', ['--filter', '@rshono/core', 'build'], { cwd: monorepoRoot, label: 'core build' });
if (core.code !== 0) process.exit(1);
console.log(`  ✓ ${ms(core.ms)}`);

/**
 * The rshono app installs @rshono/core from a packed tarball rather than a `file:` link: a link resolves core's
 * own `react` to packages/core/node_modules/react while the app's components resolve to the app's copy — two
 * React instances, and a null hook dispatcher the moment a client component is SSR'd. A tarball is extracted
 * into the app's node_modules, so everything walks up to one react, and it is what `npm i @rshono/core` does.
 */
console.log('› packing @rshono/core');
await rm(packDir, { recursive: true, force: true });
await mkdir(packDir, { recursive: true });
const packed = await run('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], { cwd: coreDir, label: 'npm pack' });
if (packed.code !== 0) process.exit(1);
const tarball = (await readdir(packDir)).find((f) => f.endsWith('.tgz'));
if (!tarball) {
  console.error('  ✗ npm pack produced no tarball');
  process.exit(1);
}
await copyFile(path.join(packDir, tarball), path.join(packDir, 'rshono-core.tgz'));
console.log(`  ✓ ${tarball} → .pack/rshono-core.tgz`);

/**
 * Drops the `@rshono/core` entry from the app's lockfile, so npm re-resolves the tarball instead of trusting what
 * it recorded last time.
 *
 * Deleting `node_modules/@rshono` is not enough, and leaves something worse than a stale install: the lockfile
 * pins the *previous* tarball's integrity hash at a path whose contents changed, so npm reifies a **merge** —
 * new files written, files the new core no longer ships kept, and the old `version` left in `package.json`.
 *
 * Only this entry is removed; pinning react and the rest is what keeps the three apps comparable run to run.
 */
async function forgetLockedTarball(lockPath) {
  if (!existsSync(lockPath)) return;
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  // Nothing recorded yet — leave the file untouched rather than rewriting it to identical bytes.
  if (!lock.packages?.['node_modules/@rshono/core'] && !lock.dependencies?.['@rshono/core']) return;
  delete lock.packages?.['node_modules/@rshono/core'];
  delete lock.dependencies?.['@rshono/core'];
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

let failed = false;
for (const target of targets) {
  // One fixture file, copied in rather than imported across roots: Rspack, Turbopack and Vite each
  // have their own opinion about a specifier that escapes the project directory, and the benchmark
  // has no business discovering which. Gitignored — fixtures/data.json stays the only source.
  const generated = path.join(target.dir, 'src', 'generated');
  await mkdir(generated, { recursive: true });
  await copyFile(FIXTURES, path.join(generated, 'data.json'));

  console.log(`› installing ${target.id}`);
  // A rebuilt tarball has to replace whatever is already extracted, and `npm ci` will not do that
  // from a lockfile that records the old integrity hash.
  const tarballDep = target.id === 'rshono';
  const lock = path.join(target.dir, 'package-lock.json');
  if (tarballDep) {
    await rm(path.join(target.dir, 'node_modules', '@rshono'), { recursive: true, force: true });
    await forgetLockedTarball(lock);
  }
  const args = existsSync(lock) && !tarballDep ? ['ci'] : ['install'];
  const res = await run('npm', [...args, '--no-audit', '--no-fund'], { cwd: target.dir, label: `${target.id} npm ${args[0]}` });
  if (res.code !== 0) {
    failed = true;
    continue;
  }
  console.log(`  ✓ npm ${args[0]} in ${ms(res.ms)}`);

  /*
   * The build that linked the *previous* core must not outlive it. `rshono build` inlines core into `dist`, and
   * the freshness guard only compares the *installed* core — so `setup:apps` followed by a single stage would
   * pass the guard and then measure a bundle compiled against the core that was just replaced. Deleting `dist`
   * costs nothing on a full run, where `build.mjs` clears it for the cold trials anyway.
   */
  if (tarballDep) {
    await rm(path.join(target.dir, 'dist'), { recursive: true, force: true });
    console.log('  • removed dist/ — it linked the previous core; rebuild before measuring');
  }
}

process.exit(failed ? 1 : 0);
