import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isPageRoute, type Route } from '../router.js';

/**
 * The request paths a `public/` tree answers, and the collisions with the route table that only show up
 * after a deploy.
 *
 * `DeployRuntime.mountPublicFallback` registers `public/` **after** every route, so it answers only what no
 * route claimed. That is the whole story on `node` and `aws-lambda`, where the app owns the URL surface. On
 * the two targets with a CDN in front, `public/` is part of the static output and the platform answers from
 * it **before** the app is invoked:
 *
 * - **vercel** — `{ handle: 'filesystem' }` sits ahead of the catch-all in `config.json`, by construction.
 * - **cloudflare** — Workers Assets is checked first, which the generated `wrangler.jsonc` says out loud.
 *
 * So an app with `public/about.html` and a page route at `/about.html` renders the page under `rshono dev`
 * and `rshono start`, and serves the file on those two — a behaviour difference discovered by deploying. A
 * `public/index.html` beside a page route at `/` is the same collision, on the one path every app has.
 *
 * The framework cannot reorder either platform, so this is a build-time warning: the build knows both sides
 * and comparing them is a set lookup.
 */

/** `.html` files are also reachable without the extension where the platform's HTML handling does that. */
export interface PublicPathOptions {
  /**
   * Whether `public/about.html` also answers `/about`. True on Cloudflare, whose Workers Assets defaults to
   * `auto-trailing-slash` HTML handling; false on Vercel, which serves the file at its own path unless the
   * project turns `cleanUrls` on. Getting this wrong in the permissive direction is a warning about a
   * collision the platform does not have, which is the noise that gets a check ignored.
   */
  htmlExtensionless: boolean;
}

/** Every file in a directory tree, as a `/`-separated path relative to its root. */
function filesUnder(root: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) found.push(...filesUnder(root, rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

/**
 * The request paths one `public/` file is served at — its own, plus the extra ones a platform's HTML
 * handling adds. The same normalisation `ssgFilePath` does for a prerendered page, in the other direction:
 * a check keyed on raw filenames would miss `/` for `index.html` and would be wrong about the rest.
 *
 * Deliberately not exhaustive. It lists what a file is *certainly* reachable at, because a false warning
 * about a route that works is worse than the collision it would have caught — the same asymmetry
 * `assertNothingIsShadowed` keeps.
 */
function pathsFor(file: string, options: PublicPathOptions): string[] {
  const paths = [`/${file}`];
  const index = file === 'index.html' ? '' : file.endsWith('/index.html') ? file.slice(0, -'/index.html'.length) : null;
  if (index !== null) paths.push(`/${index}`, `/${index}/`);
  else if (options.htmlExtensionless && file.endsWith('.html')) paths.push(`/${file.slice(0, -'.html'.length)}`);
  return [...new Set(paths)];
}

/**
 * The literal route paths a `public/` file would answer instead, on a target whose platform serves the
 * static output first — `[]` when there is no `public/` directory or nothing collides.
 *
 * Literal paths only. A `public/` file landing inside a parameterised route's pattern is a real collision
 * too, but deciding it needs the router rather than a set, and the paths every app actually writes files
 * beside — `/`, `/about`, `/favicon.ico` — are literal. The limit is here rather than in the message
 * because a reader of the message can do nothing with it.
 */
export function publicRouteCollisions(publicDir: string | null, routes: readonly Route[], options: PublicPathOptions): string[] {
  if (publicDir === null) return [];
  const claimed = new Map(routes.filter((route) => !route.path.includes(':') && !route.path.includes('*')).map((route) => [route.path, route]));
  const collisions: string[] = [];
  for (const file of filesUnder(publicDir)) {
    for (const path of pathsFor(file, options)) {
      const route = claimed.get(path);
      if (route) collisions.push(`public/${file} answers ${path}, which ${isPageRoute(route) ? 'a page' : 'an endpoint'} route claims`);
    }
  }
  return collisions;
}

/** The warning both CDN presets print, so the two say the same thing about the same problem. */
export function warnAboutPublicCollisions(collisions: string[], target: string): void {
  if (collisions.length === 0) return;
  console.warn(`  ⚠ ${collisions.length} public/ file(s) shadow a route on ${target}, where the CDN answers before the app is invoked:`);
  for (const line of collisions) console.warn(`    ${line}`);
  console.warn(`    Under \`rshono dev\` and \`rshono start\` the route wins instead, so this only appears once deployed.`);
}
