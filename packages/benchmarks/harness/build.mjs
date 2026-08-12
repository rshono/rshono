/**
 * Build cost: cold (caches cleared) and warm (caches kept, one source file touched), plus the size of what came
 * out. Cold is the CI number, warm the one a developer feels. Both are run `--trials` times and reported as a
 * median with its relative spread, because a single build timing on a laptop is worth roughly nothing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveTargets, flagValue } from './lib/targets.mjs';
import { run } from './lib/proc.mjs';
import { removeAll, dirSize, fileSize } from './lib/sizes.mjs';
import { median, rsd, ms, bytes } from './lib/stats.mjs';
import { merge } from './lib/results.mjs';

const targets = resolveTargets();
const trials = Number(flagValue('trials', '3'));

const out = {};

for (const target of targets) {
  console.log(`\n=== ${target.label} ===`);
  const cold = [];
  const warm = [];
  let artifacts = null;
  let broke = null;

  for (let trial = 0; trial < trials; trial += 1) {
    await removeAll(target.dir, target.cacheDirs);
    const coldRun = await run(...target.build, { cwd: target.dir, label: `${target.id} cold build` });
    if (coldRun.code !== 0) {
      broke = `cold build exited ${coldRun.code}`;
      break;
    }
    cold.push(coldRun.ms);
    console.log(`  cold  #${trial + 1}  ${ms(coldRun.ms)}`);

    // Measure the artifact from the first cold build, before any incremental pass touches it.
    if (!artifacts) artifacts = await measureArtifacts(target);

    // Warm: same caches, one changed file. A rebuild with nothing changed measures cache lookup,
    // not compilation, and every one of these three would win it.
    const touched = await touch(target);
    const warmRun = await run(...target.build, { cwd: target.dir, label: `${target.id} warm build` });
    await touched.restore();
    if (warmRun.code !== 0) {
      broke = `warm build exited ${warmRun.code}`;
      break;
    }
    warm.push(warmRun.ms);
    console.log(`  warm  #${trial + 1}  ${ms(warmRun.ms)}  (touched ${touched.rel})`);
  }

  out[target.id] = {
    label: target.label,
    trials,
    error: broke,
    coldMs: { median: median(cold), rsdPct: rsd(cold), samples: cold },
    warmMs: { median: median(warm), rsdPct: rsd(warm), samples: warm },
    artifacts,
  };

  if (artifacts) {
    console.log(`  artifact ${bytes(artifacts.totalBytes)} in ${artifacts.files} files`);
    if (artifacts.serverBundleBytes) console.log(`  server bundle ${bytes(artifacts.serverBundleBytes)}`);
  }
  if (broke) console.log(`  ✗ ${broke}`);
}

async function measureArtifacts(target) {
  let totalBytes = 0;
  let files = 0;
  const perDir = {};
  for (const rel of target.artifactDirs) {
    const { bytes: b, files: f } = await dirSize(path.join(target.dir, rel));
    perDir[rel] = b;
    totalBytes += b;
    files += f;
  }
  return {
    totalBytes,
    files,
    perDir,
    serverBundleBytes: target.serverBundle ? await fileSize(path.join(target.dir, target.serverBundle)) : null,
  };
}

/**
 * Appends a comment to the app's own marker file and hands back a restore. Every app carries
 * `src/touch-marker.ts` (or the framework's equivalent) imported by the interactive route, so the
 * edit is real work in all three graphs rather than a no-op the watcher can shortcut.
 */
async function touch(target) {
  const rel = 'src/touch-marker.ts';
  const file = path.join(target.dir, rel);
  const original = await readFile(file, 'utf8');
  await writeFile(file, `${original}\n// bench touch\n`);
  return { rel, restore: () => writeFile(file, original) };
}

await merge('build', out);
console.log('\nwrote results/latest.json → sections.build');
