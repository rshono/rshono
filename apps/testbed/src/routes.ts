import { defineRoutes } from '@rshono/core';

export const routes = defineRoutes({
  routes: [
    {
      path: '/',
      component: () => import('./components/home'),
    },
    {
      path: '/signup',
      component: () => import('./components/signup'),
    },
    {
      path: '/crash',
      component: () => import('./components/crash'),
    },
    {
      path: '/login',
      component: () => import('./components/login'),
    },
    {
      path: '/dashboard',
      component: () => import('./components/dashboard'),
    },
    {
      path: '/docs/:slug',
      render: 'static',
      component: () => import('./components/documentation'),
      staticPaths: async () => {
        const { fakeDB } = await import('./db');
        return (await fakeDB.listDocs()).map((doc) => ({ slug: doc.slug }));
      },
    },
    {
      path: '/profile/:id',
      component: () => import('./components/profile'),
    },
    {
      path: '/users',
      component: () => import('./components/user-list'),
    },
    {
      path: '/whoami',
      component: () => import('./components/whoami'),
    },
    {
      path: '/suspense-redirect',
      component: () => import('./components/suspense-redirect'),
    },
    {
      path: '/boundary',
      component: () => import('./components/boundary-demo'),
    },
    {
      path: '/late-signal',
      component: () => import('./components/late-signal'),
    },
    {
      // Deliberately broken, and linked from nowhere: its module throws as it evaluates. See the component.
      path: '/unloadable',
      component: () => import('./components/unloadable'),
    },
    {
      type: 'endpoint',
      path: '/api/quick-health',
      // `'get'` and not `'head'`, which the union no longer offers: Hono dispatches a HEAD as a GET, so
      // this one registration answers both — and a HEAD-only route would answer neither.
      method: 'get',
      server: () => import('./health'),
    },
    {
      type: 'endpoint',
      path: '/api/preflight',
      // The one method a page route never answers and a cross-origin action needs answered: a CORS
      // preflight is an OPTIONS.
      method: 'options',
      server: () => import('./preflight'),
    },
    {
      type: 'endpoint',
      path: '/api/session',
      // Two methods, one handler. The alternative is `'all'` plus a hand-rolled check, which would also
      // answer every method nobody asked it to.
      method: ['get', 'delete'],
      server: () => import('./session'),
    },
    {
      type: 'endpoint',
      path: '/api/boom',
      server: () => import('./boom'),
    },
  ],
  notFound: {
    component: () => import('./components/404'),
  },
  error: {
    component: () => import('./components/500'),
  },
});
