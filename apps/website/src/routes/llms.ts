/**
 * Shared pieces of the two `llms.txt` endpoints. Not an endpoint itself — an
 * `{ type: 'endpoint' }` module must export exactly one `handler`, so the index and the full corpus
 * are a file each and this is what they have in common.
 */

import { publicUrl } from '@rshono/core/server';
import type { Context } from 'hono';

export const SUMMARY =
  'rshono is a minimalist web framework built on Hono, Rspack and React Server Components. ' +
  'One required file (src/routes.ts), one optional file (src/server.ts), and you get a dev server with HMR, ' +
  'streaming SSR with RSC hydration, server actions with progressive enhancement, soft navigation, ' +
  'build-time prerendering, and hard env/secret safety.';

/**
 * The origin to build absolute links against.
 *
 * Read off the request rather than from `siteUrl`, because these are dynamic endpoints and there is a
 * real request to read — which also means the file is correct under `rshono dev`, where a baked-in
 * `siteUrl` would send a reader to production.
 *
 * `publicUrl(c)` rather than `c.req.url`, which is the address this server was *reached* on. Under
 * `rshono dev` that is the app worker's random `127.0.0.1` port — the front-end proxies to it, and
 * `fetch` sets `Host` from the address it dials, so every link came out pointing at a port only the
 * dev server knows about. `publicUrl` reads `X-Forwarded-Host` / `-Proto` instead, which that proxy
 * sets and `trustProxy` — forced on under `dev` — makes trustworthy.
 */
export function origin(c: Context): string {
  return publicUrl(c).origin;
}

/**
 * The projects an rshono app is written *against*, each of which publishes an `llms.txt` of its own.
 *
 * rshono's documentation stops at its seams: `src/server.ts` is a Hono app, a page is a React server
 * component, and the build is Rspack's. A reader that needs the far side of one of those seams is better
 * served by the upstream file than by anything this site could restate about it.
 */
const UPSTREAM = [
  {
    title: 'Hono',
    url: 'https://hono.dev/llms.txt',
    description: 'The server rshono runs on — `src/server.ts` is a Hono app, and an endpoint handler is a Hono handler.',
  },
  {
    title: 'Rspack',
    url: 'https://rspack.rs/llms.txt',
    description: 'The bundler behind `rshono dev` and `rshono build`. rshono writes the config; the `rspack` hook extends it.',
  },
  {
    title: 'React',
    url: 'https://react.dev/llms.txt',
    description: 'Server and client components, hooks, and the rest of the model pages are written in.',
  },
] as const;

/**
 * The upstream links as one markdown block, so both endpoints emit the identical thing.
 *
 * The heading is the literal word "Optional", which the [llms.txt convention](https://llmstxt.org) gives
 * a meaning to: links a reader may skip when its context budget is tight. That is the honest label for
 * three external corpora, each of them larger than this whole site — a tool that follows every link it
 * finds should not drown in them, and one that reads the heading still knows where they are.
 */
export const UPSTREAM_SECTION =
  '## Optional\n\n' + UPSTREAM.map((project) => `- [${project.title} llms.txt](${project.url}): ${project.description}`).join('\n');

/** Both endpoints serve plain markdown, cached like the prerendered pages they mirror. */
export const MARKDOWN_HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
} as const;
