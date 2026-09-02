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
import { exit } from './exit.js';

interface BuildOptions {
  rootDir: string;
  config: RshonoConfig;
  /** The platform to build for, already resolved from the flag, the environment and the config. */
  preset: DeployPreset;
}

/** What `rshono build` uses the app's own server bundle for, once it has compiled it. */
interface ServerBundle {
  app: Hono;
  routes: readonly Route[];
  /** Resolves every route's own module and checks it — see `assertRouteModules`. */
  checkRouteModules: () => Promise<void>;
}

function importServerBundle(distDir: string): Promise<ServerBundle> {
  return import(pathToFileURL(join(distDir, 'server', 'main.mjs')).href) as Promise<ServerBundle>;
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
    return exit(1);
  }
  // Printed rather than left to the summary below, which counts warnings without saying what they are —
  // and one of them is the env shadow reporting a read it cannot cover. See `env-shadow-loader.cjs`.
  if (stats.hasWarnings()) console.warn(stats.toString({ preset: 'errors-warnings', colors: true }));
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
  // The bundle's module scope is where `src/routes.ts` and `src/server.ts` are validated.
  //
  // This and the two stages below are what the *app* can fail — the two entry modules here, each route's own
  // module next, and a page that throws while prerendering after that. Each raises a `[rshono]` message
  // written for whoever is running the build, and `main().catch` in `cli/index.ts` is what prints it as the
  // one line it is. These used to be wrapped in a `phase()` helper that did the same thing three times and
  // nowhere else, which left `createConfigs` above — where a missing `src/routes.ts` is found — printing a
  // raw `Error` object with framework frames in it.
  const bundle = await importServerBundle(distDir);

  // Before anything is rendered: the checks here are the ones a route fails on *every* request, so a build
  // that skipped them would spend the prerender pass on a route it is about to refuse anyway. Without this
  // they ran on first request instead, which meant a page that could never work shipped behind a green build.
  await bundle.checkRouteModules();

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

  // Rspack's worker pool can keep the loop alive after `close()`, so the exit is explicit. {@link exit}
  // drains first: in CI the tail is the lines saying what was built and where it went.
  await exit(0);
}
