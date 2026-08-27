import type { Handler } from 'hono';
import { DOCS } from '../content/docs';
import { MARKDOWN_HEADERS, origin, SUMMARY, UPSTREAM_SECTION } from './llms';

/**
 * `/llms-full.txt` — every page concatenated, in reading order.
 *
 * The companion to the index: one request instead of ten, for a reader that wants the whole thing.
 */
export const handler: Handler = (c) => {
  const base = origin(c);
  const pages = DOCS.map((doc) => `<!-- source: ${base}${doc.markdownHref} -->\n\n${doc.source.trim()}`).join('\n\n---\n\n');

  // The upstream links go above the corpus rather than after it: a reader that stops early still gets them.
  return c.body(`# rshono — full documentation\n\n> ${SUMMARY}\n\n${UPSTREAM_SECTION}\n\n---\n\n${pages}\n`, 200, MARKDOWN_HEADERS);
};
