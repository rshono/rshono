import type { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFiles } from '../server/load-env.js';
import { readPrerendered } from '../server/ssg.js';
import { createPublicFallback, createStaticAssetsApp } from '../server/static.js';
import type { DeployRuntime } from './contract.js';

const { isDev, outDir } = __RSHONO_CONFIG__;

/**
 * The project root, derived from where the bundle ended up: this module is compiled into
 * `<root>/<outDir>/server/main.mjs`, which is why every output directory sits one level under the root.
 *
 * Derived rather than baked in, because an absolute build-time path would tie the output to the machine that
 * produced it — building in CI to run elsewhere is the normal case. A preset that relocates the bundle keeps
 * `dist/server/main.mjs` intact inside its own layout for this reason.
 */
const rootDir = join(import.meta.dirname, '..', '..');

const staticDir = join(rootDir, outDir, 'static');
const ssgDir = join(rootDir, outDir, 'ssg');
/** `public/` is copied into the build output, so a deployed build is self-contained; dev reads the source. */
const publicDir = isDev ? join(rootDir, 'public') : join(rootDir, outDir, 'public');

/**
 * Everything a deploy target with a real filesystem does the same way. Node and the serverless runtimes that
 * unpack onto a read-only disk (Vercel, AWS Lambda) differ only in how the app is handed over, so each of
 * those presets is this object plus its own {@link DeployRuntime.serveApp}.
 */
export const fileSystemRuntime: Omit<DeployRuntime, 'serveApp'> = {
  mountStaticAssets(app: Hono): void {
    app.route('/_static', createStaticAssetsApp({ root: staticDir, isDev }));
  },

  mountPublicFallback(app: Hono): void {
    if (!existsSync(publicDir)) return;
    app.on(['GET', 'HEAD'], '/*', createPublicFallback({ root: publicDir, isDev }));
  },

  readPrerendered(c, variant) {
    return readPrerendered(ssgDir, c.req.path, variant);
  },

  loadEnv(): void {
    loadEnvFiles(rootDir);
  },
};
