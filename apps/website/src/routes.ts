import { defineRoutes } from '@rshono/core';
import { DOCS } from './content/docs';

/**
 * The one file rshono requires. It only ever runs on the server, so importing server-only modules from
 * it — inside `staticPaths`, say — is safe.
 *
 * Every page here is `render: 'static'`: this is a documentation site, so there is nothing per-request
 * to render and no reason to render it more than once. That is also why no page reads `ctx` — a
 * prerendered page has no request to read one from.
 */
export const routes = defineRoutes({
  routes: [
    {
      path: '/',
      render: 'static',
      component: () => import('./components/home'),
    },
    /*
     * Ahead of `/benchmarks`, for the same reason the markdown endpoint sits ahead of `/docs/:slug`:
     * a `.` is not a path separator, so a literal route would not match `/benchmarks.md` anyway — but
     * keeping the pair adjacent and in this order is what stops that from becoming a surprise later.
     */
    {
      type: 'endpoint',
      method: 'get',
      path: '/benchmarks.md',
      server: () => import('./routes/benchmark-markdown'),
    },
    {
      path: '/benchmarks',
      render: 'static',
      component: () => import('./components/benchmarks'),
    },
    {
      path: '/docs',
      render: 'static',
      component: () => import('./components/docs-index'),
    },
    /*
     * Ahead of `/docs/:slug`, and deliberately.
     *
     * A `.` is not a path separator, so `/docs/:slug` would happily match `/docs/routing.md` and hand
     * the page a slug it has no content for. The regex is what keeps this route to the markdown
     * requests, and the order is what gives it first refusal on them.
     */
    {
      type: 'endpoint',
      method: 'get',
      path: '/docs/:slug{[a-z0-9-]+\\.md}',
      server: () => import('./routes/doc-markdown'),
    },
    /* Ahead of `/docs/:slug` for the same reason as the markdown endpoint: it has to win the match. */
    {
      type: 'endpoint',
      method: 'get',
      path: '/docs/server-actions',
      server: () => import('./routes/moved-doc'),
    },
    {
      path: '/docs/:slug',
      render: 'static',
      component: () => import('./components/documentation'),
      // No I/O: the content is bundled, so the page list is a compile-time constant.
      staticPaths: () => DOCS.map((doc) => ({ slug: doc.slug })),
    },
    {
      type: 'endpoint',
      method: 'get',
      path: '/llms.txt',
      server: () => import('./routes/llms-txt'),
    },
    {
      type: 'endpoint',
      method: 'get',
      path: '/llms-full.txt',
      server: () => import('./routes/llms-full-txt'),
    },
    {
      type: 'endpoint',
      method: 'get',
      path: '/sitemap.xml',
      server: () => import('./routes/sitemap'),
    },
  ],
  notFound: { component: () => import('./components/404') },
  error: { component: () => import('./components/500') },
});
