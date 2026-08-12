/**
 * `@rshono/core/client` — the browser-side surface: `useNavigation()` for the current URL and soft
 * navigation, plus the `<AsyncBoundary>` and `<CatchBoundary>` components.
 *
 * Every export is itself a `'use client'` module, so a server component can render `<AsyncBoundary>`
 * directly — but the hook needs a client component. In a server component, read the same request data
 * from `getRequestContext()` in `@rshono/core/server`.
 *
 * @example
 * ```tsx
 * 'use client';
 * import { useNavigation } from '@rshono/core/client';
 *
 * export function Tab() {
 *   const { url, router } = useNavigation();
 *   return <button onClick={() => router.push(`${url.pathname}?tab=details`)}>Details</button>;
 * }
 * ```
 *
 * @see {@link https://www.rshono.com/docs/api#rshonocoreclient | Docs — `@rshono/core/client`}
 *
 * @packageDocumentation
 */

export { useNavigation, type NavigationRouter, type NavigationState } from './navigation.js';
export { AsyncBoundary, CatchBoundary, type AsyncBoundaryProps, type CatchBoundaryProps, type ErrorFallback } from './boundaries.js';
