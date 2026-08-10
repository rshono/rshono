---
title: Styling & assets
description: Native CSS code-split per route, the four lines that add Tailwind, and public/.
---

Import a stylesheet from any component:

```tsx
import './styles.css';
```

Rspack's native CSS pipeline compiles it, and the import **attaches the stylesheet to the importing
page's assets**. CSS is therefore code-split per route and `<link>`ed in the streamed HTML rather than
fetched after hydration. `*.module.css` gets a class map.

## No PostCSS in the framework

Not as a dependency, not as an optional one. Native CSS is everything a plain stylesheet needs — but
that parser reads _finished_ CSS, and `@import 'tailwindcss'`, `@theme` and `@apply` are not that. A
stylesheet that needs a plugin brings the plugin itself, through the
[`rspack` hook](/docs/configuration#the-rspack-hook).

## Tailwind

Four things, and `npx @rshono/create@latest --tailwind` writes all of them:

```bash
npm i -D tailwindcss @tailwindcss/postcss postcss postcss-loader
```

```ts
// rshono.config.ts — the hook is called once per compiler, so this reaches both graphs
export default defineConfig({
  rspack(config) {
    config.module!.rules!.push({ test: /\.css$/i, use: ['postcss-loader'], type: 'css/auto' });
  },
});
```

```js
// postcss.config.mjs — the plugin list, which postcss-loader finds on its own
export default { plugins: { '@tailwindcss/postcss': {} } };
```

```css
/* src/styles.css */
@import 'tailwindcss';
```

Keep `type: 'css/auto'` rather than `'css'`, or `*.module.css` stops being a CSS module. Any other
PostCSS plugin is the same shape — the rule puts postcss-loader in the chain, `postcss.config.mjs` says
which plugins run.

## public/

Anything in `public/` is served verbatim at the **web root**, and copied into `dist/` by the build:

```
public/favicon.ico       →  /favicon.ico
public/robots.txt        →  /robots.txt
public/.well-known/…     →  /.well-known/…
```

It is a fallback: routes always win, and unmatched paths still reach the `notFound` page, so a `public/`
file never shadows a route.

## Caching

| What                 | Served from | Caching                             |
| -------------------- | ----------- | ----------------------------------- |
| Hashed bundle output | `/_static/` | long-lived, `immutable`             |
| `public/` files      | web root    | short `max-age` (`no-cache` in dev) |

A bundle filename contains its content hash, so it can be cached forever. `public/favicon.svg` is the
same URL whatever its contents, so it cannot. On a platform with a CDN both go straight to the CDN;
[prerendered pages do not](/docs/deployment#prerendered-pages-are-never-cdn-served).
