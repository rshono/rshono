import type { Handler } from 'hono';
import { DOCS } from '../content/docs';
import { origin } from './llms';

/** Every page a crawler should know about, in the order a reader would meet them. */
const PATHS = ['/', '/benchmarks', '/docs', ...DOCS.map((doc) => doc.href)];

/**
 * `/sitemap.xml` — referenced by `public/robots.txt`.
 *
 * No `lastmod`: the honest value is the build time, and a sitemap that claims every page changed
 * whenever anything did teaches a crawler to ignore the field. Better absent than wrong.
 */
export const handler: Handler = (c) => {
  const base = origin(c);
  const urls = PATHS.map((path) => `  <url><loc>${base}${path}</loc></url>`).join('\n');

  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
};
