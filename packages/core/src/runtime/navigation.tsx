'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * Imperative navigation actions, reached as `useNavigation().router`.
 *
 * Every action is a **soft** navigation: the page's flight payload is fetched and applied in place, so
 * client component state outside the changed subtree survives. Off-site hrefs — and a traversal that leaves
 * the app — fall back to a full load.
 *
 * Soft navigation is the browser's
 * {@link https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API | Navigation API}; where that is
 * missing, every action below is still correct and simply performs a real browser load.
 *
 * @example
 * ```tsx
 * const { router } = useNavigation();
 * router.push('/dashboard');    // navigate, new history entry
 * router.replace('/login');     // navigate, no new entry
 * router.back();                // one entry back, as the browser's button does
 * router.forward();             // one entry forward
 * router.refresh();             // re-run this route's server components
 * ```
 */
export interface NavigationRouter {
  /** Navigates to `href` and pushes a new history entry. */
  push(href: string): void;
  /** Navigates to `href`, replacing the current history entry instead of adding one. */
  replace(href: string): void;
  /** Steps one entry back in the browser's session history. Nothing to go back to is a no-op. */
  back(): void;
  /** Steps one entry forward in the browser's session history. A no-op on the newest entry. */
  forward(): void;
  /** Re-fetches the current route from the server, re-running its server components. */
  refresh(): void;
  /** `true` while a soft navigation is in flight — use it to disable controls or show a spinner. */
  pending: boolean;
}

/** The current location plus the {@link NavigationRouter}, as returned by {@link useNavigation}. */
export interface NavigationState {
  /**
   * The full current {@link URL}. A fresh instance per navigation, so mutating it affects nothing else
   * — it is not written back to the address bar.
   */
  url: URL;
  /** Matched route params for the current page, e.g. `{ id: '42' }` for `/profile/:id`. */
  params: Record<string, string>;
  /** Imperative navigation actions and the `pending` flag. */
  router: NavigationRouter;
}

const noop = () => {};

const defaultRouter: NavigationRouter = { push: noop, replace: noop, back: noop, forward: noop, refresh: noop, pending: false };

/**
 * Carries the live {@link NavigationRouter} from the hydration runtime down to {@link RouterProvider}.
 *
 * @internal
 */
export const RouterContext = createContext<NavigationRouter>(defaultRouter);

const NavigationContext = createContext<NavigationState | null>(null);

/**
 * Publishes the per-render location and params for {@link useNavigation} to read. The RSC entry wraps
 * every page in one.
 *
 * @internal
 */
export function RouterProvider({ href, params, children }: { href: string; params: Record<string, string>; children: ReactNode }) {
  const router = useContext(RouterContext);
  const value = useMemo<NavigationState>(() => ({ url: new URL(href), params, router }), [href, params, router]);

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/**
 * Reactive access to the current URL and programmatic navigation, in one hook. Call it from a
 * `'use client'` component.
 *
 * `url` and `params` are computed on the server and travel in the flight payload, so they are correct
 * during SSR — no hydration flicker — and update on every navigation. `router` holds the imperative
 * actions plus a `pending` flag, `true` while a soft navigation is in flight.
 *
 * **On a `render: 'static'` route `url` is frozen at build time**, origin included and query empty. The
 * payload is one prerendered set of bytes and this reads the `href` in it, so it is the page's own
 * `PageProps.url` — the same value, not a live one. A page whose output depends on the query wants
 * `render: 'dynamic'`; a component that only needs it after hydration can read `location.search` in an
 * effect.
 *
 * Hooks can't run in a server component; read the same data there from `getRequestContext()`.
 *
 * @example
 * ```tsx
 * 'use client';
 * import { useNavigation } from '@rshono/core/client';
 *
 * export function NextPage() {
 *   const { url, router } = useNavigation();
 *   const page = Number(url.searchParams.get('page') ?? '1');
 *   return (
 *     <button disabled={router.pending} onClick={() => router.push(`${url.pathname}?page=${page + 1}`)}>
 *       Next {router.pending ? '…' : ''}
 *     </button>
 *   );
 * }
 * ```
 *
 * @returns The current {@link NavigationState}: `url` and `params`, plus `router`
 * ({@link NavigationRouter}) with `push` / `replace` / `back` / `forward` / `refresh` / `pending`.
 * @throws If called outside a page's React tree, where there is no navigation
 *   context to read.
 *
 * @see {@link https://www.rshono.com/docs/api#rshonocoreclient | Docs — `@rshono/core/client`}
 * @see {@link https://www.rshono.com/docs/pages#client-components | Docs — client components}
 */
export function useNavigation(): NavigationState {
  const value = useContext(NavigationContext);
  if (!value) {
    throw new Error(
      "[rshono] useNavigation() must be called inside a 'use client' component rendered by a page. In a server component, read the URL from getRequestContext() instead.",
    );
  }
  return value;
}
