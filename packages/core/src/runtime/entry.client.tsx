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
// Dev-only: its one caller sits behind `import.meta.webpackHot`, which a production build compiles to
// `false` — so this module is dropped there.
import { walkHotUpdates } from './hot-update.js';
import { RouterContext, type NavigationRouter } from './navigation.js';
import { createRscRequest } from './request.js';

const isDev = process.env.NODE_ENV === 'development';

declare global {
  /** The array the payload `<script>` tags `flight-inject.ts` emits push their chunks into. */
  var __FLIGHT_DATA: Array<string | Uint8Array> | undefined;
}

/** The flight payload the document carried, read back out of `__FLIGHT_DATA` — see `flight-inject.ts`. */
function readFlightPayload(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Assigned synchronously by `start`, which `new ReadableStream` runs before it returns.
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
  });
  const enqueue = (chunk: string | Uint8Array) => controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);

  // Payload scripts interleave with the document: the ones that already ran are in the array, the rest
  // arrive through `push`.
  const data = (self.__FLIGHT_DATA ??= []);
  for (const chunk of data) enqueue(chunk);
  data.push = enqueue as typeof data.push;

  // The last payload script lands before parsing finishes, so that is what closes the stream.
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
 * The part of the location a payload is rendered for — the document, without the fragment, which the server
 * never sees. Two URLs that differ only by `#hash` describe the same payload.
 */
const documentUrl = (): string => location.pathname + location.search;

/** Guarantees somewhere to attach the fatal overlay: the root container is `document`, so a teardown can take `<body>` with it. */
function overlayHost(): HTMLElement {
  if (!document.documentElement) document.appendChild(document.createElement('html'));
  if (!document.body) document.documentElement.appendChild(document.createElement('body'));
  return document.body;
}

/**
 * Paints a full-viewport panel over whatever is on screen, and returns the box for the caller to fill.
 *
 * DOM calls rather than React (one caller runs because the renderer just failed), and `textContent` rather
 * than `innerHTML` (an error message is untrusted input). Queued on a macrotask: React's teardown runs after
 * the callback that reaches here returns, and would remove a node appended inline.
 */
function paintOverlay(fill: (box: HTMLElement) => void): void {
  setTimeout(() => {
    const host = overlayHost();
    host.querySelector('[data-rshono-fatal]')?.remove();

    const box = document.createElement('div');
    box.setAttribute('data-rshono-fatal', '');
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:1.5rem;background:#18181b;color:#f4f4f5;' +
      'font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:left';

    fill(box);
    host.appendChild(box);
  }, 0);
}

/** The overlay's heading. */
function overlayTitle(text: string): HTMLElement {
  const title = document.createElement('div');
  title.textContent = text;
  title.style.cssText = 'font-size:1.0625rem;font-weight:700;color:#f87171;margin:0 0 0.75rem';
  return title;
}

/**
 * Paints the reason for an uncaught render error over the blank page it leaves behind — the full stack in
 * dev, a generic notice and a reload button in production.
 */
function showFatal(error: unknown, componentStack?: string | null): void {
  paintOverlay((box) => {
    box.appendChild(overlayTitle(isDev ? 'Unhandled error' : 'Something went wrong'));

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
    reload.addEventListener('click', () => loadOutsideRouter(() => window.location.reload()));
    box.appendChild(reload);
  });
}

/**
 * The end of the line for a `notFound()` that arrived too late to be a 404 and did not survive a reload.
 *
 * No reload button, unlike {@link showFatal}: the reload has already been spent, and the second identical
 * response is what brought us here. "Page not found" is what the server was trying to say, so it is what the
 * visitor is told; the reason it could not say it properly is a message for whoever wrote the page, and dev is
 * where they are.
 */
function showLateNotFound(): void {
  paintOverlay((box) => {
    box.appendChild(overlayTitle('Page not found'));

    const message = document.createElement('p');
    message.textContent = isDev
      ? 'notFound() was raised from a boundary that resolved after the page shell had been sent, so the response ' +
        'could not be a 404 — and reloading rendered the same page again. Decide before the render starts ' +
        'streaming: in Hono middleware, or in the page component body above the boundary.'
      : 'This page is not available.';
    message.style.cssText = 'margin:0;color:#d4d4d8';
    box.appendChild(message);
  });
}
/** What every flight response is typed as. The charset and any other parameters follow it. */
const FLIGHT_CONTENT_TYPE = 'text/x-component';

/**
 * Fetches a payload, refusing a response that is not one.
 *
 * The status cannot be the gate: a payload legitimately arrives as a 404 from the `notFound` page and as a
 * 500 from an action that threw, and both carry a real payload the caller has to see. The content type is.
 *
 * What this catches is the response that is not a payload at all — a `bodyLimit()` 413, a proxy's error page,
 * a 502 mid-deploy. Handed to the flight parser those all surface as `Error: Connection closed.`, with the
 * status and the body nowhere in sight; here they become an error that says what arrived.
 */
async function payloadResponse(request: Request): Promise<Response> {
  const response = await fetch(request);
  const contentType = response.headers.get('content-type');
  if (contentType?.startsWith(FLIGHT_CONTENT_TYPE)) return response;
  // Read for the message: a plain-text refusal says what it refused only in its body, and HTTP/2 has no
  // `statusText` at all. Bounded, because this is an error path and the body is not ours to trust.
  const body = await response.text().then(
    (text) => text.trim().slice(0, 200),
    () => '',
  );
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  throw new Error(`[rshono] the server answered ${status} (${contentType ?? 'no content type'}) instead of a payload${body ? `: ${body}` : ''}`);
}

/**
 * Asks a URL for its flight payload. Deliberately uncached — a payload can never be staler than the click
 * that wanted it, and the browser's own HTTP cache is what makes a repeat visit cheap.
 */
function requestPayload(href: string, signal?: AbortSignal): Promise<RscPayload> {
  return createFromFetch<RscPayload>(payloadResponse(createRscRequest(new URL(href, location.href).href, undefined, signal)));
}

/**
 * Whether the browser hands us its navigations. Gated on `sourceElement` rather than on `navigation` itself:
 * Chrome shipped the event in 102 and that property only in 135, and without it a `data-native` link cannot
 * be told from any other — so the older window would soft-navigate the very links that asked not to be.
 *
 * Where this is false there is no interception at all and every navigation is a real browser load, which a
 * server-rendered app answers correctly on its own. Only the soft part is missing.
 *
 * Both globals are tested, and neither is touched before: this runs at module scope, where a ReferenceError
 * would take the whole client runtime down with it rather than degrading anything.
 */
const canSoftNavigate = typeof navigation !== 'undefined' && typeof NavigateEvent !== 'undefined' && 'sourceElement' in NavigateEvent.prototype;

/**
 * Drops a navigation's result promises. Both reject when a navigation is superseded or cancelled — routine
 * here, since a second click is meant to abandon the first — and unhandled they would be reported as faults.
 */
function settle(result: NavigationResult): void {
  const ignore = () => {};
  void result.committed?.catch(ignore);
  void result.finished?.catch(ignore);
}

/** Set by {@link loadOutsideRouter}, read and cleared by the `navigate` listener. */
let bypassRouter = false;

/**
 * Performs a navigation the router below must **not** intercept, and returns having asked for it.
 *
 * `location.reload()` and `location.assign()` fire a `navigate` event like any other navigation, and
 * `listenNavigation` intercepts a `reload` on purpose — that is what `router.refresh()` is. Every caller here
 * is reaching for a *new document* precisely because the current one cannot be repaired: the React root a
 * soft load would render into is the thing that just failed, or is about to be torn down. Intercepted, the
 * escape hatch becomes a payload fetch that lands nowhere — which is how a late `notFound()` left the tab on
 * its Suspense fallback with no second document ever arriving, and how a late `redirect()` moved the address
 * bar to a page it then failed to render.
 *
 * One-shot: the listener clears the flag on the next event it sees. If that event never comes — a navigation
 * the browser refuses — the cost is that the *next* navigation is a full load rather than a soft one, on a
 * document that was on its way out anyway.
 */
function loadOutsideRouter(navigate: () => void): void {
  bypassRouter = true;
  navigate();
}

// The imperative actions behind `useNavigation().router`. Each one only *asks*: the browser turns it into a
// `navigate` event, which is where `listenNavigation` answers it — so a `router.push` and a link click reach
// the same code by the same route, and inherit the same fetch, scroll and `pending` flag.
function push(href: string): void {
  if (canSoftNavigate) settle(navigation.navigate(href, { history: 'push' }));
  else window.location.assign(href);
}

function replace(href: string): void {
  if (canSoftNavigate) settle(navigation.navigate(href, { history: 'replace' }));
  else window.location.replace(href);
}

// A traversal is the browser's to perform either way — `navigation` only hands it back as an interceptable
// event first. Nothing to go back to is a rejection there and a no-op here; both amount to the same thing.
function back(): void {
  if (canSoftNavigate) settle(navigation.back());
  else window.history.back();
}

function forward(): void {
  if (canSoftNavigate) settle(navigation.forward());
  else window.history.forward();
}

// A refresh keeps the URL, and is still a navigation: it arrives as `navigationType: 'reload'`, which is what
// tells the listener to leave scroll and focus where the user left them.
function refresh(): void {
  if (canSoftNavigate) settle(navigation.reload());
  else window.location.reload();
}

/** How long the recovery reload is given to replace this document before the panel is painted instead. */
const RELOAD_GRACE_MS = 2000;

/**
 * Spends the one reload a late `notFound()` gets, or paints if it has already been spent for this URL.
 *
 * `redirect()` is terminal on the client — there is somewhere to navigate to — and `notFound()` is not: the
 * response is already committed as a 200, so the only recovery left is asking for the page again and hoping
 * the signal comes early enough this time to be a real 404. That works where the lateness was incidental, a
 * boundary that happened to resolve after the shell on a slow request. Where it is structural — a page that
 * always signals from a late boundary — the reload gets a byte-identical response and reloads again, and the
 * tab spins until the visitor leaves. In production nothing is logged, because the warning that explains this
 * is `isDev`-only.
 *
 * So it is bounded: one reload per URL per tab, then {@link showLateNotFound}. `sessionStorage` because the
 * value has to outlive the document it is written in and must not outlive the tab, and keyed by URL so a
 * second page's late signal still gets its own attempt.
 */
function reloadOnceForLateNotFound(): void {
  const key = `rshono:late-not-found:${documentUrl()}`;
  let spent: boolean;
  try {
    spent = sessionStorage.getItem(key) !== null;
    if (!spent) sessionStorage.setItem(key, '1');
  } catch {
    // Storage can throw outright where site data is blocked, and a page that cannot count its reloads has
    // to pick a side. It picks the terminating one: a message on a page that might have recovered is a
    // worse outcome than a reload loop only by a lot less.
    spent = true;
  }
  if (spent) {
    showLateNotFound();
    return;
  }

  loadOutsideRouter(() => window.location.reload());

  // The reload wins this race whenever it happens at all: the document goes away and takes the timer with
  // it. What this covers is a reload that does not happen — swallowed by an interceptor, refused by the
  // browser, held by a `beforeunload` — which used to leave the visitor on a Suspense fallback with nothing
  // coming and nothing said. The panel is the honest answer in that case too.
  setTimeout(() => {
    if (!document.querySelector('[data-rshono-fatal]')) showLateNotFound();
  }, RELOAD_GRACE_MS);
}

/**
 * Turns a control-signal digest — how `redirect()` / `notFound()` reach the browser — into a real
 * navigation. Returns false for anything else, so callers fall through to their own handling.
 *
 * `hard` forces a full document load, for signals that surfaced *through React*: it unmounts the root on
 * an uncaught error, leaving no live tree to soft-navigate with.
 */
function handleControlDigest(error: unknown, { hard = false }: { hard?: boolean } = {}): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (!isControlDigest(digest)) return false;
  const redirect = parseRedirectDigest(digest);
  if (!redirect) {
    reloadOnceForLateNotFound();
  } else if (hard) {
    loadOutsideRouter(() => window.location.assign(new URL(redirect.location, window.location.href).href));
  } else {
    push(redirect.location);
  }
  return true;
}

/**
 * Puts a payload on screen, resolving once React has committed it. Replaced by `BrowserRoot`'s own on mount;
 * the default covers the window before hydration, where `setServerCallback` is already registered but there
 * is no root to update — a reload is the honest answer, and nothing after it needs to run.
 */
let setPayload: (payload: RscPayload) => Promise<void> = () => {
  window.location.reload();
  return new Promise<void>(() => {});
};

/** Runs work inside the nav transition so `useNavigation().pending` stays true across the round-trip. */
let startNav: (run: () => void | Promise<void>) => void = (run) => {
  void run();
};

/**
 * Fetches the payload for `url` and puts it on screen.
 *
 * Resolves once React has **committed** it rather than when the fetch lands: an intercepted navigation
 * scrolls and moves focus when this promise settles, and a `#hash` target does not exist until the new tree
 * does. Rejects only on a genuine failure — being superseded is not one, and resolves quietly, because the
 * navigation that replaced this one owns the screen from then on.
 */
function loadPayload(url: string, signal?: AbortSignal): Promise<void> {
  // Deliberately not awaited inside the transition: the scope ends once the payload is handed to React, and
  // React holds `pending` until the update it scheduled commits. Awaiting the commit *inside* the scope would
  // work too, but only because React happens not to gate a commit on its async scope settling — an internal
  // this has no reason to depend on across the whole `^19.1.0` peer range.
  let committed: Promise<void> | undefined;

  const run = async () => {
    const payload = await requestPayload(url, signal);
    // The browser aborts a navigation the moment a newer one starts. Checked again after the await because
    // the fetch may already have resolved by then, and applying it would repaint a page the user has left.
    if (signal?.aborted) return;
    if (payload.redirect) {
      push(payload.redirect);
      return;
    }
    committed = setPayload(payload);
  };

  // `startTransition` runs the work but hands nothing back, so the promise carrying a failure is caught here
  // instead. Assigned synchronously: React invokes the callback before `startNav` returns.
  let work!: Promise<void>;
  startNav(() => (work = run()));

  return work.then(
    // Undefined whenever nothing was applied — an abort, or a redirect — and there is then nothing to wait for.
    () => committed,
    (error: unknown) => {
      // Checked before the error is read: an abort is this navigation being replaced, and the one that
      // replaced it owns the outcome.
      if (signal?.aborted || handleControlDigest(error)) return;
      throw error;
    },
  );
}

/**
 * Navigations the browser can hand over but shouldn't:
 *
 * - a fragment jump, which is same-document already and needs no payload — the browser's own jump is the one
 *   that honours `scroll-padding-top`, and re-rendering would pull the target out from under it;
 * - a download, which is not a navigation of this page at all;
 * - a `POST` form, which is a submission and the server's to answer (a `GET` form carries its fields in the
 *   URL, has no `formData`, and soft-navigates like any other link);
 * - a link marked `data-native`, the documented opt-out.
 */
function leaveToBrowser(event: NavigateEvent): boolean {
  return event.hashChange || event.downloadRequest !== null || event.formData !== null || event.sourceElement?.hasAttribute('data-native') === true;
}

/**
 * The whole router, in one listener.
 *
 * Every navigation the page can make arrives as a `navigate` event — a link click, a `GET` form, a
 * `history.pushState`, the back button, `navigation.reload()` — already filtered by the browser: it does not
 * fire for a middle-click, a modified click or a new tab, and reports `canIntercept: false` for anything
 * cross-origin, or for a traversal that leaves the app. Those need no handling here; they are left alone, and
 * the browser performs them as it always would.
 */
function listenNavigation(): () => void {
  if (!canSoftNavigate) return () => {};

  const onNavigate = (event: NavigateEvent) => {
    // Cleared as it is consumed, whatever this event turns out to be: the flag names one navigation, and the
    // one it named is the one that just arrived.
    if (bypassRouter) {
      bypassRouter = false;
      return;
    }
    if (!event.canIntercept || leaveToBrowser(event)) return;

    // A push or a traversal lands on a new page, so the browser resets the scroll offset — or restores the
    // one it remembers — and moves focus, which is what makes a soft navigation announce itself to a screen
    // reader. A replace or a refresh stays where it is, so neither should move. Both wait on the handler,
    // which is the point of resolving it at commit rather than at fetch.
    const inPlace = event.navigationType === 'replace' || event.navigationType === 'reload';

    event.intercept({
      scroll: inPlace ? 'manual' : 'after-transition',
      focusReset: inPlace ? 'manual' : 'after-transition',
      // The URL commits before the handler runs, so a failure leaves the address bar describing a page the
      // document is not showing. A real load is the only way back to agreement.
      handler: () => loadPayload(event.destination.url, event.signal).catch(() => loadOutsideRouter(() => window.location.reload())),
    });
  };

  navigation.addEventListener('navigate', onNavigate);
  return () => navigation.removeEventListener('navigate', onNavigate);
}

async function main() {
  // The assertion is load-bearing under the compiler that builds this: TypeScript 7 declares `nonce` on
  // HTMLElement, 6 declares it on Element. ESLint runs the older lib — where the narrowing is redundant —
  // so it reports an assertion that `tsc` requires. Believe `typecheck`, not the rule.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const cspMeta = document.querySelector('meta[property="csp-nonce"]') as HTMLMetaElement | null;
  if (cspMeta?.nonce) __webpack_nonce__ = cspMeta.nonce;

  const initialPayload = await createFromReadableStream<RscPayload>(flightStream);

  function BrowserRoot() {
    const [payload, setPayloadState] = React.useState(initialPayload);
    const [pending, startTransition] = React.useTransition();
    // The resolver the payload on screen still owes — see {@link loadPayload}.
    const pendingCommit = React.useRef<(() => void) | null>(null);

    React.useEffect(() => {
      setPayload = (next) =>
        new Promise<void>((resolve) => {
          // A payload replaced before it ever painted still has a navigation waiting on it. React commits
          // only the newest, so the effect below never runs for the one it skipped: release it here.
          pendingCommit.current?.();
          pendingCommit.current = resolve;
          setPayloadState(next);
        });
      startNav = (run) => startTransition(run);
    }, [startTransition]);

    /**
     * Releases the navigation waiting on this payload, which is what lets the browser scroll and move focus
     * now that their target exists. A layout effect, so the pre-scroll position is never painted.
     */
    React.useLayoutEffect(() => {
      const commit = pendingCommit.current;
      pendingCommit.current = null;
      commit?.();
    }, [payload]);

    React.useEffect(() => listenNavigation(), []);

    const router = React.useMemo<NavigationRouter>(() => ({ push, replace, back, forward, refresh, pending }), [pending]);

    return <RouterContext.Provider value={router}>{payload.root}</RouterContext.Provider>;
  }

  setServerCallback(async (id, args) => {
    const temporaryReferences = createTemporaryReferenceSet();
    // The document the action is being called from. Every action response carries a fresh payload for that
    // page, so if a navigation has moved on by the time it arrives the payload describes a page the user has
    // left — the return value is still theirs, but painting it is not. Compared without the fragment, which
    // the server never saw.
    const calledFrom = documentUrl();
    const request = createRscRequest(window.location.href, {
      id,
      body: await encodeReply(args, { temporaryReferences }),
    });
    let payload: RscPayload;
    try {
      payload = await createFromFetch<RscPayload>(payloadResponse(request), { temporaryReferences });
    } catch (error) {
      if (handleControlDigest(error)) return undefined;
      throw error;
    }
    if (payload.redirect) {
      push(payload.redirect);
      return undefined;
    }
    if (documentUrl() === calledFrom) React.startTransition(() => void setPayload(payload));
    if (payload.notFound) return undefined;
    const result = payload.returnValue;
    if (!result) {
      // A payload that is not this action's own reply: the server rendered a page in its place. An action
      // that had already run has its result carried across (see `actionResults` in entry.rsc.tsx), so
      // reaching here means the request failed before it ran at all — an undecodable body, most likely.
      // Reading `.ok` off it used to hand the caller `Cannot read properties of undefined`.
      throw new Error('[rshono] the server action produced no result — the request failed around it and the server answered with a page instead. Its log has the error.');
    }
    if (!result.ok) throw result.error;
    return result.value;
  });

  // A `redirect()` / `notFound()` from a component below the page root reaches us through React: it rides the
  // flight payload as an error, and boundaries re-throw it so it lands here rather than in a fallback.
  //
  // Installing these hooks opts out of React's own defaults, so everything that isn't a control signal has to
  // be put back by hand — `reportError` rather than a bare log, so error-reporting tools still see it.
  hydrateRoot(document, <BrowserRoot />, {
    formState: initialPayload.formState,
    onCaughtError: (error, errorInfo) => {
      if (handleControlDigest(error, { hard: true })) return;
      // A boundary handled it and the tree is intact, so no overlay over the app's own fallback.
      console.error(error, errorInfo.componentStack ?? '');
    },
    onUncaughtError: (error, errorInfo) => {
      if (handleControlDigest(error, { hard: true })) return;
      // Nothing caught it, so React tears the root down — and the root is `document`.
      globalThis.reportError(error);
      showFatal(error, errorInfo.componentStack);
    },
  });

  if (import.meta.webpackHot) {
    initDevRefresh();
  }
}

/**
 * Dev-only refresh client, listening to the CLI's SSE endpoint:
 *
 *   client-built  → hot-apply the waiting updates; anything the page can't be patched up to reloads.
 *   rsc-update    → server component code changed: re-fetch the flight payload, state preserved.
 *   hello         → sent on (re)connect with the latest build hash; a mismatch means a missed event.
 */
function initDevRefresh() {
  const hot = import.meta.webpackHot!;
  let connectedOnce = false;
  /** The newest build the dev server has announced — what {@link applyClientUpdate} walks towards. */
  let targetHash: string | undefined;

  function reload(reason: string, error?: unknown): void {
    console.warn(`[rshono] ${reason} — reloading`, ...(error === undefined ? [] : [error]));
    loadOutsideRouter(() => window.location.reload());
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
          await loadPayload(window.location.href).catch(() => loadOutsideRouter(() => window.location.reload()));
        }
        connectedOnce = true;
        break;
      case 'client-built':
        targetHash = message.hash;
        await applyClientUpdate();
        break;
      case 'rsc-update':
        console.log('[rshono] server components updated');
        await loadPayload(window.location.href).catch(() => loadOutsideRouter(() => window.location.reload()));
        break;
    }
  }

  const source = new EventSource('/_rshono/hmr');
  // Chained rather than handled as they arrive: `hot.check` may only run from `idle`, and a burst of saves
  // puts several frames on the wire inside the time one takes. Queueing drops nothing, because `targetHash`
  // is shared — whichever handler runs next walks to the newest build.
  let queue: Promise<void> = Promise.resolve();
  source.onmessage = (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as DevMessage;
    queue = queue.then(() => handle(message)).catch((error) => reload('the dev client failed', error));
  };
}

// A bootstrap failure — a truncated initial payload, most likely — would otherwise be an unhandled
// rejection: nothing hydrates, nothing is reported, and the page just sits there.
main().catch((error) => {
  console.error('[rshono] the client runtime failed to start:', error);
  showFatal(error);
});
