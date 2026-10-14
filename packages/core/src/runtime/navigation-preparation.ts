import { useSyncExternalStore } from 'react';
import type { RscPayload } from './entry.rsc.js';

type FetchedPayload = { payload: Promise<RscPayload>; settled: Promise<void> };

/**
 * A flight payload fetched before its navigation committed, plus the wiring the runtime takes over at commit.
 *
 * `controller` is the fetch's own abort switch and `detach` drops the navigation event's abort listener.
 * Both exist because ownership changes hands here: before the commit the event's signal cancels the fetch,
 * and after it the runtime's own rules do — an unapplied fetch stops at once, while one React is already
 * reading waits for a newer commit (see `navigationFetches` in entry.client.tsx).
 */
export type PreparedNavigation = {
  href: string;
  fetched: FetchedPayload;
  controller: AbortController;
  detach: () => void;
};

/**
 * Whether the browser runs `precommitHandler` before committing. `NavigationPrecommitController` is exposed
 * alongside it; a browser that lacks the option ignores the unknown dictionary member, which would leave a
 * `intercept()` with no handler at all — a committed URL and nothing rendered. The caller keeps the ordinary
 * post-commit handler there, which is the behaviour every other browser gets.
 */
const canPrecommit = typeof NavigationPrecommitController !== 'undefined';

/** The prepared navigation that has not committed yet; what {@link useNavigationPreparation} observes. */
let active: PreparedNavigation | undefined;
const subscribers = new Set<() => void>();
const notify = () => {
  for (const listener of subscribers) listener();
};
const subscribe = (listener: () => void) => {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
};

/** Preparation is pending until the URL commits and the runtime takes ownership of its response. */
export function useNavigationPreparation(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => active !== undefined,
    () => false,
  );
}

/** An action or a newer navigation must not commit an older prepared snapshot. */
export function cancelNavigationPreparation(): void {
  const preparation = active;
  if (!preparation) return;
  active = undefined;
  preparation.detach();
  preparation.controller.abort();
  notify();
}

/** The events this listener claimed: their scroll, focus and payload handler belong to the preparation. */
const claimed = new WeakSet<NavigateEvent>();

/** Whether the preparation listener claimed this event; `onNavigate` must then register no handler of its own. */
export function isPreparedNavigation(event: NavigateEvent): boolean {
  return claimed.has(event);
}

export type NavigationPreparationOptions = {
  /** Asks a URL for its flight payload — the same loader the post-commit path uses. */
  fetchPayload: (href: string, signal: AbortSignal) => FetchedPayload;
  /** The events worth preparing; the listener additionally requires a push or replace navigation type. */
  shouldIntercept: (event: NavigateEvent) => boolean;
  /** Whether a URL can be committed in this document; one that names a file cannot. */
  canCommitInPlace: (href: string) => boolean;
  /** Puts a prepared payload on screen; resolves after its render commits. */
  apply: (event: NavigateEvent, prepared: PreparedNavigation) => Promise<void>;
  /** Performs the real load a failed preparation would otherwise leave silent. */
  fallbackToDocument: (href: string) => void;
};

/**
 * Prepares push and replace navigations before the browser commits them.
 *
 * The payload is fetched from a `precommitHandler`, so the URL, the history entry and the rendered page
 * change together: the ordinary path commits the URL first and can only recover from a failed fetch with a
 * real document load. A payload `redirect()` is resolved here too, which keeps the redirect stub out of
 * history, and the payload reaches the runtime through `controller.addHandler()`, which runs after the
 * commit like any other navigation handler — the same place the post-commit loader would have run.
 *
 * A failure after the event's signal has aborted is supersession, and the navigation that replaced this one
 * owns the screen. Anything else — a refused response, a redirect loop, a redirect this document cannot
 * commit — is a real failure: the caller is asked for a document load rather than aborting into silence.
 */
export function listenNavigationPreparation({
  fetchPayload,
  shouldIntercept,
  canCommitInPlace,
  apply,
  fallbackToDocument,
}: NavigationPreparationOptions): () => void {
  if (!canPrecommit) return () => {};

  const onNavigate = (event: NavigateEvent) => {
    if (event.navigationType !== 'push' && event.navigationType !== 'replace') return;
    if (!shouldIntercept(event)) return;
    event.intercept({
      scroll: 'manual',
      focusReset: event.navigationType === 'replace' ? 'manual' : 'after-transition',
      precommitHandler: async (controller: NavigationPrecommitController) => {
        cancelNavigationPreparation();
        let href = event.destination.url;
        const visited = new Set<string>();
        let preparation: PreparedNavigation | undefined;
        let recovery: string | undefined;
        try {
          for (;;) {
            if (visited.has(href) || visited.size >= 10) throw new Error(`[rshono] the payload for ${event.destination.url} redirects in a loop`);
            visited.add(href);
            const requestController = new AbortController();
            const abort = () => {
              requestController.abort(event.signal.reason);
              if (active === preparation) {
                active = undefined;
                notify();
              }
            };
            const next: PreparedNavigation = {
              href,
              fetched: fetchPayload(href, requestController.signal),
              controller: requestController,
              detach: () => event.signal.removeEventListener('abort', abort),
            };
            event.signal.addEventListener('abort', abort, { once: true });
            preparation = next;
            active = next;
            notify();
            const root = await next.fetched.payload;
            if (event.signal.aborted || requestController.signal.aborted) throw requestController.signal.reason ?? event.signal.reason;
            if (!root.redirect) break;
            const target = new URL(root.redirect, href);
            if (target.origin !== location.origin || !canCommitInPlace(target.href)) {
              // `controller.redirect` cannot leave the origin, and a file can never be a same-document
              // commit — the browser performs both as a real load instead.
              recovery = target.href;
              throw new Error(`[rshono] cannot soft-navigate to ${target.href}`);
            }
            next.detach();
            next.controller.abort();
            preparation = undefined;
            active = undefined;
            notify();
            href = target.href;
          }
          if (href !== event.destination.url) controller.redirect(href);
          // Registered from the precommit, so it runs after the commit in the same list every other
          // navigation handler runs in — the payload follows the runtime's applied-fetch and lost-ping
          // rules rather than arriving before the URL does.
          const prepared = preparation;
          controller.addHandler(() => {
            prepared.detach();
            if (active === prepared) {
              active = undefined;
              notify();
            }
            // The browser's `finished`, `navigatesuccess`, and focus reset must wait for the render too.
            return apply(event, prepared);
          });
        } catch (error) {
          const cancelled = event.signal.aborted || preparation?.controller.signal.aborted === true;
          preparation?.detach();
          preparation?.controller.abort();
          if (active === preparation) {
            active = undefined;
            notify();
          }
          if (!cancelled) fallbackToDocument(recovery ?? event.destination.url);
          throw error;
        }
      },
    });
    claimed.add(event);
  };
  navigation.addEventListener('navigate', onNavigate);
  return () => {
    navigation.removeEventListener('navigate', onNavigate);
    cancelNavigationPreparation();
  };
}
