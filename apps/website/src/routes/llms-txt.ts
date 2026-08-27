import type { Handler } from 'hono';
import { DOC_SECTIONS } from '../content/docs';
import { MARKDOWN_HEADERS, origin, SUMMARY, UPSTREAM_SECTION } from './llms';

/**
 * `/llms.txt` — the index described by the [llms.txt convention](https://llmstxt.org): a short summary
 * and a list of every page, each pointing at its markdown source rather than its HTML.
 */
export const handler: Handler = (c) => {
  const base = origin(c);

  const sections = DOC_SECTIONS.map((section) => {
    const links = section.docs.map((doc) => `- [${doc.title}](${base}${doc.markdownHref}): ${doc.description}`).join('\n');
    return `## ${section.title}\n\n${links}`;
  }).join('\n\n');

  const body =
    `# rshono\n\n` +
    `> ${SUMMARY}\n\n` +
    `Every documentation page is available as Markdown by appending \`.md\` to its URL.\n` +
    `The whole corpus in one file: ${base}/llms-full.txt\n\n` +
    `${sections}\n\n` +
    `${UPSTREAM_SECTION}\n`;

  return c.body(body, 200, MARKDOWN_HEADERS);
};
