/**
 * `@rshono/core` — the build-time surface: route and config declaration, plus the types
 * your pages and endpoints are written against. Nothing here pulls in runtime machinery.
 *
 * Two companion entry points are runtime-only:
 * - `@rshono/core/server` — request context, `redirect`, `notFound`, `onServerError`.
 * - `@rshono/core/client` — `useNavigation`, `AsyncBoundary`, `CatchBoundary`.
 *
 * @example
 * ```ts
 * // src/routes.ts
 * import { defineRoutes } from '@rshono/core';
 *
 * export const routes = defineRoutes([{ path: '/', component: () => import('./components/home') }]);
 * ```
 *
 * @see {@link https://www.rshono.com/docs/api | Docs — API reference}
 *
 * @packageDocumentation
 */

export {
  defineRoutes,
  type EndpointRoute,
  type EndpointServerModule,
  type ErrorPageInfo,
  type ErrorPageProps,
  type FallbackPage,
  type HTTPMethod,
  type PageComponent,
  type PageProps,
  type PageRoute,
  type PathParams,
  type Route,
  type RouteConfig,
} from './router.js';

export { defineConfig, type RshonoConfig, type RspackHookContext } from './config.js';

export type { DeployTarget } from './deploy/contract.js';

// Hono's `Context` and `Handler` are deliberately not re-exported — `hono` is a peer dependency, so
// endpoints import them from there rather than from two spellings of the same type.
