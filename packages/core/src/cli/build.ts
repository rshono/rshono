import { rspack, type MultiStats } from '@rspack/core';
import type { Hono } from 'hono';
import { cpSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD_OUT_DIR, createConfigs } from '../builder/rspack-config.js';
import type { RshonoConfig } from '../config.js';
import { writeBuildMarker } from '../deploy/build-marker.js';
import type { DeployPreset } from '../deploy/presets.js';
import type { Route } from '../router.js';
import { prerenderStaticRoutes } from '../server/ssg.js';

interface BuildOptions {
  rootDir: string;
  config: RshonoConfig;
  /** The platform to build for, already resolved from the flag, the environment and the config. */
  preset: DeployPreset;
}

export async function buildCommand(options: BuildOptions): Promise<void> {
  const { rootDir, config, preset } = options;
  const distDir = join(rootDir, BUILD_OUT_DIR);

  console.log('  • building client + server bundles…');
  const configs = createConfigs({ rootDir, isDev: false, config, preset });
  const compiler = rspack(configs);

  const stats = await new Promise<MultiStats>((resolve, reject) => {
    compiler.run((err, result) => {
      compiler.close(() => {
        if (err) reject(err);
        else resolve(result!);
      });
    });
  });

  if (stats.hasErrors()) {
    console.error(stats.toString({ preset: 'errors-warnings', colors: true }));
    process.exit(1);
  }
  console.log(stats.toString({ preset: 'summary', colors: true }));

  const publicDir = join(rootDir, 'public');
  let distPublicDir: string | null = null;
  if (existsSync(publicDir)) {
    distPublicDir = join(distDir, 'public');
    cpSync(publicDir, distPublicDir, { recursive: true });
    console.log('  • copied public/ into dist/public (served at /)');
  }

  const ssgDir = join(distDir, 'ssg');
  await rm(ssgDir, { recursive: true, force: true });
  process.env.RSHONO_PRERENDER = '1';
  const bundle = (await import(pathToFileURL(join(distDir, 'server', 'main.mjs')).href)) as {
    app: Hono;
    routes: readonly Route[];
  };
  const { written, skipped } = await prerenderStaticRoutes({
    routes: bundle.routes,
    fetch: (request) => bundle.app.fetch(request),
    ssgDir,
    siteUrl: config.siteUrl,
  });
  if (written.length > 0) console.log(`  • prerendered ${written.length} static page(s): ${written.join(', ')}`);
  if (skipped.length > 0) console.log(`  • skipped ${skipped.length} (will SSR per request)`);

  // Before `finalize`, so a preset that copies `dist/` into a platform layout takes it along.
  writeBuildMarker(distDir, preset.name);

  // Last, so a preset arranging its output finds every piece of the build on disk.
  await preset.finalize?.({
    rootDir,
    distDir,
    staticDir: join(distDir, 'static'),
    publicDir: distPublicDir,
    ssgDir,
  });

  console.log(`  ✓ build complete — ${preset.deployHint}`);
  process.exit(0);
}
