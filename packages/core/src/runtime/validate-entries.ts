/**
 * The two modules an app hands the framework — `src/routes.ts` and `src/server.ts` — checked before
 * anything is built on them.
 *
 * Both arrive through a build-time alias that carries no type the compiler can hold on to, so they used to
 * be cast and the mistake found later, somewhere else: a `routes` array that skipped `defineRoutes` surfaced
 * as `TypeError: nN is not iterable` from a minified bundle, and a `src/server.ts` exporting the wrong thing
 * as `Cannot read properties of undefined (reading 'map')` from inside Hono. Neither names the file to open.
 * The mistakes that produced no error at all were worse: a duplicated `path` whose second entry silently
 * never ran, a `staticPaths` on a route that renders per request.
 *
 * Everything here runs once, at module load — during `rshono build`, which imports the server bundle for the
 * prerender pass; at `rshono dev` startup; and when a deployed server boots.
 */

import type { Hono } from 'hono';
import { isPageRoute, type Route, type RouteConfig } from '../router.js';

/** Every method an endpoint route can name, `'all'` aside — which is also what `'all'` is expanded to below. */
const CONCRETE_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options'];
const METHODS = new Set([...CONCRETE_METHODS, 'all']);

/** What a page route's `render` accepts. */
const RENDER_MODES = ['static', 'dynamic'];

function fail(message: string): never {
  throw new Error(`[rshono] ${message}`);
}

/**
 * How a route is named in a message. Always by position, because that is what a duplicate `path` needs to be
 * told apart, and by path as well wherever there is one.
 */
function label(route: unknown, index: number): string {
  const path = (route as { path?: unknown } | null)?.path;
  return typeof path === 'string' ? `routes[${index}] ("${path}")` : `routes[${index}]`;
}

/** Refuses a key that belongs to the *other* kind of route — see {@link validateRoute}. */
function refuseForeignKeys(route: Record<string, unknown>, name: string, keys: readonly string[], advice: string): void {
  for (const key of keys) {
    if (route[key] !== undefined) fail(`src/routes.ts: ${name} has \`${key}\`, which ${advice}`);
  }
}

/**
 * Checks one entry of the route table.
 *
 * The cross-kind key checks are the ones TypeScript cannot make: excess-property checking against a union
 * accepts any key present in *some* member, so `staticPaths` on an `{ type: 'endpoint' }` route type-checks
 * and is then ignored at runtime — which is indistinguishable from prerendering that quietly does nothing.
 */
function validateRoute(route: unknown, index: number): void {
  if (route === null || typeof route !== 'object') {
    fail(`src/routes.ts: routes[${index}] is ${route === null ? 'null' : typeof route}, not a route object.`);
  }
  const entry = route as Record<string, unknown>;
  const name = label(route, index);

  if (typeof entry.path !== 'string' || !entry.path.startsWith('/')) {
    fail(`src/routes.ts: ${name} needs a \`path\` starting with "/".`);
  }
  if (entry.type !== undefined && entry.type !== 'endpoint') {
    fail(`src/routes.ts: ${name} has type ${JSON.stringify(entry.type)} — the only \`type\` is 'endpoint', and a page route omits it.`);
  }

  if (entry.type === 'endpoint') {
    if (typeof entry.server !== 'function') {
      fail(`src/routes.ts: ${name} is an endpoint, so it needs \`server\` — a function importing the module that exports \`handler\`.`);
    }
    if (entry.method !== undefined && (typeof entry.method !== 'string' || !METHODS.has(entry.method))) {
      const meantHead = typeof entry.method === 'string' && entry.method.toLowerCase() === 'head';
      fail(
        `src/routes.ts: ${name} has method ${JSON.stringify(entry.method)}, which is not one of ${[...METHODS].join(', ')}.` +
          (meantHead ? " A HEAD is dispatched as a GET, so use 'get' — a route registered for HEAD alone answers neither." : ''),
      );
    }
    refuseForeignKeys(
      entry,
      name,
      ['component', 'render', 'staticPaths'],
      "only a page route has — an endpoint's `server` handler decides its own response.",
    );
  } else {
    if (typeof entry.component !== 'function') {
      fail(`src/routes.ts: ${name} needs \`component\` — a function importing the page module, e.g. \`() => import('./pages/home')\`.`);
    }
    if (entry.render !== undefined && (typeof entry.render !== 'string' || !RENDER_MODES.includes(entry.render))) {
      fail(`src/routes.ts: ${name} has render ${JSON.stringify(entry.render)} — it is 'static' or 'dynamic'.`);
    }
    if (entry.staticPaths !== undefined) {
      if (typeof entry.staticPaths !== 'function') fail(`src/routes.ts: ${name} has a \`staticPaths\` that is not a function.`);
      if (entry.render !== 'static') {
        fail(`src/routes.ts: ${name} has \`staticPaths\` but is not \`render: 'static'\`, so it renders per request and the paths are never built.`);
      }
    }
    refuseForeignKeys(entry, name, ['server', 'method'], "only an endpoint route has — add `type: 'endpoint'` if that is what this is.");
  }
}

/** The methods a route answers, with `'all'` expanded, so two registrations can be compared. */
function methodsOf(route: Route): readonly string[] {
  // A page is registered for GET and POST: the POST is how a `<form action={serverAction}>` reaches it.
  if (isPageRoute(route)) return ['get', 'post'];
  const method = route.method ?? 'all';
  return method === 'all' ? CONCRETE_METHODS : [method];
}

/**
 * Refuses a route the table already answers in full. Hono matches in registration order, so a later entry
 * whose every method and path is spoken for is dead code — and the build that produced it exits 0 with
 * nothing to say, which is how a duplicated `path` survives.
 *
 * Method by method, and only when *all* of them are taken: one path split between a `'get'` endpoint and a
 * `'post'` one shadows nothing, and neither does a catch-all registered behind a route that claims one
 * method of it — that one still answers the rest.
 */
function assertNothingIsShadowed(routes: readonly Route[]): void {
  /** `"<method> <path>"` → the first route answering it. */
  const claimed = new Map<string, string>();
  routes.forEach((route, index) => {
    const name = label(route, index);
    const methods = methodsOf(route);
    const claimants = methods.map((method) => claimed.get(`${method} ${route.path}`));
    if (claimants.every((claimant) => claimant !== undefined)) {
      const by = [...new Set(claimants)].join(' and ');
      const verbs = methods.map((method) => method.toUpperCase()).join(', ');
      fail(`src/routes.ts: ${name} would never run — ${by} already answers ${verbs} ${route.path}, and Hono matches in registration order.`);
    }
    for (const method of methods) {
      const key = `${method} ${route.path}`;
      if (!claimed.has(key)) claimed.set(key, name);
    }
  });
}

function validateFallbackPage(page: unknown, field: 'notFound' | 'error'): void {
  if (page === undefined || page === null) return;
  if (typeof page !== 'object' || typeof (page as { component?: unknown }).component !== 'function') {
    fail(`src/routes.ts: \`${field}\` must be a page — \`{ component: () => import('./pages/${field}') }\`.`);
  }
}

/**
 * Normalises and checks what `src/routes.ts` exported as `routes`.
 *
 * A bare array is accepted alongside a {@link RouteConfig}, because the docs present both and
 * `defineRoutes` is an identity function over the array form — which makes leaving it off look equivalent
 * right up to the point the build fails somewhere unrelated.
 */
export function validateRoutesModule(exported: unknown): RouteConfig {
  const config = (Array.isArray(exported) ? { routes: exported as Route[] } : exported) as RouteConfig | null | undefined;
  if (config === null || config === undefined || typeof config !== 'object' || !Array.isArray(config.routes)) {
    fail(
      'src/routes.ts must export `routes` as a route array, or as a { routes, notFound?, error? } object — ' +
        'wrap it in `defineRoutes(…)` to have TypeScript check it for you.',
    );
  }

  config.routes.forEach(validateRoute);
  assertNothingIsShadowed(config.routes);
  validateFallbackPage(config.notFound, 'notFound');
  validateFallbackPage(config.error, 'error');
  return config;
}

/**
 * The Hono app `src/server.ts` default-exports, or `null` for an app that has no `src/server.ts` — the
 * fallback module the alias resolves to instead default-exports exactly that.
 *
 * Duck-typed rather than `instanceof Hono`: what the framework does with the value is `app.route('/', …)`,
 * which reads `routes` off it and mounts the handlers, so those are what have to be there.
 */
export function validateServerApp(exported: unknown): Hono | null {
  const app = (exported as { default?: unknown } | null)?.default;
  if (app === null || app === undefined) return null;
  if (typeof app !== 'object' || typeof (app as Hono).fetch !== 'function' || !Array.isArray((app as Hono).routes)) {
    fail('src/server.ts must `export default` a Hono app — `const server = new Hono(); … export default server;`.');
  }
  return app as Hono;
}
