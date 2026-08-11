import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import {
  createFromFetch,
  createFromReadableStream,
  createTemporaryReferenceSet,
  encodeReply,
  setServerCallback,
} from 'react-server-dom-rspack/client.browser';
import { isControlDigest, parseRedirectDigest } from './control.js';
import type { DevMessage } from './dev-protocol.js';
import type { RscPayload } from './entry.rsc.js';
// Dev-only, and reached only from inside an `import.meta.webpackHot` branch — which a production
// build compiles to `false`, leaving this module unreferenced and dropped.
import { walkHotUpdates } from './hot-update.js';
import { RouterContext, type NavigationRouter } from './navigation.js';
import { createRscRequest } from './request.js';

const isDev = process.env.NODE_ENV === 'development';

declare global {
  /** The array the payload `<script>` tags `flight-inject.ts` emits push their chunks into. */
  var __FLIGHT_DATA: Array<string | Uint8Array> | undefined;
}

/** The flight payload the document carried, read back out of `__FLIGHT_DATA` — see `flight-inject.ts`, which writes it. */
function readFlightPayload(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Assigned synchronously by `start`, which `new ReadableStream` runs before it returns.
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
  });
  const enqueue = (chunk: string | Uint8Array) => controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);

  // Payload scripts interleave with the document, so some have already run by the time this module
  // is evaluated — those are in the array — and the rest run after it, arriving through `push`.
  const data = (self.__FLIGHT_DATA ??= []);
  for (const chunk of data) enqueue(chunk);
  data.push = enqueue as typeof data.push;

  // The last payload script lands before the document finishes parsing, so that is what says there
  // is no more of it to come.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => controller.close(), { once: true });
  } else {
    controller.close();
  }
  return stream;
}

/** Created at module evaluation, not inside `main()`, so no chunk can be pushed before it is watching. */
const flightStream = readFlightPayload();

/**
 * Guarantees somewhere to attach the fatal overlay. React's root container is the whole `document`,
 * so by the time an uncaught error has torn the tree down, `<body>` — or even `<html>` — may be gone.
 */
function overlayHost(): HTMLElement {
  if (!document.documentElement) document.appendChild(document.createElement('html'));
  if (!document.body) document.documentElement.appendChild(document.createElement('body'));
  return document.body;
}

/**
 * Replaces the white screen of death with something readable.
 *
 * Because the root container is `document`, an uncaught render error leaves a genuinely blank page
 * with the reason only in the console — so this paints the reason over it instead. In development
 * that's the full stack; in production it's a generic notice plus a reload button, since the tree is
 * unrecoverable and reloading is the only way forward.
 *
 * Written with DOM calls rather than React (the renderer is what just failed) and `textContent`
 * rather than `innerHTML` (an error message is untrusted input).
 */
function showFatal(error: unknown, componentStack?: string | null): void {
  // Queued rather than run inline: React's teardown happens after this callback returns, and would
  // remove a node appended synchronously along with the rest of the tree.
  setTimeout(() => {
    const host = overlayHost();
    host.querySelector('[data-rshono-fatal]')?.remove();

    const box = document.createElement('div');
    box.setAttribute('data-rshono-fatal', '');
    box.setAttribute('role', 'alert'); // the page is gone; announce it rather than leaving silence
    box.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:1.5rem;background:#18181b;color:#f4f4f5;' +
      'font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:left';

    const title = document.createElement('div');
    title.textContent = isDev ? 'Unhandled error' : 'Something went wrong';
    title.style.cssText = 'font-size:1.0625rem;font-weight:700;color:#f87171;margin:0 0 0.75rem';
    box.appendChild(title);

    if (isDev) {
      const detail = document.createElement('pre');
      detail.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word';
      detail.textContent =
        (error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)) +
        (componentStack ? `\n\nComponent stack:${componentStack}` : '');
      box.appendChild(detail);
    } else {
      const message = document.createElement('p');
      message.textContent = 'This page hit an unexpected error and can’t continue.';
      message.style.cssText = 'margin:0 0 1rem;color:#d4d4d8';
      box.appendChild(message);
    }

    const reload = document.createElement('button');
    reload.textContent = 'Reload page';
    reload.style.cssText =
      'margin-top:1.25rem;padding:0.5rem 1rem;font:inherit;color:#18181b;background:#f4f4f5;border:0;border-radius:4px;cursor:pointer';
    reload.addEventListener('click', () => window.location.reload());
    box.appendChild(reload);

    host.appendChild(box);
  }, 0);
}

/**
 * Asks a URL for its flight payload.
 *
 * Deliberately uncached: every navigation fetches at the moment it is asked for, so a payload can
 * never be staler than the click that wanted it, and the browser's own HTTP cache is what makes a
 * repeat visit cheap.
 */
function requestPayload(href: string): Promise<RscPayload> {
  return createFromFetch<RscPayload>(fetch(createRscRequest(new URL(href, location.href).href)));
}

async function main() {
  const cspMeta = document.querySelector('meta[property="csp-nonce"]') as HTMLMetaElement | null;
  if (cspMeta?.nonce) __webpack_nonce__ = cspMeta.nonce;

  // Both are replaced by BrowserRoot's own on mount. The defaults matter: `setServerCallback` is
  // registered before hydration, so an action or refresh firing in that window would otherwise call
  // an unassigned binding. Until there's a root to update, a full reload is the honest fallback.
  let setPayload: (v: RscPayload) => void = () => {
    window.location.reload();
  };
  // Runs work inside the nav transition so useNavigation().pending stays true across the round-trip.
  let startNav: (run: () => void | Promise<void>) => void = (run) => {
    void run();
  };

  const initialPayload = await createFromReadableStream<RscPayload>(flightStream);

  function push(href: string) {
    const target = new URL(href, window.location.href);
    if (target.origin !== window.location.origin) {
      window.location.assign(target.href);
      return;
    }
    window.history.pushState(null, '', target.href);
  }

  function replace(href: string) {
    const target = new URL(href, window.location.href);
    if (target.origin !== window.location.origin) {
      window.location.replace(target.href);
      return;
    }
    window.history.replaceState(null, '', target.href);
  }

  // A refresh keeps the URL, so it can't ride the history patch like push/replace — it drives the
  // flight re-fetch directly.
  const refresh = () =>
    startNav(async () => {
      try {
        await fetchRscPayload();
      } catch {
        window.location.reload();
      }
    });

  /**
   * Turns a control-signal digest — how `redirect()` / `notFound()` reach the browser — into a real
   * navigation. Returns false for anything else, so callers can fall through to their own handling.
   *
   * `hard` forces a full document load, for signals that surfaced *through React* (a nested
   * component's redirect, reported via the root error handlers). React unmounts the root on an
   * uncaught error, so there is no live tree left to soft-navigate with. A signal caught earlier —
   * a top-level payload rejection — still swaps the payload in place.
   */
  function handleControlDigest(error: unknown, { hard = false }: { hard?: boolean } = {}): boolean {
    const digest = (error as { digest?: unknown } | null)?.digest;
    if (!isControlDigest(digest)) return false;
    const redirect = parseRedirectDigest(digest);
    if (!redirect) {
      window.location.reload();
    } else if (hard) {
      window.location.assign(new URL(redirect.location, window.location.href).href);
    } else {
      push(redirect.location);
    }
    return true;
  }

  async function fetchRscPayload() {
    let payload: RscPayload;
    try {
      payload = await requestPayload(window.location.href);
    } catch (error) {
      if (handleControlDigest(error)) return;
      throw error;
    }
    if (payload.redirect) return push(payload.redirect);
    setPayload(payload);
  }

  function BrowserRoot() {
    const [payload, setPayloadState] = React.useState(initialPayload);
    const [pending, startTransition] = React.useTransition();
    // The scroll a fetched navigation still owes, held until its payload is on screen.
    const pendingScroll = React.useRef<(() => void) | null>(null);

    React.useEffect(() => {
      setPayload = (v) => setPayloadState(v);
      startNav = (run) => startTransition(run);
    }, [startTransition]);

    /**
     * Scrolls where the navigation asked, once React has put its payload in the DOM.
     *
     * This has to wait for the commit rather than the fetch: a `#hash` target does not exist until the
     * new tree does, and until then the page a scroll would move is still the outgoing one. A layout
     * effect runs before the browser paints, so the pre-scroll position is never on screen.
     */
    React.useLayoutEffect(() => {
      const scroll = pendingScroll.current;
      pendingScroll.current = null;
      scroll?.();
    }, [payload]);

    React.useEffect(() => {
      const stopNavigating = listenNavigation((afterRender) =>
        startNav(async () => {
          try {
            await fetchRscPayload();
            pendingScroll.current = afterRender;
          } catch {
            window.location.reload();
          }
        }),
      );
      const stopUpgradingLinks = listenLinks();
      return () => {
        stopUpgradingLinks();
        stopNavigating();
      };
    }, []);

    const router = React.useMemo<NavigationRouter>(() => ({ push, replace, refresh, pending }), [pending]);

    return <RouterContext.Provider value={router}>{payload.root}</RouterContext.Provider>;
  }

  setServerCallback(async (id, args) => {
    const temporaryReferences = createTemporaryReferenceSet();
    const request = createRscRequest(window.location.href, {
      id,
      body: await encodeReply(args, { temporaryReferences }),
    });
    let payload: RscPayload;
    try {
      payload = await createFromFetch<RscPayload>(fetch(request), { temporaryReferences });
    } catch (error) {
      if (handleControlDigest(error)) return undefined;
      throw error;
    }
    if (payload.redirect) {
      push(payload.redirect);
      return undefined;
    }
    React.startTransition(() => setPayload(payload));
    if (payload.notFound) return undefined;
    const result = payload.returnValue!;
    if (!result.ok) throw result.error;
    return result.value;
  });

  // A `redirect()` / `notFound()` from a component *below* the page root reaches us through React: it
  // rides the flight payload as an error at that component's position, and boundaries re-throw it
  // (see boundaries.tsx) so it lands here rather than rendering an error fallback.
  //
  // Installing these hooks opts out of React's own defaults, so anything that isn't a control signal
  // has to be put back by hand: console for a caught error, `reportError` (i.e. window.onerror, so
  // error-reporting tools still see it) for an uncaught one.
  hydrateRoot(document, <BrowserRoot />, {
    formState: initialPayload.formState,
    onCaughtError: (error, errorInfo) => {
      if (handleControlDigest(error, { hard: true })) return;
      // A boundary handled this and the tree is intact, so no overlay: whatever fallback the app
      // chose is the right thing to have on screen.
      console.error(error, errorInfo.componentStack ?? '');
    },
    onUncaughtError: (error, errorInfo) => {
      if (handleControlDigest(error, { hard: true })) return;
      // Nothing caught it, so React tears the root down — and the root is `document`. This is the
      // white screen; paint the reason over it.
      globalThis.reportError(error);
      showFatal(error, errorInfo.componentStack);
    },
  });

  if (import.meta.webpackHot) {
    initDevRefresh(fetchRscPayload);
  }
}

type NavigationType = 'push' | 'replace' | 'pop';

/**
 * Runs teardown in reverse and empties the list, so a second call is a no-op. Collecting these as
 * setup goes keeps each undo next to the thing it undoes.
 */
function disposeAll(undo: Array<() => void>): void {
  for (const dispose of undo.splice(0).reverse()) dispose();
}

// An `<a>` we intercept for soft navigation: same-origin, same tab, not a download,
// and not explicitly opted out with `data-native` (which forces a full browser navigation).
function isRouterLink(link: HTMLAnchorElement): boolean {
  return (
    !!link.href &&
    (!link.target || link.target === '_self') &&
    link.origin === location.origin &&
    !link.hasAttribute('download') &&
    !link.hasAttribute('data-native')
  );
}

/**
 * Upgrades the app's anchors: a plain left-click becomes a soft navigation.
 *
 * Kept apart from `listenNavigation` because the two share no state — a click here only calls
 * `history.pushState`, which is where that function picks the navigation up.
 */
function listenLinks(): () => void {
  const undo: Array<() => void> = [];

  function onClick(e: MouseEvent) {
    const link = (e.target as Element).closest('a');
    if (
      link &&
      link instanceof HTMLAnchorElement &&
      isRouterLink(link) &&
      e.button === 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      !e.defaultPrevented
    ) {
      if (link.hash && link.pathname === location.pathname && link.search === location.search) return;
      e.preventDefault();
      history.pushState(null, '', link.href);
    }
  }
  document.addEventListener('click', onClick);
  undo.push(() => document.removeEventListener('click', onClick));

  return () => disposeAll(undo);
}

/**
 * The element the current `#fragment` names, if it is on the page.
 *
 * A fragment is percent-encoded and an `id` attribute is not, so it has to be decoded first. A
 * hand-written URL can carry a `%` that is not an escape, which throws — take the fragment literally
 * then, since that is the closest thing to an id it could have meant.
 */
function fragmentTarget(): HTMLElement | null {
  const fragment = location.hash.slice(1);
  if (!fragment) return null;
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {}
  return document.getElementById(id);
}

function listenNavigation(onNavigation: (afterRender: () => void) => void): () => void {
  const undo: Array<() => void> = [];

  // Scroll restoration is the browser's. `auto` is set explicitly rather than left at the default,
  // because it is a statement: the browser remembers a traversal's offset for us, and nothing here
  // tracks one.
  const prevRestoration = window.history.scrollRestoration;
  try {
    window.history.scrollRestoration = 'auto';
  } catch {}
  undo.push(() => {
    try {
      window.history.scrollRestoration = prevRestoration;
    } catch {}
  });

  /**
   * A push is not a real navigation to the browser, so nothing resets the scroll offset — without
   * this a click through to a new page lands wherever the last one was scrolled to. A `#hash` names
   * where to land instead, and one naming nothing on the page falls back to the top, as a browser
   * does. `replace` keeps its position deliberately, and a traversal is the browser's to restore.
   *
   * `scrollIntoView` rather than `scrollTo`, because it is the algorithm a browser's own fragment jump
   * uses — so `scroll-padding-top` still applies. Neither call passes a `behavior`, leaving
   * `scroll-behavior: smooth` the app's to ask for.
   *
   * The caller decides *when* this runs; for a navigation that fetched a payload it has to be after
   * the commit — see the layout effect in `BrowserRoot`.
   */
  const afterRenderFor = (type: NavigationType) => () => {
    if (type !== 'push') return;
    const target = fragmentTarget();
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  };

  const documentUrl = () => location.pathname + location.search;

  // What the payload on screen was rendered for. Only the document part: the server never sees the
  // fragment, so two URLs differing by one render identically.
  let renderedUrl = documentUrl();

  /**
   * A navigation that moves only the fragment — `#a` → `#b`, or back out of a same-page anchor —
   * leaves the document unchanged, so the payload already on screen is the right one. Fetching
   * another would be a wasted round-trip that re-renders the page out from under the jump.
   *
   * `router.refresh()` is unaffected: it drives the re-fetch directly rather than through here, and
   * remains the way to ask for fresh data at an unchanged URL.
   */
  const notify = (type: NavigationType) => {
    const afterRender = afterRenderFor(type);
    if (documentUrl() === renderedUrl) {
      afterRender();
      return;
    }
    renderedUrl = documentUrl();
    onNavigation(afterRender);
  };

  const onPopState = () => notify('pop');
  window.addEventListener('popstate', onPopState);
  undo.push(() => window.removeEventListener('popstate', onPopState));

  const oldPushState = window.history.pushState;
  window.history.pushState = function (state, unused, url) {
    const res = oldPushState.call(this, state, unused, url as string);
    notify('push');
    return res;
  };
  undo.push(() => {
    window.history.pushState = oldPushState;
  });

  const oldReplaceState = window.history.replaceState;
  window.history.replaceState = function (state, unused, url) {
    const res = oldReplaceState.call(this, state, unused, url as string);
    notify('replace');
    return res;
  };
  undo.push(() => {
    window.history.replaceState = oldReplaceState;
  });

  return () => disposeAll(undo);
}

/**
 * Dev-only refresh client (stripped from prod bundles: the whole call is
 * guarded by import.meta.webpackHot). Listens to the CLI's SSE endpoint:
 *
 *   client-built  → hot-apply the waiting updates (react-refresh keeps
 *                   component state); anything the page can't be patched
 *                   up to falls back to a reload — see walkHotUpdates.
 *   rsc-update    → server component code changed: re-fetch the flight
 *                   payload for the current URL, state preserved.
 *   hello         → sent on (re)connect with the latest build hash; a
 *                   mismatch means events were missed — resync.
 */
function initDevRefresh(fetchRscPayload: () => Promise<void>) {
  const hot = import.meta.webpackHot!;
  let connectedOnce = false;
  /** The newest build the dev server has announced — what {@link applyClientUpdate} walks towards. */
  let targetHash: string | undefined;

  /** Gives up on patching the page and takes the whole document from the dev server instead. */
  function reload(reason: string, error?: unknown): void {
    console.warn(`[rshono] ${reason} — reloading`, ...(error === undefined ? [] : [error]));
    window.location.reload();
  }

  async function applyClientUpdate(): Promise<void> {
    const giveUp = await walkHotUpdates(
      hot,
      () => __webpack_hash__,
      () => targetHash,
    );
    if (giveUp) reload(giveUp.reason, giveUp.error);
  }

  async function handle(message: DevMessage): Promise<void> {
    switch (message.type) {
      case 'hello':
        targetHash = message.hash ?? targetHash;
        if (connectedOnce) {
          await applyClientUpdate();
          await fetchRscPayload().catch(() => window.location.reload());
        }
        connectedOnce = true;
        break;
      case 'client-built':
        targetHash = message.hash;
        await applyClientUpdate();
        break;
      case 'rsc-update':
        console.log('[rshono] server components updated');
        await fetchRscPayload().catch(() => window.location.reload());
        break;
    }
  }

  const source = new EventSource('/_rshono/hmr');
  // Chained rather than handled as they arrive: a burst of saves puts several frames on the wire
  // inside the time one `hot.check` takes, and two of those overlapping is an error webpack throws
  // on ("check() is only allowed in idle status") — which would turn every burst into a full reload.
  // Nothing is dropped by queueing, because `targetHash` is shared: whichever handler runs next
  // walks to the newest build rather than to the one its own frame named.
  let queue: Promise<void> = Promise.resolve();
  source.onmessage = (event) => {
    const message = JSON.parse(event.data) as DevMessage;
    queue = queue.then(() => handle(message)).catch((error) => reload('the dev client failed', error));
  };
}

// Bootstrap failures (a truncated or malformed initial flight payload, most likely) would otherwise
// be an unhandled rejection: nothing hydrates, nothing is reported, and the page just sits there.
main().catch((error) => {
  console.error('[rshono] the client runtime failed to start:', error);
  showFatal(error);
});
