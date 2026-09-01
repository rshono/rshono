/**
 * Type-level tests for `defineRoutes`.
 *
 * `ValidateRoutes` is the most intricate type in the package and its whole job is to **fail**: a page whose
 * props do not match its own `path`, a `staticPaths` whose param sets do not fill it. CI typechecks the
 * testbed against the *published* declarations, which covers the positive case — nothing asserted that the
 * negative one is still an error, so a refactor could switch the check off in silence.
 *
 * Every `@ts-expect-error` below is that assertion: if the check it names stops working, the directive
 * becomes an unused-directive error and this file fails to compile. Each one sits above the whole
 * `defineRoutes(...)` call, because that — the argument — is where an overload mismatch is reported.
 *
 * Outside `src/`, so nothing bundles it: `tsconfig.json` includes this directory and `rshono build` does
 * not.
 */
import { defineRoutes, type PageProps } from '@rshono/core';

const anyPage = () => Promise.resolve({ default: (_props: PageProps) => null });
const idPage = () => Promise.resolve({ default: (_props: PageProps<'/u/:id'>) => null });
const abPage = () => Promise.resolve({ default: (_props: PageProps<'/a/:b'>) => null });
const endpoint = () => Promise.resolve({ handler: () => new Response('ok') });

// ── The path ↔ props check ─────────────────────────────────────────────────────────────────────────────

export const matchingProps = defineRoutes([{ path: '/u/:id', component: idPage }]);
export const openProps = defineRoutes([{ path: '/u/:id', component: anyPage }]);
export const bothForms = defineRoutes({ routes: [{ path: '/u/:id', component: idPage }], notFound: { component: anyPage } });

// @ts-expect-error — props are typed for '/a/:b', the route is '/u/:id'.
export const mismatchedProps = defineRoutes([{ path: '/u/:id', component: abPage }]);
// @ts-expect-error — the same mismatch through the config form, which is a separate overload.
export const mismatchedInConfig = defineRoutes({ routes: [{ path: '/u/:id', component: abPage }] });
// @ts-expect-error — a params-typed page on a path that has no params at all.
export const paramsOnAStaticPath = defineRoutes([{ path: '/about', component: idPage }]);

// ── The staticPaths ↔ path check ───────────────────────────────────────────────────────────────────────

export const filledParams = defineRoutes([{ path: '/u/:id', render: 'static', component: idPage, staticPaths: async () => [{ id: '1' }] }]);
export const extraKeys = defineRoutes([{ path: '/u/:id', render: 'static', component: idPage, staticPaths: async () => [{ id: '1', name: 'a' }] }]);
// An index signature carries no key to compare, so the type the field itself declares stays accepted and
// the build reports such a mismatch instead.
export const openRecord = defineRoutes([
  { path: '/u/:id', render: 'static', component: idPage, staticPaths: async (): Promise<Array<Record<string, string>>> => [{ id: '1' }] },
]);

// @ts-expect-error — 'slug' is not a param of '/u/:id'.
export const wrongKey = defineRoutes([{ path: '/u/:id', render: 'static', component: idPage, staticPaths: async () => [{ slug: 'a' }] }]);
// @ts-expect-error — a param set that fills nothing.
export const emptySet = defineRoutes([{ path: '/u/:id', render: 'static', component: idPage, staticPaths: async () => [{}] }]);

// ── Endpoint routes ────────────────────────────────────────────────────────────────────────────────────

export const oneMethod = defineRoutes([{ type: 'endpoint', path: '/api/x', method: 'get', server: endpoint }]);
export const listedMethods = defineRoutes([{ type: 'endpoint', path: '/api/x', method: ['get', 'delete'], server: endpoint }]);
export const everyMethod = defineRoutes([{ type: 'endpoint', path: '/api/x', server: endpoint }]);

// @ts-expect-error — there is no 'head': Hono dispatches a HEAD as a GET, so 'get' answers both.
export const headMethod = defineRoutes([{ type: 'endpoint', path: '/api/x', method: 'head', server: endpoint }]);
// @ts-expect-error — and not inside a list either.
export const headInAList = defineRoutes([{ type: 'endpoint', path: '/api/x', method: ['get', 'head'], server: endpoint }]);
