/**
 * Markdown → HTML, a table of contents, and the frontmatter, in one pass.
 *
 * Everything here runs at **build time**: the pages that call it are `render: 'static'`, so the parse
 * and the highlight happen once during `rshono build` and what reaches a browser is finished HTML.
 * That is the whole reason a docs page ships no JavaScript of its own — there is no highlighter in the
 * client bundle because there is no highlighting left to do.
 */

import langCss from '@shikijs/langs/css';
import langDiff from '@shikijs/langs/diff';
import langHtml from '@shikijs/langs/html';
import langJavaScript from '@shikijs/langs/javascript';
import langJson from '@shikijs/langs/json';
import langJsx from '@shikijs/langs/jsx';
import langMarkdown from '@shikijs/langs/markdown';
import langBash from '@shikijs/langs/shellscript';
import langTsx from '@shikijs/langs/tsx';
import langTypeScript from '@shikijs/langs/typescript';
import themeDark from '@shikijs/themes/github-dark';
import themeLight from '@shikijs/themes/github-light';
import matter from 'gray-matter';
// markdown-it 15 ships its own types, and they split what v14's single export was: the default export is
// the class (still callable without `new`, for compatibility), while the type an instance has is a named
// export that happens to share its name — hence the alias.
import MarkdownIt, { type Env, type MarkdownIt as MarkdownItInstance, type Token } from 'markdown-it';
import anchor from 'markdown-it-anchor';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { renderCommandTabs } from './package-managers.js';

/** One heading in the on-page table of contents. Only `h2` and `h3` are collected. */
export interface TocEntry {
  /** The anchor id `markdown-it-anchor` gave the heading — the `href` is `#` + this. */
  id: string;
  /** The heading's text, with inline markdown stripped back to something a link can hold. */
  text: string;
  /** `2` or `3`; the renderer indents the deeper level rather than nesting a second list. */
  depth: 2 | 3;
}

/** A rendered documentation page. */
export interface RenderedDoc {
  title: string;
  description: string;
  /** Finished HTML, highlighted and anchored. Injected with `dangerouslySetInnerHTML`. */
  html: string;
  toc: TocEntry[];
}

/** Frontmatter every content file is expected to carry. */
interface DocFrontmatter {
  title?: string;
  description?: string;
}

/**
 * The languages the docs actually use, imported one by one rather than through `shiki/bundle/full`.
 *
 * The full bundle carries every grammar Shiki ships — several megabytes of them — into the server
 * bundle for the handful used here. Naming them costs an import line each and keeps the build small.
 */
const LANGS = [langTypeScript, langTsx, langJavaScript, langJsx, langJson, langBash, langCss, langHtml, langMarkdown, langDiff];

/**
 * Grammars are matched by name *and* alias, so `\`\`\`ts` and `\`\`\`typescript` both resolve. Anything
 * not in here is rendered as plain text rather than failing the build over a fenced block.
 */
const KNOWN_LANGS = new Set(LANGS.flatMap(([grammar]) => [grammar.name, ...(grammar.aliases ?? [])]));

/**
 * Built once and reused. Creating a highlighter compiles every grammar, which is far too expensive to
 * repeat per page — and the docs render one page after another during the prerender.
 *
 * The **JavaScript** regex engine, not Oniguruma: the alternative loads a WASM binary, which is one
 * more thing that has to resolve inside a bundled server on every deploy target. The JS engine is pure
 * JavaScript, so it bundles like any other module.
 */
let highlighterPromise: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [themeLight, themeDark],
    langs: LANGS,
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

/** How long the button holds its result before going back to saying `Copy`. */
const COPY_RESET_DELAY = 2000;

/**
 * Copying, as an inline handler rather than a component.
 *
 * The whole feature is now built here: a docs page ships no JavaScript for it, mounts no island and has
 * nothing to hydrate, because an `onclick` attribute is compiled by the parser wherever the markup came
 * from. That last part is what makes this work at all — a `<script>` emitted alongside the block would
 * run on a hard load and silently never run again, since the prose arrives as `innerHTML` on a soft
 * navigation and scripts inserted that way do not execute. Attributes have no such rule.
 *
 * `previousElementSibling` is the `<pre>`, and `textContent` rather than `innerText` because the panels
 * of a package manager selector are `display: none` until chosen — `innerText` is defined in terms of
 * what is rendered, and would hand back nothing for three blocks out of four.
 *
 * **This costs a CSP directive.** An event-handler attribute is inline script, and a nonce cannot cover
 * one, so a `secureHeaders()` policy would need `scriptSrc` widened with `'unsafe-hashes'` plus this
 * handler's sha256. It is one constant string, so one hash covers every button on the site — but the
 * hash changes with the string, so it has to be regenerated whenever this is edited.
 */
const COPY_HANDLER = `
  clearTimeout(this.resetTimer);
  Promise.resolve()
    .then(() => navigator.clipboard.writeText(this.previousElementSibling.textContent))
    .then(
      () => { this.textContent = 'Copied'; this.dataset.copied = 'true' },
      () => { this.textContent = 'Press ⌘C' }
    )
    .then(() => { this.resetTimer = setTimeout(() => { this.textContent = 'Copy'; delete this.dataset.copied }, ${COPY_RESET_DELAY}) });
`
  .replace(/\s+/g, ' ')
  .trim();

/**
 * The copy button, emitted with the block rather than added to one afterwards.
 *
 * Markup this site invents, so it is built here with the rest of what this file invents — the table
 * wrapper, the command tabs — instead of in an effect that walks the finished page looking for `<pre>`s
 * to append to.
 *
 * A **sibling** of the `<pre>`, not a child. The `<pre>` is a horizontal scroll container, and an
 * absolutely positioned child of one sits in its scrollable overflow — so on a block wide enough to
 * scroll, the button slides out of view exactly when a reader is furthest from the code they wanted.
 * Keeping it outside also keeps the word *Copy* out of the block's own text, which is what a reader who
 * selects the code by hand and presses ⌘C would otherwise take with them.
 *
 * Interpolated raw: `COPY_HANDLER` is a constant in this file and carries no `"` or `&`, so there is
 * nothing for the attribute to escape. (`>` inside a quoted attribute value is legal, arrows included.)
 */
const COPY_BUTTON = `<button type="button" class="code-copy" aria-label="Copy code to clipboard" onclick="${COPY_HANDLER}">Copy</button>`;

/** The characters that would break out of the header's markup. A title is a filename, but this is markup we build. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The one call every code block on this site goes through.
 *
 * `defaultColor: false` is what makes one build serve both themes: instead of baking one theme's colours
 * in, every token carries `--shiki-light` and `--shiki-dark` custom properties and `styles.css` picks
 * between them. No flash, no second stylesheet, no client JS.
 *
 * The wrapper is what the copy button is positioned against, and it goes here rather than in the fence
 * rule so that a command tab panel and a landing page sample get one too — those reach Shiki through this
 * function without passing through markdown at all.
 *
 * `title` becomes a filename header above the block. It is emitted *before* the `<pre>` so the copy
 * button stays the `<pre>`'s next sibling — which is the one thing `COPY_HANDLER` relies on.
 */
function highlightWith(highlighter: HighlighterCore, code: string, lang: string, title?: string): string {
  const block = highlighter.codeToHtml(code, {
    lang: KNOWN_LANGS.has(lang) ? lang : 'text',
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });

  const header = title ? `<div class="code-title">${escapeHtml(title)}</div>` : '';
  return `<div class="code-block">${header}${block}${COPY_BUTTON}</div>`;
}

/**
 * The filename a fence may carry: ` ```tsx title="src/components/new-note/index.tsx" `.
 *
 * `title="…"` is the spelling the rest of the docs world already uses, and that is the whole argument for
 * it: `content/docs/*.md` is served verbatim at `/docs/:slug.md` and quoted into `llms-full.txt`, so a
 * fence attribute has to still say what it means to a reader who has never seen this site. Unlike the
 * command tabs — presentation, and therefore detected rather than marked up — a filename is *content*:
 * which file the snippet goes in cannot be inferred from the code.
 *
 * Double quotes only. One spelling is easier to keep right than three.
 */
function readFenceTitle(info: string): string | undefined {
  return /\btitle="([^"]*)"/.exec(info)?.[1] || undefined;
}

/**
 * Every name a fence can open a shell block under, taken from the grammar rather than listed — `bash`,
 * `sh`, `shell`, `zsh` are all one Shiki language.
 *
 * A block in one of these is a candidate for a [package manager selector](./package-managers.ts).
 * `renderCommandTabs` is what decides, and it only says yes to a block whose every line is an
 * `npx`/`npm i` command it can translate exactly.
 */
const [shellGrammar] = langBash;
const SHELL_LANGS = new Set([shellGrammar.name, ...(shellGrammar.aliases ?? [])]);

/**
 * The `env` object markdown-it threads through one document's parse and render, carrying the single field
 * this file puts on it: a per-document counter, so the radio groups on one page get names that cannot collide.
 */
interface RenderEnv extends Env {
  commandTabs?: number;
}

/**
 * `#`-anchored headings, with the text kept clickable.
 *
 * The heading renders its own text plus a trailing link rather than wrapping the text in one, so a
 * heading containing a `<code>` span doesn't become a link with code inside it.
 */
const anchorOptions: anchor.AnchorOptions = {
  level: [2, 3],
  /**
   * Plain `[a-z0-9-]` ids.
   *
   * The default slugify only `encodeURIComponent`s the lowercased text, which turns *Vary: Accept*
   * into `vary%3A-accept` and *CSP (opt-in)* into `csp-(opt-in)`. Both work, but neither is something
   * you would type into a cross-page link by hand — and this file's whole job is producing anchors
   * other pages link to.
   */
  slugify: (heading) =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[^\w\- ]+/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, ''),
  permalink: anchor.permalink.linkInsideHeader({
    symbol: '<span aria-hidden="true">#</span>',
    placement: 'after',
    class: 'heading-anchor',
    ariaHidden: false,
  }),
};

/** Inline markdown a TOC label should not carry: code ticks, emphasis, and link syntax. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
}

let mdPromise: Promise<MarkdownItInstance> | undefined;

async function getMarkdownIt(): Promise<MarkdownItInstance> {
  mdPromise ??= (async () => {
    const highlighter = await getHighlighter();
    const highlight = (code: string, lang: string, title?: string) => highlightWith(highlighter, code, lang, title);

    /**
     * No `highlight` option: that one is only ever read by markdown-it's *default* fence rule, and the
     * rule below replaces it outright rather than delegating to it. Delegating is what put every block
     * on this site inside a second `<pre><code class="language-…">` — the default rule passes anything
     * not starting with `<pre` through that wrapper, and what `highlightWith` returns starts with the
     * `<div>` the copy button is positioned against.
     */
    const md = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: false,
    });

    md.use(anchor, anchorOptions);

    /**
     * A shell block that is nothing but package manager commands becomes a selector instead.
     *
     * Detected rather than marked up, so the markdown stays markdown: `content/docs/*.md` is served
     * verbatim at `/docs/:slug.md` and quoted in `llms-full.txt`, and neither should carry a fence
     * attribute that only means something to this site. A block that does not translate falls through
     * to the ordinary renderer, which is what every other fence in the docs does.
     */
    /**
     * Every table gets a scroll container around it.
     *
     * It has to be a wrapper element rather than a rule on the table: `overflow-x` on a `display:
     * table` box does not make it a scroll container, and a table whose min-content width beats the
     * column it sits in widens past `width: 100%` whatever you set — so a wide one pushed the whole
     * article sideways instead of scrolling. Done here rather than in the markdown for the same reason
     * the command tabs are: `content/docs/*.md` is served verbatim at `/docs/:slug.md`, and a `<div>`
     * that only means something to this site does not belong in it.
     */
    md.renderer.rules.table_open = (tokens, index, options, env, self) => `<div class="table-scroll">${self.renderToken(tokens, index, options)}`;
    md.renderer.rules.table_close = (tokens, index, options, env, self) => `${self.renderToken(tokens, index, options)}</div>`;

    md.renderer.rules.fence = (tokens, index, options, rawEnv) => {
      // A renderer rule is handed `Env | undefined`, since rendering a token stream without one is allowed.
      // Every render here goes through `renderDoc`, which always passes the env it parsed with.
      const env = rawEnv as RenderEnv;
      const token = tokens[index];
      const info = token.info.trim();
      const lang = info.split(/\s+/)[0] ?? '';

      if (SHELL_LANGS.has(lang)) {
        const group = (env.commandTabs = (env.commandTabs ?? 0) + 1);
        const tabs = renderCommandTabs({ id: `pm-${group}`, command: token.content, variant: 'block', highlight });
        if (tabs) return tabs;
      }

      return highlight(token.content, lang, readFenceTitle(info));
    };

    return md;
  })();

  return mdPromise;
}

/** Collect the `h2`/`h3` headings out of an already-parsed token stream. */
function tableOfContents(tokens: Token[]): TocEntry[] {
  const toc: TocEntry[] = [];

  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'heading_open' || (token.tag !== 'h2' && token.tag !== 'h3')) continue;
    // `attrGet` is typed `string | number | null` in markdown-it 15, since an attribute may hold a number.
    // The ids here come from `markdown-it-anchor`, so they are always the slug it wrote.
    const id = token.attrGet('id')?.toString();
    const inline = tokens[index + 1];
    if (!id || !inline) continue;
    toc.push({ id, text: stripInlineMarkdown(inline.content), depth: token.tag === 'h2' ? 2 : 3 });
  }

  return toc;
}

/**
 * Render one markdown source into everything a docs page needs.
 *
 * Parsed once and rendered from those same tokens, so the ids in the table of contents are literally
 * the ids in the HTML — deriving them separately is how a TOC ends up linking to anchors that moved.
 */
export async function renderDoc(source: string): Promise<RenderedDoc> {
  const { data, content } = matter(source);
  const frontmatter = data as DocFrontmatter;
  const md = await getMarkdownIt();

  const env: RenderEnv = {};
  const tokens = md.parse(content, env);

  return {
    title: frontmatter.title ?? 'Untitled',
    description: frontmatter.description ?? '',
    html: md.renderer.render(tokens, md.options, env),
    toc: tableOfContents(tokens),
  };
}

/**
 * A single code sample, highlighted the same way a fenced block in the docs is.
 *
 * For handwritten pages like the landing page, where the sample is JSX rather than markdown but should
 * not look like it came from somewhere else.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter();
  return highlightWith(highlighter, code.trim(), lang);
}

/** The frontmatter alone, without paying for a render — used to build nav and index listings. */
export function readFrontmatter(source: string): { title: string; description: string } {
  const frontmatter = matter(source).data as DocFrontmatter;
  return { title: frontmatter.title ?? 'Untitled', description: frontmatter.description ?? '' };
}
