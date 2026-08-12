import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeployBuildContext } from '../presets.js';

/**
 * The Build Output API v3 layout, which `vercel deploy --prebuilt` uploads verbatim — producing it directly
 * means Vercel runs no build of its own.
 */
const OUTPUT_DIR = join('.vercel', 'output');
const FUNCTION_DIR = join('functions', 'index.func');

/**
 * The bundle keeps this exact path inside the function because the runtime derives the project root from where
 * it sits (see `deploy/filesystem.ts`), so `dist/ssg` and `dist/public` land where it already looks — and no
 * runtime code needs to know it is on Vercel.
 */
const HANDLER = 'dist/server/main.mjs';

/**
 * Routes, in the order Vercel evaluates them: hashed assets get the immutable header the CDN cannot infer,
 * then anything in the static output is served from it, and whatever is left is the app's to render.
 */
const ROUTES = [
  { src: '^/_static/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
  { handle: 'filesystem' },
  { src: '/(.*)', dest: '/index' },
];

export async function finalizeVercelBuild(ctx: DeployBuildContext): Promise<void> {
  const outputDir = join(ctx.rootDir, OUTPUT_DIR);
  const staticOut = join(outputDir, 'static');
  const functionDir = join(outputDir, FUNCTION_DIR);

  // From scratch, so a deleted page or asset cannot survive in the uploaded output.
  await rm(outputDir, { recursive: true, force: true });
  mkdirSync(staticOut, { recursive: true });
  mkdirSync(functionDir, { recursive: true });

  // Served by the CDN: the hashed bundle under its public path, and `public/` at the web root.
  cpSync(ctx.staticDir, join(staticOut, '_static'), { recursive: true });
  if (ctx.publicDir) cpSync(ctx.publicDir, staticOut, { recursive: true });

  // Shipped inside the function: the bundle, plus the two things it reads from disk at request time.
  cpSync(join(ctx.distDir, 'server'), join(functionDir, 'dist', 'server'), { recursive: true });
  if (existsSync(ctx.ssgDir)) cpSync(ctx.ssgDir, join(functionDir, 'dist', 'ssg'), { recursive: true });
  if (ctx.publicDir) cpSync(ctx.publicDir, join(functionDir, 'dist', 'public'), { recursive: true });

  writeFileSync(
    join(functionDir, '.vc-config.json'),
    `${JSON.stringify(
      {
        // The Node the build ran on, so the function runs the runtime the app was tested against — and so
        // this does not become a hard-coded version the platform retires on a date the framework does not
        // control. A major Vercel does not offer is an explicit error from the deploy rather than a mismatch.
        runtime: `nodejs${process.versions.node.split('.')[0]}.x`,
        handler: HANDLER,
        launcherType: 'Nodejs',
        // Without this the platform buffers the whole response, undoing streamed SSR.
        supportsResponseStreaming: true,
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(join(outputDir, 'config.json'), `${JSON.stringify({ version: 3, routes: ROUTES }, null, 2)}\n`);

  console.log(`  • assembled ${OUTPUT_DIR} (Build Output API v3)`);
}
