'use client';

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';

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
   *
   * The path, query and origin travel in the page payload, but the fragment cannot: a browser leaves `#…`
   * out of the request line, so the server renders every page without one. `url.hash` is therefore read
   * from the browser after hydration and follows `hashchange` — an in-page link, Back/Forward between
   * anchors of one document, or opening the document at one. Nothing else about the URL is affected; see
   * {@link useNavigation} for the `render: 'static'` case.
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
 * The browser's fragment navigation: the one part of the address a payload can never carry, and the one part
 * that can move without a page data request. `hashchange` is every way it moves within a document — an
 * in-page link, Back/Forward between anchors of one page, opening the document at `#section` covered by the
 * post-hydration check `useSyncExternalStore` makes for a changed snapshot. A cross-page `#anchor` commits a
 * payload instead; the re-render that follows reads the fragment then.
 */
function subscribeToHash(onStoreChange: () => void): () => void {
  window.addEventListener('hashchange', onStoreChange);
  return () => window.removeEventListener('hashchange', onStoreChange);
}

/** The live fragment, `#…` included, or `''`. */
const readHash = (): string => window.location.hash;

/**
 * What the fragment reads as while the server snapshot is in use — server render and hydration. The server
 * never saw one, so the payload's URL has none; answering with the live fragment here would render markup
 * the server did not and fail hydration. The empty string is exactly what the payload carries, and the
 * post-hydration re-render that `useSyncExternalStore` performs for a changed snapshot is where the
 * browser's own arrives.
 */
const readServerHash = (): string => '';

/**
 * Publishes the per-render location and params for {@link useNavigation} to read. The RSC entry wraps
 * every page in one.
 *
 * @internal
 */
export function RouterProvider({ href, params, children }: { href: string; params: Record<string, string>; children: ReactNode }) {
  const router = useContext(RouterContext);
  // `href` is the payload's URL — see `subscribeToHash` — so the browser's fragment is applied on top of it.
  // This is the only client-side part of `url`; path, query and origin stay exactly what the payload said.
  const hash = useSyncExternalStore(subscribeToHash, readHash, readServerHash);
  const value = useMemo<NavigationState>(() => {
    const url = new URL(href);
    url.hash = hash;
    return { url, params, router };
  }, [href, hash, params, router]);

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/**
 * The pathname of the payload on screen, for framework components that key themselves to the route.
 * Unlike {@link useNavigation} it tolerates being rendered outside a page: with no navigation context to
 * read it answers `undefined`, so the caller can treat the absent route as "no key".
 *
 * @internal
 */
export function useNavigationPathname(): string | undefined {
  return useContext(NavigationContext)?.url.pathname;
}

/**
 * Reactive access to the current URL and programmatic navigation, in one hook. Call it from a
 * `'use client'` component.
 *
 * `url` and `params` are computed on the server and travel in the flight payload, so they are correct
 * during SSR — no hydration flicker — and update on every navigation. `router` holds the imperative
 * actions plus a `pending` flag, `true` while a soft navigation is in flight.
 *
 * The fragment is the exception the payload cannot cover: a browser never sends `#…` to the server, so
 * `url.hash` is read from the address bar after hydration and kept in sync on `hashchange` — an in-page
 * link, Back/Forward between anchors, or opening the document at `#section` — with no request either way.
 * Everything before the `#` remains what the payload carried.
 *
 * **On a `render: 'static'` route `url` is frozen at build time**, origin included and query empty. The
 * payload is one prerendered set of bytes and this reads the `href` in it, so it is the page's own
 * `PageProps.url` — the same value, not a live one, `url.hash` aside. A page whose output depends on the
 * query wants `render: 'dynamic'`; a component that only needs it after hydration can read
 * `location.search` in an effect.
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
