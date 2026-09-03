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
 * The route *table* is checked at module load — during `rshono build`, which imports the server bundle for
 * the prerender pass; at `rshono dev` startup; and when a deployed server boots. The modules the table points
 * *at* cannot be, because they load lazily: {@link assertPageModule} and {@link assertEndpointModule} run on
 * first request, and {@link assertRouteModules} runs both against every route during `rshono build`.
 */

import type { Handler, Hono } from 'hono';
import type { ServerEntry } from 'react-server-dom-rspack/server';
import { isPageRoute, type PageComponent, type Route, type RouteConfig } from '../router.js';

/** Every method an endpoint route can name, `'all'` aside — which is also what `'all'` is expanded to below. */
const CONCRETE_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options'];
const METHODS = new Set([...CONCRETE_METHODS, 'all']);

/** What a page route's `render` accepts. */
const RENDER_MODES = ['static', 'dynamic'];

/**
 * The one path prefix the framework claims on every deploy target: the hashed client bundle, mounted by
 * `runtime.mountStaticAssets` ahead of the route table, ending in a terminal 404 — so nothing under it
 * reaches a page. Written out here rather than imported, because the mounts live in the deploy runtimes
 * (`deploy/filesystem.ts`, `deploy/cloudflare/runtime.ts`) and in `cli/dev.ts`, none of which this module
 * can pull in.
 *
 * It is the only one. `/_rshono/hmr` is dev-only and an exact path rather than a prefix, and Cloudflare's
 * `__ssg` is an asset path no app would name.
 */
const RESERVED_PREFIX = '/_static';

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
    if (entry.method !== undefined) validateMethod(entry.method, name);
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

/**
 * Checks an endpoint's `method`, which is one method or a list of them.
 *
 * A list is checked member by member so the message names the bad one rather than printing the array, and
 * `'all'` is refused inside one: a list meaning every method is a list its author did not mean to write.
 */
function validateMethod(method: unknown, name: string): void {
  if (Array.isArray(method)) {
    if (method.length === 0) fail(`src/routes.ts: ${name} has an empty \`method\` list — omit it to answer every method.`);
    for (const entry of method as unknown[]) {
      if (entry === 'all') {
        fail(`src/routes.ts: ${name} has 'all' inside a \`method\` list — use \`method: 'all'\`, or list the methods it answers.`);
      }
      validateMethod(entry, name);
    }
    return;
  }
  if (typeof method !== 'string' || !METHODS.has(method)) {
    const meantHead = typeof method === 'string' && method.toLowerCase() === 'head';
    fail(
      `src/routes.ts: ${name} has method ${JSON.stringify(method)}, which is not one of ${[...METHODS].join(', ')}.` +
        (meantHead ? " A HEAD is dispatched as a GET, so use 'get' — a route registered for HEAD alone answers neither." : ''),
    );
  }
}

/** The methods a route answers, with `'all'` expanded and a list flattened, so two can be compared. */
function methodsOf(route: Route): readonly string[] {
  // A page is registered for GET and POST: the POST is how a `<form action={serverAction}>` reaches it.
  if (isPageRoute(route)) return ['get', 'post'];
  const methods = [route.method ?? 'all'].flat();
  return methods.includes('all') ? CONCRETE_METHODS : methods;
}

/**
 * A parameter's *name*, which is not part of the pattern Hono matches on. Anchored to a segment boundary so
 * a `:` inside a `{regex}` constraint is not mistaken for one, and stopped by `{` and `?` — both of which
 * *are* part of the pattern and have to survive into the key.
 */
const PARAM_NAME = /(?<=\/):[^/{?]+/g;

/**
 * What Hono matches on, rather than what was typed — so two spellings of one pattern hash alike.
 *
 * - **A parameter's name is not part of it.** `/u/:id` and `/u/:name` are one route, and whichever is
 *   registered second never runs. A `{regex}` constraint is kept, because that one *is* part of the
 *   pattern: `/a/:id{[0-9]+}` and `/a/:name` are genuinely different routes and both can answer.
 * - **A `*` before the last segment matches exactly one non-empty segment** — the same thing an
 *   unconstrained parameter matches. Checked against Hono 4.13: `/a/[*]/c` and `/a/:id/c` both answer
 *   `/a/b/c`, both 404 `/a//c`, and both 404 `/a/b/x/c`.
 *
 * A *trailing* `*` is left alone: it claims a whole subtree rather than one segment, which is
 * {@link subtreeOf}'s half of the job.
 */
function patternKey(path: string): string {
  const segments = path.replace(PARAM_NAME, ':').split('/');
  return segments.map((segment, index) => (segment === '*' && index < segments.length - 1 ? ':' : segment)).join('/');
}

/**
 * Every key a route answers. More than one only for a trailing optional parameter: `/a/:id?` answers
 * `/a/x` *and* `/a`, and — checked — neither `/a/` nor `/a/x/y`. Both have to be spoken for before it is
 * dead, which is why this is a list rather than a key.
 */
function keysFor(path: string): readonly string[] {
  const key = patternKey(path);
  if (!key.endsWith('/:?')) return [key];
  return [key.slice(0, -1), key.slice(0, -3) || '/'];
}

/**
 * The subtree a trailing `*` claims, or `null` for a path without one. `/a/*` answers `/a/b` and
 * `/a/b/c/d`, and the bare `/a` as well — but not `/ab`, so the boundary is the `/` and a prefix test has
 * to respect it.
 */
function subtreeOf(key: string): string | null {
  return key.endsWith('/*') ? key.slice(0, -2) : null;
}

/** Whether the subtree claimed by a trailing `*` at `prefix` contains `key`. */
function covers(prefix: string, key: string): boolean {
  return key === prefix || key.startsWith(`${prefix}/`);
}

/**
 * Whether a path sits inside {@link RESERVED_PREFIX}'s subtree, which is the prefix and everything below
 * it. The boundary is the `/`: `/_staticky` is an ordinary path and answers normally.
 */
function isReserved(path: string): boolean {
  return path === RESERVED_PREFIX || path.startsWith(`${RESERVED_PREFIX}/`);
}

/**
 * Refuses a route the table already answers in full, or that the framework's own mount already answers.
 * Hono matches in registration order, so a later entry whose every method and path is spoken for is dead
 * code — and the build that produced it exits 0 with nothing to say, which is how a duplicated `path`
 * survives.
 *
 * The framework's mount is checked first and by name. The rest of this function compares the app's routes
 * with *each other*, so the prefixes the framework registers ahead of them were invisible to it: a route at
 * `/_static/thing` built clean and then 404'd, on every target and in dev. Only a literal path is refused —
 * a parameterised route that happens to match under the prefix, `/:section/thing` or a root `/*`, still
 * answers everything else and is none of this rule's business.
 *
 * Method by method, and only when *all* of them are taken: one path split between a `'get'` endpoint and a
 * `'post'` one shadows nothing, and neither does a catch-all registered behind a route that claims one
 * method of it — that one still answers the rest.
 *
 * Keyed on the *pattern* rather than on the path as written, because a dead route need not be a duplicated
 * string. Two shapes reached a build this way: `/u/:id` followed by `/u/:name`, which is the same route
 * twice under two spellings, and a wildcard registered *ahead* of a concrete path — `/a/*` then `/a/b` —
 * where the second can never be reached. The doc comment above used to discuss only the opposite order, a
 * catch-all registered behind a route, which is the case that is fine.
 *
 * **Where the line is drawn**, for whoever widens this next. A `{regex}` constraint is kept in the key and
 * compared as text, so `/a/:id{[0-9]+}` then `/a/:n{[0-9]+}` is caught and `/a/:id{[0-9]+}` then
 * `/a/:id{\d+}` is not — the second pair is equivalent, and the later route is dead, and this accepts it.
 * Deciding regex equivalence in general is undecidable-adjacent and not a route validator's job. The same
 * goes for a constraint containing a `/`, which the key carries through unchanged rather than interpreting.
 * Both leave the error on the safe side: an unreachable route slips through, and a route that can still
 * answer is never refused. Anything added here should keep that asymmetry — a false refusal fails a build
 * that was correct, which is much worse than the hole it would close.
 */
function assertNothingIsShadowed(routes: readonly Route[]): void {
  /** `"<method> <key>"` → the first route answering it. */
  const claimed = new Map<string, { name: string; path: string }>();
  /** The trailing-`*` routes already registered, which claim a whole subtree rather than single keys. */
  const subtrees: { method: string; prefix: string; name: string; path: string }[] = [];

  const claimantOf = (method: string, key: string) =>
    claimed.get(`${method} ${key}`) ?? subtrees.find((subtree) => subtree.method === method && covers(subtree.prefix, key));

  routes.forEach((route, index) => {
    const name = label(route, index);
    if (isReserved(route.path)) {
      fail(
        `src/routes.ts: ${name} would never run — the framework serves the client bundle at ${RESERVED_PREFIX}, ` +
          `mounted ahead of the route table and answering that whole subtree, so ${RESERVED_PREFIX} is reserved on every ` +
          'deploy target and under `rshono dev`. Give the route a path of its own.',
      );
    }
    const methods = methodsOf(route);
    const keys = keysFor(route.path);
    const claimants = methods.flatMap((method) => keys.map((key) => claimantOf(method, key)));
    if (claimants.every((claimant) => claimant !== undefined)) {
      const by = [...new Set(claimants.map((claimant) => claimant.name))].join(' and ');
      const verbs = methods.map((method) => method.toUpperCase()).join(', ');
      // Only when the two are spelled differently, which is the part that reads as a false alarm: an exact
      // duplicate needs no explaining, and this sentence would only get in its way.
      const why = claimants.some((claimant) => claimant.path === route.path)
        ? ''
        : ' Hono matches on the pattern, not the spelling — a parameter’s name is not part of it, and a trailing `*` answers its whole subtree, the bare prefix included.';
      fail(`src/routes.ts: ${name} would never run — ${by} already answers ${verbs} ${route.path}, and Hono matches in registration order.${why}`);
    }
    for (const method of methods) {
      for (const key of keys) {
        if (!claimed.has(`${method} ${key}`)) claimed.set(`${method} ${key}`, { name, path: route.path });
      }
      const prefix = subtreeOf(patternKey(route.path));
      if (prefix !== null) subtrees.push({ method, prefix, name, path: route.path });
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

/**
 * The server component a page module must default-export, checked rather than cast.
 *
 * Two structural mistakes land here, and neither can serve *any* request, which is why they are also checked
 * at build time by {@link assertRouteModules}:
 *
 * - no default export at all — a named `export function Page`, or a file that exports its layout instead;
 * - a `'use client'` page. That module's default export is a client reference, so it carries no
 *   `entryJsFiles` — the list of scripts the document has to boot, recorded only for a *server* entry.
 *   Rendering it anyway would produce a page with no client runtime, which is worse than a message.
 */
export function assertPageModule(mod: { default?: unknown }, label: string): ServerEntry<PageComponent> {
  const Page = mod.default as ServerEntry<PageComponent> | undefined;
  if (typeof Page !== 'function') {
    fail(`The page module for ${label} must default-export a server component.`);
  }
  if (!Page.entryJsFiles) {
    fail(
      `The page component for ${label} is missing its client-asset info ('use server-entry'). ` +
        "The directive is added automatically for inline `component: () => import('…')` thunks in routes.ts. " +
        "If this page is wired up another way, put 'use server-entry' on the first line of the page module yourself — " +
        "and make sure the page is a server component (a 'use client' page must be wrapped by a server component instead).",
    );
  }
  return Page;
}

/**
 * The Hono handler an endpoint module must export as `handler`.
 *
 * The page half of this fork has been checked since it existed; this half used to destructure and call, which
 * turns the one mistake people actually make — a method-named export, the shape other frameworks ask for —
 * into `TypeError: r is not a function` from a minified frame. That is verbatim the failure mode this file's
 * header names as the reason it exists.
 */
export function assertEndpointModule(mod: { handler?: unknown }, label: string): Handler {
  const handler = mod.handler;
  if (typeof handler !== 'function') {
    fail(
      `The endpoint module for ${label} must export \`handler\` — \`export const handler: Handler = (c) => c.json({ ok: true });\`. ` +
        'One `handler` answers every method the route declares, so a method-named export (`GET`, `POST`) is never read.',
    );
  }
  return handler as Handler;
}

/**
 * Resolves every route's own module once and runs the two checks above against it — what `rshono build` does
 * once the bundle exists, so a route that cannot serve *any* request fails the build instead of exiting 0 and
 * answering 500 in production for the life of the deployment.
 *
 * Every route is checked, not just the first that fails: these are all fixed by editing a file, and a build
 * that names one of four broken routes costs three more builds to get through.
 *
 * A module that throws while *evaluating* is warned about rather than raised. Checking a module's shape means
 * importing it, and whether an import succeeds is a question about the environment, not about the module: a
 * page whose module scope reads a secret, opens a connection or touches a file that only exists in production
 * fails here and works per request. Failing the build on that would make "every route module must be
 * importable during the build" a new requirement on apps, to catch a mistake this cannot tell from a
 * deliberate one. A `render: 'static'` route is the exception, and needs nothing here: it promised to render
 * at build time, so the prerender pass demands the import and fails the build when it throws.
 */
export async function assertRouteModules(config: RouteConfig): Promise<void> {
  const failures: string[] = [];

  /**
   * Loads one route's module, or reports why it could not be checked. `null` — never a silent skip: the
   * whole point of running at build time is saying what was and was not looked at.
   */
  const load = async <T>(thunk: () => Promise<T>, label: string): Promise<T | null> => {
    try {
      return await thunk();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`  ⚠ ${label} could not be loaded at build time, so its module was not checked — ${reason}`);
      return null;
    }
  };

  /** Keeps a check's message instead of raising it, so every broken route is named rather than the first. */
  const check = (assert: () => void): void => {
    try {
      assert();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  };

  for (const route of config.routes) {
    const label = `"${route.path}"`;
    if (isPageRoute(route)) {
      const mod = await load(route.component, label);
      if (mod) check(() => assertPageModule(mod, label));
    } else {
      const mod = await load(route.server, label);
      if (mod) check(() => assertEndpointModule(mod, label));
    }
  }
  for (const [page, label] of [
    [config.notFound, 'the notFound page'],
    [config.error, 'the error page'],
  ] as const) {
    if (!page) continue;
    const mod = await load(page.component, label);
    if (mod) check(() => assertPageModule(mod, label));
  }

  // One failure — overwhelmingly the common case — is raised as itself, so the message reads the way it
  // does on the request path. Several are gathered under a count, each stripped of the prefix the whole
  // list now carries once.
  if (failures.length === 1) throw new Error(failures[0]);
  if (failures.length > 1) {
    fail(
      `${failures.length} route modules cannot serve a request:\n` +
        failures.map((message) => `      • ${message.replace(/^\[rshono\] /, '')}`).join('\n'),
    );
  }
}
