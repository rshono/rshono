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

/** What `rshono build` uses the app's own server bundle for, once it has compiled it. */
interface ServerBundle {
  app: Hono;
  routes: readonly Route[];
  /** Resolves every route's own module and checks it — see `assertRouteModules`. */
  checkRouteModules: () => Promise<void>;
}

/**
 * Runs one phase of the build that the app itself can fail.
 *
 * A `[rshono]` message was written for whoever is running the build, so it is printed as the one line it is;
 * anything else is a bug in the framework and keeps its stack. Everything the app can get wrong arrives this
 * way — the two entry modules, checked in the bundle's module scope; each route's own module; and a page that
 * throws while prerendering.
 */
async function phase<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('[rshono]')) throw error;
    console.error(`\n  ✗ ${message}\n`);
    process.exit(1);
  }
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
    process.exit(1);
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
  const bundle = await phase(() => importServerBundle(distDir));

  // Before anything is rendered: the checks here are the ones a route fails on *every* request, so a build
  // that skipped them would spend the prerender pass on a route it is about to refuse anyway. Without this
  // they ran on first request instead, which meant a page that could never work shipped behind a green build.
  await phase(() => bundle.checkRouteModules());

  const { written, skipped } = await phase(() =>
    prerenderStaticRoutes({
      routes: bundle.routes,
      fetch: (request) => bundle.app.fetch(request),
      ssgDir,
      siteUrl: config.siteUrl,
    }),
  );
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

  // Rspack's worker pool can keep the loop alive after `close()`, so the exit is explicit — but a piped
  // stdout is asynchronous, and exiting drops whatever has not drained. In CI that is exactly the lines
  // saying what was built and where it went. A zero-length write's callback fires behind the real ones.
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(0);
}
