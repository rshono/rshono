/**
 * The documentation table of contents — every page, in the order the sidebar shows them.
 *
 * Explicit, like `routes.ts`, and for the same reason: the order here *is* the reading order, and a
 * directory scan would have to be told it separately anyway (through a filename prefix, or a second
 * manifest). One list, and adding a page is an import and a line.
 *
 * The markdown is imported rather than read from disk, so the content is inside the server bundle. That
 * is what lets the [`/docs/:slug.md`](../routes/doc-markdown.ts) endpoint answer on a deploy target
 * with no filesystem — and it means `staticPaths` needs no I/O at build time either.
 */

import sourceApi from '../../content/docs/api.md';
import sourceConfiguration from '../../content/docs/configuration.md';
import sourceDeployment from '../../content/docs/deployment.md';
import sourceGettingStarted from '../../content/docs/getting-started.md';
import sourceHono from '../../content/docs/hono.md';
import sourcePages from '../../content/docs/pages.md';
import sourceProjectLayout from '../../content/docs/project-layout.md';
import sourceRouting from '../../content/docs/routing.md';
import sourceStyling from '../../content/docs/styling.md';
import sourceUsage from '../../content/docs/usage.md';
import { readFrontmatter } from './markdown.js';

/** One documentation page. `title` and `description` come from the file's own frontmatter. */
export interface DocEntry {
  slug: string;
  title: string;
  description: string;
  /** The raw markdown, frontmatter included — what `/docs/:slug.md` serves verbatim. */
  source: string;
  /** The sidebar group this page belongs to. */
  section: string;
  /** Path to the rendered page. */
  href: string;
  /** Path to the markdown source. */
  markdownHref: string;
}

/**
 * Sections and their pages, in sidebar order.
 *
 * Ten pages, and that is a budget rather than a coincidence: the essentials are the first six, and
 * everything a reader only needs once — styling, config, deploy targets — is grouped under Advanced.
 *
 * Titles are deliberately *not* repeated here — they live in each file's frontmatter, so the sidebar,
 * the `<title>`, the page heading and the markdown source can never disagree about what a page is
 * called.
 */
const SECTIONS: Array<{ title: string; pages: Array<{ slug: string; source: string }> }> = [
  {
    title: 'Introduction',
    pages: [
      { slug: 'getting-started', source: sourceGettingStarted },
      { slug: 'project-layout', source: sourceProjectLayout },
    ],
  },
  {
    title: 'Core concepts',
    pages: [
      { slug: 'routing', source: sourceRouting },
      { slug: 'pages', source: sourcePages },
      { slug: 'hono', source: sourceHono },
      { slug: 'usage', source: sourceUsage },
    ],
  },
  {
    title: 'Advanced',
    pages: [
      { slug: 'styling', source: sourceStyling },
      { slug: 'configuration', source: sourceConfiguration },
      { slug: 'deployment', source: sourceDeployment },
    ],
  },
  {
    title: 'Reference',
    pages: [{ slug: 'api', source: sourceApi }],
  },
];

/** A section with its pages resolved to full {@link DocEntry} objects. */
export interface DocSection {
  title: string;
  docs: DocEntry[];
}

function toEntry(section: string, page: { slug: string; source: string }): DocEntry {
  const { title, description } = readFrontmatter(page.source);
  return {
    slug: page.slug,
    title,
    description,
    source: page.source,
    section,
    href: `/docs/${page.slug}`,
    markdownHref: `/docs/${page.slug}.md`,
  };
}

/** Every section, in sidebar order. Built once at module load — the sources are compile-time constants. */
export const DOC_SECTIONS: DocSection[] = SECTIONS.map((section) => ({
  title: section.title,
  docs: section.pages.map((page) => toEntry(section.title, page)),
}));

/** Every page, flattened into reading order — which is what prev/next walks. */
export const DOCS: DocEntry[] = DOC_SECTIONS.flatMap((section) => section.docs);

const BY_SLUG = new Map(DOCS.map((doc) => [doc.slug, doc]));

export function getDoc(slug: string): DocEntry | undefined {
  return BY_SLUG.get(slug);
}

/** The pages either side of `slug` in reading order, for the footer links. */
export function docNeighbours(slug: string): { previous?: DocEntry; next?: DocEntry } {
  const index = DOCS.findIndex((doc) => doc.slug === slug);
  if (index === -1) return {};
  return { previous: DOCS[index - 1], next: DOCS[index + 1] };
}
