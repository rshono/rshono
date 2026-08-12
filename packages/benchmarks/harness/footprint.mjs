/**
 * What the framework costs before a single request is served: the size of a production-only install, and how much
 * application code the spec took to express.
 *
 * The install goes into a throwaway directory from the app's package.json with devDependencies omitted, which is
 * what a deploy image contains. Slow — three real npm installs — so `run.mjs` skips it unless passed --footprint.
 *
 * For rshono specifically: `@rspack/core` is in core's `dependencies`, so the bundler lands in a production
 * install. That is a real cost and this metric shows it.
 */
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveTargets, hasFlag } from './lib/targets.mjs';
import { run } from './lib/proc.mjs';
import { dirSize } from './lib/sizes.mjs';
import { ms, bytes, num } from './lib/stats.mjs';
import { merge } from './lib/results.mjs';

const targets = resolveTargets();
const skipInstall = hasFlag('source-only');

const out = {};

for (const target of targets) {
  console.log(`\n=== ${target.label} ===`);
  const source = await measureSource(target.dir);
  console.log(`  source ${source.files} files, ${num(source.lines)} lines (${bytes(source.bytes)})`);

  let install = null;
  if (!skipInstall) {
    install = await measureProdInstall(target);
    if (install.error) console.log(`  ✗ prod install: ${install.error}`);
    else console.log(`  prod install ${bytes(install.bytes)} in ${num(install.packages)} packages (${ms(install.ms)})`);
  }

  out[target.id] = { label: target.label, source, install };
}

/**
 * Source cost. Counts what a developer wrote and has to maintain: app source plus framework config,
 * excluding lockfiles (generated) and build output.
 */
async function measureSource(dir) {
  // `generated` holds the copied fixture — identical in all three, so counting it would only add the
  // same few thousand lines to every column.
  const SKIP = new Set(['node_modules', 'dist', '.next', '.output', '.nitro', '.tanstack', '.vite', '.git', 'public', 'generated']);
  const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.jsonc']);
  let files = 0;
  let lines = 0;
  let total = 0;
  const byExt = {};

  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name === 'package-lock.json') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && EXT.has(path.extname(entry.name))) {
        const text = await readFile(full, 'utf8');
        const n = text.split('\n').filter((l) => l.trim()).length;
        files += 1;
        lines += n;
        total += Buffer.byteLength(text, 'utf8');
        const ext = path.extname(entry.name);
        byExt[ext] = (byExt[ext] ?? 0) + n;
      }
    }
  }
  await walk(dir);
  return { files, lines, bytes: total, byExt };
}

async function measureProdInstall(target) {
  const pkg = JSON.parse(await readFile(path.join(target.dir, 'package.json'), 'utf8'));
  const temp = await mkdtemp(path.join(tmpdir(), `rshono-bench-${target.id}-`));
  try {
    // `file:` specifiers are relative to the app dir, which the temp dir is not.
    const deps = Object.fromEntries(
      Object.entries(pkg.dependencies ?? {}).map(([name, spec]) => [
        name,
        spec.startsWith('file:') ? `file:${path.resolve(target.dir, spec.slice(5))}` : spec,
      ]),
    );
    await writeFile(
      path.join(temp, 'package.json'),
      `${JSON.stringify({ name: `footprint-${target.id}`, private: true, version: '0.0.0', dependencies: deps }, null, 2)}\n`,
    );
    const res = await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: temp, label: `${target.id} prod install` });
    if (res.code !== 0) return { error: `npm install exited ${res.code}` };
    const nodeModules = path.join(temp, 'node_modules');
    const { bytes: b } = await dirSize(nodeModules, { skip: ['.git'] });
    return { bytes: b, packages: await countPackages(nodeModules), ms: res.ms, dependencies: Object.keys(deps).length };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Every directory holding a package.json, scoped packages included, .bin and friends excluded. */
async function countPackages(nodeModules) {
  let count = 0;
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('@') && depth === 0) {
        await walk(full, depth + 1);
        continue;
      }
      count += 1;
      // Nested node_modules are real duplicate installs and count separately.
      await walk(path.join(full, 'node_modules'), 0);
    }
  }
  await walk(nodeModules, 0);
  return count;
}

await merge('footprint', out);
console.log('\nwrote results/latest.json → sections.footprint');
