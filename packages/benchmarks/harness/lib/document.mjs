/**
 * What the browser is committed to loading for a route's *initial* paint, read off the served document: script
 * tags, stylesheets, and the preload/modulepreload hints the framework emitted.
 *
 * Deliberately not a browser: one would also fetch chunks triggered after hydration, which answers a different
 * question. A static read is reproducible to the byte, which a browser run is not.
 */

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const LINK_TAG = /<link\b([^>]*)>/gi;
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

function attrs(raw) {
  const out = {};
  for (const m of raw.matchAll(/([a-zA-Z-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return out;
}

export function parseDocument(html) {
  const external = [];
  let inlineScriptBytes = 0;
  let inlineScripts = 0;
  let inlineStyleBytes = 0;

  for (const m of html.matchAll(SCRIPT_BLOCK)) {
    const a = attrs(m[1]);
    if (a.src) {
      external.push({ url: a.src, as: 'script', hint: 'script' });
    } else if (m[2].trim()) {
      // Where the inlined flight payload lives in all three frameworks. It ships on every request and is not a
      // file, so counting only external assets would hide it entirely.
      inlineScriptBytes += Buffer.byteLength(m[2], 'utf8');
      inlineScripts += 1;
    }
  }

  for (const m of html.matchAll(STYLE_BLOCK)) {
    inlineStyleBytes += Buffer.byteLength(m[1], 'utf8');
  }

  for (const m of html.matchAll(LINK_TAG)) {
    const a = attrs(m[1]);
    const rel = (a.rel ?? '').toLowerCase();
    if (!a.href) continue;
    if (rel.includes('stylesheet')) external.push({ url: a.href, as: 'style', hint: 'stylesheet' });
    else if (rel.includes('modulepreload')) external.push({ url: a.href, as: 'script', hint: 'modulepreload' });
    else if (rel.includes('preload')) {
      const as = (a.as ?? '').toLowerCase();
      if (as === 'script') external.push({ url: a.href, as: 'script', hint: 'preload' });
      else if (as === 'style') external.push({ url: a.href, as: 'style', hint: 'preload' });
    }
  }

  // Same href appearing as both a preload hint and a real tag is one download.
  const seen = new Set();
  const unique = external.filter((e) => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  return { external: unique, inlineScriptBytes, inlineScripts, inlineStyleBytes };
}

/**
 * Every one of these dev servers writes into the directory its production build uses, so a runner can be pointed
 * at a dev bundle by accident and report a payload several times too large. Cheaper to detect than to publish.
 */
const DEV_MARKERS = [
  ['react-refresh', 'react-refresh runtime'],
  ['__webpack_require__.$Refresh$', 'webpack refresh hooks'],
  ['/@vite/client', 'Vite dev client'],
  ['__vite_plugin_react', 'Vite React plugin dev runtime'],
  ['__rshono_dev', 'rshono dev channel'],
];

export function detectDevBuild(html) {
  return DEV_MARKERS.filter(([needle]) => html.includes(needle)).map(([, label]) => label);
}

/** Rough text extraction, enough for the spec's text-content checks. */
export function textContent(html) {
  return html
    .replace(SCRIPT_BLOCK, ' ')
    .replace(STYLE_BLOCK, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}
