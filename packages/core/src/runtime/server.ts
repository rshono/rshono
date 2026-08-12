/**
 * `@rshono/core/server` — the request-scoped surface, for server components and `'use server'` action
 * modules: `getRequestContext()` for the URL, cookies, params, env and middleware variables, the
 * `redirect()` and `notFound()` control-flow helpers, and `onServerError()` for reporting the errors
 * the framework catches. Plus `publicUrl(c)` for middleware, which is handed Hono's `c` rather than a
 * request context.
 *
 * Server-only: a `'use client'` module runs in the browser, with no bound context. Read what you need
 * on the server and pass it down as props, or use `useNavigation()` from `@rshono/core/client`.
 *
 * @example
 * ```ts
 * 'use server';
 * import { getRequestContext, redirect } from '@rshono/core/server';
 *
 * export async function logout() {
 *   getRequestContext().cookies.delete('session', { path: '/' });
 *   redirect('/');
 * }
 * ```
 *
 * @see {@link https://www.rshono.com/docs/api#rshonocoreserver | Docs — `@rshono/core/server`}
 *
 * @packageDocumentation
 */

// A barrel rather than pointing the subpath at `./context.js`, which also exports the framework's own
// plumbing — that would put `runWithContext` and friends in a consumer's autocomplete and under semver.
export {
  getRequestContext,
  notFound,
  onServerError,
  publicUrl,
  redirect,
  type EnvVars,
  type RedirectStatus,
  type RequestContext,
  type ServerErrorContext,
  type ServerErrorHandler,
  type ServerErrorSource,
} from './context.js';
