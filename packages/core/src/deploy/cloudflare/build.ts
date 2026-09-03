import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DeployBuildContext } from '../presets.js';
import { publicRouteCollisions, warnAboutPublicCollisions } from '../public-paths.js';

/** Wrangler serves one directory, so the three kinds of asset the build produces are assembled into it. */
const ASSETS_DIR = join('cloudflare', 'assets');

const WRANGLER_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/**
 * Caching and crawler rules for the assembled tree, in the file Workers Assets reads them from: the hashed
 * bundle is immutable by construction, which the CDN cannot infer, and the prerender tree holds a second copy
 * of pages that already have real URLs — so it is marked `noindex`.
 */
const HEADERS_FILE = `/_static/*
  Cache-Control: public, max-age=31536000, immutable

/__ssg/*
  X-Robots-Tag: noindex
`;

/** A Wrangler worker name: lowercase, and only the characters it accepts. */
function workerName(rootDir: string): string {
  const name = basename(rootDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name || 'rshono-app';
}

// Fixed, not the day the build ran: wrangler's bundled workerd refuses a date newer than its own, so a config
// dated today would deploy fine and never start under `wrangler dev`.
const COMPATIBILITY_DATE = '2026-07-01';

function wranglerConfig(rootDir: string): string {
  return `${JSON.stringify(
    {
      $schema: 'node_modules/wrangler/config-schema.json',
      name: workerName(rootDir),
      main: 'dist/server/main.mjs',
      compatibility_date: COMPATIBILITY_DATE,
      // For AsyncLocalStorage, which is how the request context behind `getRequestContext()` is bound.
      compatibility_flags: ['nodejs_compat'],
      assets: {
        directory: `dist/${ASSETS_DIR.split(/[\\/]/).join('/')}`,
        // Read by the worker for `public/` files and prerendered pages; the CDN still answers first.
        binding: 'ASSETS',
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Arranges a Workers deployment: one assets directory holding everything the CDN should serve, and a
 * `wrangler.jsonc` to deploy with if the project has no Wrangler config of its own.
 */
export async function finalizeCloudflareBuild(ctx: DeployBuildContext): Promise<void> {
  const assetsDir = join(ctx.distDir, ASSETS_DIR);
  // From scratch, so a deleted `public/` file or a route that stopped being static does not survive here.
  await rm(assetsDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });

  cpSync(ctx.staticDir, join(assetsDir, '_static'), { recursive: true });
  if (ctx.publicDir) cpSync(ctx.publicDir, assetsDir, { recursive: true });
  if (existsSync(ctx.ssgDir)) cpSync(ctx.ssgDir, join(assetsDir, '__ssg'), { recursive: true });

  // Workers Assets is checked before the worker runs, so a `public/` file on a route's path answers instead
  // of the route — the same collision Vercel has, and neither `node` nor `aws-lambda` does.
  // `htmlExtensionless: true`: the binding's default HTML handling is `auto-trailing-slash`, so
  // `about.html` answers `/about` here as well as `/about.html`.
  warnAboutPublicCollisions(publicRouteCollisions(ctx.publicDir, ctx.routes, { htmlExtensionless: true }), 'cloudflare');

  const headersFile = join(assetsDir, '_headers');
  if (existsSync(headersFile)) {
    console.warn(`  ⚠ public/_headers is in the way of the generated one — /_static/* will not be marked immutable.`);
  } else {
    writeFileSync(headersFile, HEADERS_FILE);
  }

  const existing = WRANGLER_FILES.find((file) => existsSync(join(ctx.rootDir, file)));
  if (!existing) {
    writeFileSync(join(ctx.rootDir, 'wrangler.jsonc'), wranglerConfig(ctx.rootDir));
    console.log('  • wrote wrangler.jsonc (yours now — edit freely, the build will not touch it again)');
  }

  console.log(`  • assembled ${join('dist', ASSETS_DIR)} for Workers Assets`);
}
