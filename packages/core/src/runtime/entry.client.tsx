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

/**
 * The document URL the payload on screen was rendered for — see {@link documentUrl}. A fragment-only
 * traversal leaves it unchanged, which is how the `popstate` listener knows there is nothing to fetch.
 * Updated in the layout effect that commits a payload.
 */
let renderedUrl = documentUrl();

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
    reload.addEventListener('click', () => loadDocument());
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

/** How much of a body that is not a payload is quoted back in the error. */
const REFUSAL_BODY_LIMIT = 200;

/**
 * The first {@link REFUSAL_BODY_LIMIT} characters of a response body, without buffering the rest.
 *
 * `response.text()` reads the whole body first, so a proxy's multi-megabyte error page would be buffered and
 * decoded before the 200 characters that are kept — on a path that exists to say what answered instead of a
 * payload. Reading one chunk at a time and cancelling stops paying for bytes nothing will look at.
 */
async function refusalBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < REFUSAL_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` so a multi-byte character split across two reads is not replaced by U+FFFD.
      text += decoder.decode(value, { stream: true });
    }
    // Flush a trailing partial multi-byte sequence, so a body cut mid-character reads as U+FFFD rather than
    // dropping the bytes that were already read.
    text += decoder.decode();
  } catch {
    // A body that failed mid-read says no more than the status already did.
  } finally {
    void reader.cancel().catch(() => {});
  }
  return text.slice(0, REFUSAL_BODY_LIMIT).trim();
}

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
  const body = await refusalBody(response);
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  throw new Error(`[rshono] the server answered ${status} (${contentType ?? 'no content type'}) instead of a payload${body ? `: ${body}` : ''}`);
}

/**
 * A payload fetch, split into what React parses and a signal for the end of the stream.
 *
 * The payload promise resolves as soon as the root model is ready, which for a streamed response is well
 * before the response body has delivered its last chunk. {@link loadPayload} needs the second promise to
 * recover a transition React can leave suspended when a later chunk resolves — see the retry there.
 *
 * `settled` means **the body arrived in full**, not "the body is done". It resolves from the pass-through's
 * `flush`, which only runs when the source closes cleanly; a body that errors — an abort, a network drop, a
 * truncated stream — errors the destination instead and leaves `settled` pending for the life of the entry.
 * That is deliberate: the retry is exactly what must not run for a failed stream, and nothing needs a
 * "finished, however it finished" signal today. A later caller that wants one must not read it into this
 * promise.
 */
type FetchedPayload = { payload: Promise<RscPayload>; settled: Promise<void> };

/**
 * Asks a URL for its flight payload. Deliberately uncached — a payload can never be staler than the click
 * that wanted it, and the browser's own HTTP cache is what makes a repeat visit cheap.
 *
 * The body rides through a pass-through so its end is observable: a tee would keep a copy of every byte
 * React has not parsed yet, and the flight stream is the one thing here that can be large.
 */
function requestPayload(href: string, signal?: AbortSignal): FetchedPayload {
  const response = payloadResponse(createRscRequest(new URL(href, location.href).href, undefined, signal));
  const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
  const forFlight = response.then((value) => {
    const body = value.body;
    if (!body) {
      settle();
      return value;
    }
    const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => settle() }));
    return new Response(stream, { status: value.status, statusText: value.statusText, headers: value.headers });
  });
  return { payload: createFromFetch<RscPayload>(forFlight), settled };
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
 * The runtime owns a soft navigation's scroll, so the browser's own restoration has to be off: left on, a
 * traversal restores the destination's offset against the outgoing tree before the payload for that entry
 * has even been asked for, and the incoming tree overwrites it. `manual` only concerns the entries this
 * document creates — a navigation to another document creates its own entry `auto` — and it also turns the
 * browser's reload restoration off, which {@link readStoredScrollPositions} and the first layout effect put
 * back.
 *
 * Gated on the soft router: below the Navigation API floor every navigation is a real document load, which
 * a server-rendered app answers correctly and the browser restores correctly, and taking that over without
 * a router to repaint the entry would strand the visitor at the top.
 */
if (canSoftNavigate) {
  try {
    history.scrollRestoration = 'manual';
  } catch {
    // A preference, not a requirement: where it cannot be set, the browser's restoration and the runtime's
    // own can race on a traversal, and the runtime's runs at commit, after.
  }
}

/** A scroll offset, in the coordinates `window.scrollTo` takes and `window.scrollX`/`window.scrollY` return. */
type ScrollPoint = { x: number; y: number };

/**
 * Where each history entry of this document was left, keyed by its Navigation API key. In memory for the
 * document's life; {@link persistScrollPositions} also writes it to `sessionStorage` so a reload — which
 * the `manual` mode above stops the browser restoring — lands where the last document was left.
 */
const scrollPositions = new Map<string, ScrollPoint>();

/** The `sessionStorage` key holding {@link scrollPositions}. */
const SCROLL_STORAGE_KEY = 'rshono:scroll';

/** How many entries are kept in that snapshot; the oldest falls out first — `Map` iteration order. */
const SCROLL_STORAGE_LIMIT = 50;

/** The key of the history entry being shown, or `undefined` where the soft router does not exist. */
function currentEntryKey(): string | undefined {
  return canSoftNavigate ? navigation.currentEntry?.key : undefined;
}

/**
 * Records where the outgoing entry is being left. Read at `navigate` time — before the browser commits the
 * new entry — and at `pagehide`, so whatever the navigation turns out to be, the entry it leaves has a
 * position to come back to.
 */
function rememberCurrentScroll(): void {
  const key = currentEntryKey();
  if (key) scrollPositions.set(key, { x: window.scrollX, y: window.scrollY });
}

/** The position `key` was left at, or `undefined` when this document never saw it. */
function scrollPointFor(key: string | undefined): ScrollPoint | undefined {
  return key === undefined ? undefined : scrollPositions.get(key);
}

/**
 * Reads the last document's snapshot back into {@link scrollPositions}. Called once, on startup, before the
 * first payload commits: the in-memory map alone would lose every entry the moment the document is replaced.
 */
function readStoredScrollPositions(): void {
  try {
    const raw = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    if (!raw) return;
    for (const [key, point] of Object.entries(JSON.parse(raw) as Record<string, ScrollPoint>)) {
      if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) scrollPositions.set(key, point);
    }
  } catch {
    // Blocked site data, or a snapshot written by a different version. Either way there is nothing to restore,
    // and the page is still correct without it.
  }
}

/** Writes {@link scrollPositions} out, oldest first, bounded — see {@link SCROLL_STORAGE_LIMIT}. */
function persistScrollPositions(): void {
  try {
    while (scrollPositions.size > SCROLL_STORAGE_LIMIT) {
      const oldest = scrollPositions.keys().next().value;
      if (oldest === undefined) break;
      scrollPositions.delete(oldest);
    }
    sessionStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(Object.fromEntries(scrollPositions)));
  } catch {
    // Blocked site data: the in-memory map still carries this document's navigations.
  }
}

/**
 * The snapshot starts with the document, not with hydration: the page is visible and clickable while the
 * initial payload streams, and a reload or a navigation away in that window would otherwise lose the offset
 * now that `manual` has stopped the browser restoring it. Nothing here depends on the router being mounted,
 * so it does not wait for {@link listenNavigation}.
 */
if (canSoftNavigate) {
  window.addEventListener('pagehide', () => {
    rememberCurrentScroll();
    persistScrollPositions();
  });
}

/**
 * Drops a navigation's result promises. Both reject when a navigation is superseded or cancelled — routine
 * here, since a second click is meant to abandon the first — and unhandled they would be reported as faults.
 */
function settle(result: NavigationResult): void {
  const ignore = () => {};
  void result.committed?.catch(ignore);
  void result.finished?.catch(ignore);
}

/**
 * The mark {@link loadDocument} puts on its navigations, so the `navigate` listener below recognizes them as
 * the runtime's own. A symbol because the identity has to survive the trip through the browser intact:
 * `NavigateEvent.info` hands the value back by reference, so only the navigation that was given it matches.
 */
const documentNavigation = Symbol('rshono:document-navigation');

/**
 * Performs a navigation the router below must **not** intercept, and returns having asked for it.
 *
 * `listenNavigation` intercepts a `reload` on purpose — that is what `router.refresh()` is — and every caller
 * here is reaching for a *new document* precisely because the current one cannot be repaired: the React root
 * a soft load would render into is the thing that just failed, or is about to be torn down. Intercepted, the
 * escape hatch becomes a payload fetch that lands nowhere — which is how a late `notFound()` left the tab on
 * its Suspense fallback with no second document ever arriving, and how a late `redirect()` moved the address
 * bar to a page it then failed to render.
 *
 * The mark rides the navigation itself, through `info`, so the listener recognizes the event that owns it
 * instead of consuming a flag set in advance. There is no state to clear and none to leak: a navigation the
 * browser refuses cannot make the next one a full load. Below the Navigation API there is no interception to
 * opt out of, and `location.*` is already a document load.
 */
function loadDocument(href?: string): void {
  if (!canSoftNavigate) {
    if (href === undefined) window.location.reload();
    else window.location.assign(href);
    return;
  }

  try {
    settle(href === undefined ? navigation.reload({ info: documentNavigation }) : navigation.navigate(href, { info: documentNavigation }));
  } catch {
    // The Navigation API refuses a document that is not fully active — it is unloading — and a URL it cannot
    // parse. Both callers are recovery paths, where a throw here becomes an unhandled rejection rather than
    // the document load they asked for. `location.*` is the same load without the interception, and its own
    // refusal (the same unparseable URL) is swallowed because there is then no load left to make.
    try {
      if (href === undefined) window.location.reload();
      else window.location.assign(href);
    } catch {
      // Nothing to navigate to. The caller is already recovering from a failure, and the address bar still
      // describes the document on screen.
    }
  }
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

/** The `sessionStorage` key bounding the recovery reload for one URL. Spent here, released in {@link main}. */
const lateNotFoundKey = (): string => `rshono:late-not-found:${documentUrl()}`;

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
  const key = lateNotFoundKey();
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

  loadDocument();

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
    // The URL is resolved first: a malformed location then throws here, before any navigation is asked for.
    loadDocument(new URL(redirect.location, window.location.href).href);
  } else {
    push(redirect.location);
  }
  return true;
}

/**
 * Scrolls the document to its start.
 *
 * The options form rather than `scrollTo(0, 0)`: the two-argument call is `auto`, which follows a
 * `scroll-behavior` the app may have set on `html`, and a soft navigation that animates its own reset reads
 * as a glitch rather than a page change.
 */
function scrollToTop(): void {
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
}

/** Puts a saved offset back. Instant for the same reason {@link scrollToTop} passes it. */
function scrollToPoint(point: ScrollPoint): void {
  window.scrollTo({ top: point.y, left: point.x, behavior: 'instant' });
}

/**
 * How long a commit waits for a fragment target or `autofocus` element that a boundary has not streamed in
 * yet. Past it the fallback stands — the top of the document, or body focus — and the watch is dropped, so a
 * fragment that names nothing leaves no observer running behind it.
 */
const ELEMENT_WATCH_TIMEOUT_MS = 5_000;

/**
 * Elements a commit asked for that were not in the tree yet: a `#hash` target inside a still-suspended
 * `<AsyncBoundary>`, or the `autofocus` element of a page being traversed into.
 *
 * One `MutationObserver` answers every pending watch. A streamed payload inserts its chunks as separate
 * mutations, so the observer re-checks each watch's lookup until one hits or its timer retires it. A watch is
 * only ever live across one payload: the next navigation drops them all, so a destination the user has left
 * cannot scroll or focus the page that replaced it.
 */
type PendingElementWatch = {
  find: () => Element | null;
  run: (element: Element) => void;
  /** Retires the watch if the element never arrives. */
  timer: ReturnType<typeof setTimeout>;
};

const pendingElementWatches = new Set<PendingElementWatch>();
let elementObserver: MutationObserver | null = null;

function stopElementWatch(watch: PendingElementWatch): void {
  clearTimeout(watch.timer);
  if (!pendingElementWatches.delete(watch)) return;
  if (pendingElementWatches.size === 0) {
    elementObserver?.disconnect();
    elementObserver = null;
  }
}

/** Drops every watch; a new navigation owns the screen from here. */
function cancelElementWatches(): void {
  for (const watch of [...pendingElementWatches]) stopElementWatch(watch);
}

/**
 * Runs `run` as soon as `find` finds an element, or gives up after {@link ELEMENT_WATCH_TIMEOUT_MS}. When
 * the element is already there, `run` happens synchronously. `find` and `run` are always passed as a matching
 * pair; the type-erasure here is what lets one observer serve watches of different element shapes.
 */
function watchForElement<T extends Element>(find: () => T | null, run: (element: T) => void): void {
  const present = find();
  if (present) {
    run(present);
    return;
  }
  if (elementObserver === null) {
    elementObserver = new MutationObserver(() => {
      for (const watch of [...pendingElementWatches]) {
        const element = watch.find();
        if (element) {
          stopElementWatch(watch);
          watch.run(element);
        }
      }
    });
    elementObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  const watch: PendingElementWatch = {
    find,
    run: run as (element: Element) => void,
    timer: setTimeout(() => stopElementWatch(watch), ELEMENT_WATCH_TIMEOUT_MS),
  };
  pendingElementWatches.add(watch);
}

/**
 * Scrolls to a fragment's target the way the browser's own fragment jump does.
 *
 * `scrollIntoView` is the algorithm that honours `scroll-padding-top` on the scrolling box and
 * `scroll-margin-top` on the target, which `window.scrollTo` does not. The lookup follows the browser's
 * "find a potential indicated element": the id first, then the name. A malformed percent-escape falls back
 * to the literal fragment, and a fragment nothing matches gets the top of the document — what a browser
 * gives a missing anchor on a real load.
 *
 * A streamed payload commits its shell before a target inside a suspended boundary exists, so a miss is not
 * final: the top is applied right away, and the watch follows the fragment in when its element arrives.
 */
function jumpToAnchor(hash: string): void {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  // No special case for `#top`: the browser only treats it as the top of the document when no element
  // matches, and the fallback below is that top.
  if (raw === '') {
    scrollToTop();
    return;
  }
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Malformed escape — the literal fragment is the better guess at the id than nothing.
  }
  const find = () => document.getElementById(id) ?? document.getElementsByName(id)[0] ?? null;
  const target = find();
  if (target) {
    target.scrollIntoView();
    return;
  }
  scrollToTop();
  watchForElement(find, (element) => element.scrollIntoView());
}

/**
 * Moves focus the way the browser's `focusReset: 'after-transition'` does: the first `autofocus` element,
 * else the document body. A traversal is no longer intercepted, so the browser performs no focus reset for
 * it; without this, Back would leave focus on the link that was clicked on the page being left, and the next
 * Tab would resume there. `preventScroll` because the traversal's own offset has just been restored.
 *
 * The page may still be streaming — a traversal into a page whose `autofocus` element sits in a suspended
 * boundary — and the browser's own reset follows the element in, so this watches for it with the same bound
 * as a fragment.
 */
function resetFocus(): void {
  const autofocus = document.querySelector<HTMLElement>('[autofocus]');
  if (autofocus) {
    autofocus.focus({ preventScroll: true });
    return;
  }
  document.body.focus({ preventScroll: true });
  watchForElement(
    () => document.querySelector<HTMLElement>('[autofocus]'),
    (element) => {
      // Only if focus is still where this reset left it: a user who has since focused something else keeps it.
      if (document.activeElement === document.body) element.focus({ preventScroll: true });
    },
  );
}

/**
 * Puts a payload on screen, resolving once React has committed it. Replaced by `BrowserRoot`'s own on mount;
 * the default covers the window before hydration, where `setServerCallback` is already registered but there
 * is no root to update — a reload is the honest answer, and nothing after it needs to run.
 *
 * `afterCommit`, when given, runs in the same layout effect that releases the commit: after the new tree is
 * in the DOM and before the browser paints, which is the only moment a `#hash` target exists and the
 * pre-scroll position has not been shown.
 */
let setPayload: (payload: RscPayload, afterCommit?: () => void) => Promise<void> = () => {
  window.location.reload();
  return new Promise<void>(() => {});
};

/**
 * Re-dispatches the payload already waiting to commit, for {@link loadPayload}'s lost-ping retry. Unlike
 * {@link setPayload} it creates and releases no commit promise, so re-rendering the same payload cannot
 * resolve the navigation's commit early. Assigned with {@link setPayload} by `BrowserRoot`.
 */
let reapplyPayload: () => void = () => {};

/** Runs work inside the nav transition so `useNavigation().pending` stays true across the round-trip. */
let startNav: (run: () => void | Promise<void>) => void = (run) => {
  void run();
};

/**
 * The navigation whose payload is allowed to settle the screen. React runs async work concurrently, so two
 * navigations are two live fetches with no ordering between them; without this a slow first response landing
 * after a fast second one repaints the page the user already left. The Navigation API aborts an intercepted
 * navigation when a newer one starts, but a traversal has no `event.signal` to watch — `popstate` arrives
 * after the browser has already committed it — so ordering is the runtime's own for those.
 */
let currentNavigation = 0;

/**
 * A navigation fetch, and whether its payload has been handed to React. An **applied** fetch is deliberately
 * not aborted when it loses the screen: React is still reading its stream, and aborting it rejects every
 * flight chunk still in flight — the nearest boundary renders the `AbortError` as a failure, and the root can
 * unwind into React's "Rendered more hooks than during the previous render" (minified error #310). The commit
 * of a newer payload is the first moment the old tree is off the screen and out of React, so the abort is
 * deferred to here, where the rejected chunks have nowhere to surface.
 *
 * An unapplied fetch has no such reader: nothing holds its stream, so it can be stopped the moment it loses
 * the screen — when a newer navigation starts, or when the browser cancels this navigation and nothing takes
 * its place (a fragment jump or a download, where no later commit would ever run an abort). Leaving those to
 * a commit that never comes is how a render nobody is waiting for stays alive.
 *
 * Pruned when a payload commits and when a newer navigation starts. A fetch stopped by a browser cancellation
 * waits for one of those to drop it; the entries that remain are the applied ones plus the current fetch.
 */
type NavigationFetch = { navigation: number; controller: AbortController; applied: boolean };
let navigationFetches: NavigationFetch[] = [];

/**
 * Fetches the payload for `url` and puts it on screen.
 *
 * Resolves once React has **committed** it rather than when the fetch lands: `afterCommit` runs at that
 * point, and a `#hash` target does not exist until the new tree does. Rejects only on a genuine failure —
 * being superseded is not one, and resolves quietly, because the navigation that replaced this one owns the
 * screen from then on.
 */
function loadPayload(url: string, signal?: AbortSignal, afterCommit?: () => void): Promise<void> {
  // This navigation's place in the queue, and its own abort switch: the navigation stops being applied by
  // whichever comes first, the browser superseding it (an intercepted navigation carries `event.signal`) or a
  // newer runtime fetch starting (a traversal, an action, a dev refresh). The fetch itself runs on until its
  // payload is on screen and a newer one commits — see {@link navigationFetches}.
  const navigation = ++currentNavigation;
  const controller = new AbortController();
  const entry: NavigationFetch = { navigation, controller, applied: false };
  navigationFetches.push(entry);

  // A newer navigation owns the screen now, and an older fetch whose payload never reached React is reading
  // into a tree that does not exist — stopping it cannot reject a chunk anything holds. One that did reach
  // React waits for this payload's commit; see {@link navigationFetches}.
  navigationFetches = navigationFetches.filter((fetch) => {
    if (fetch === entry || fetch.applied) return true;
    fetch.controller.abort();
    return false;
  });

  // The browser supersedes an intercepted navigation the moment a newer one starts, and `signal` is how it
  // says so. A fetch React has been handed keeps running (see {@link navigationFetches}), but one that never
  // reached React stops here: the navigation taking over may be one the runtime does not intercept (a
  // fragment jump, a download), leaving no commit to stop it later.
  let abandoned = signal?.aborted ?? false;
  const abandon = () => {
    abandoned = true;
    if (!entry.applied) controller.abort();
  };
  if (abandoned) abandon();
  else signal?.addEventListener('abort', abandon, { once: true });
  /** Whether this navigation has lost the screen to the browser or to a newer runtime fetch. */
  const stale = (): boolean => abandoned || navigation !== currentNavigation || controller.signal.aborted;

  // Deliberately not awaited inside the transition: the scope ends once the payload is handed to React, and
  // React holds `pending` until the update it scheduled commits. Awaiting the commit *inside* the scope would
  // work too, but only because React happens not to gate a commit on its async scope settling — an internal
  // this has no reason to depend on across the whole `^19.1.0` peer range.
  let committed: Promise<void> | undefined;
  // Whether the payload update has committed. A streamed transition can suspend on a flight chunk whose later
  // resolution React never pings the lane back for; the retry below re-schedules the update once the stream
  // has closed, but only while this is still false.
  let committedSettled = false;

  const run = async () => {
    const { payload, settled } = requestPayload(url, controller.signal);
    const nextPayload = await payload;
    // Checked again after the await because the fetch may already have resolved by then, and applying it
    // would repaint a page the user has left.
    if (stale()) return;
    if (nextPayload.redirect) {
      push(nextPayload.redirect);
      return;
    }
    // The fetch crossed an await, so its payload update needs a new synchronous transition scope.
    // Keep the commit promise outside the async Action; React tracks the scheduled update until commit.
    React.startTransition(() => {
      // From here React holds this payload's stream, so a superseded fetch may not be stopped until a newer
      // payload commits — see {@link navigationFetches}.
      entry.applied = true;
      committed = setPayload(nextPayload, afterCommit);
      void committed.then(() => (committedSettled = true));
    });

    // This payload is on screen, so every fetch it superseded is reading into a tree React has replaced.
    // Stopping them now cannot reject a chunk the committed tree holds — see {@link navigationFetches}.
    // Only the older ones: a newer navigation may have started while this payload was in flight, and its
    // fetch is the one the screen is waiting for.
    void committed?.then(() => {
      navigationFetches = navigationFetches.filter((fetch) => {
        if (fetch.navigation >= navigation) return true;
        fetch.controller.abort();
        return false;
      });
    });

    // A streamed payload can suspend a transition on a flight chunk that resolves after the shell without
    // React ever pinging the suspended lane back, which strands the navigation on the previous tree. The
    // chunks have all landed by the time the stream closes, so one re-application — still a transition, so a
    // payload that is waiting on something other than flight keeps the #52 behaviour — commits the render a
    // lost ping stranded. It goes through `reapplyPayload` rather than `setPayload`: the payload is not
    // replaced, so the commit the navigation waits on has to stay attached to it. The macrotask lets the
    // decoder process the last chunk and React's own retry run first, so the normal path is not interrupted.
    void settled.then(() => {
      if (stale() || committedSettled) return;
      setTimeout(() => {
        if (stale() || committedSettled) return;
        React.startTransition(reapplyPayload);
      }, 0);
    });
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
      if (stale() || handleControlDigest(error)) return;
      throw error;
    },
  );
}

/**
 * Whether a destination names a file rather than a page. `public/`, `/_static` and an endpoint route that
 * serves a document (`/llms.txt`, `/sitemap.xml`) answer an RSC fetch with the file itself, not a flight
 * payload — so intercepting one buys nothing: the payload never arrives, and the only recovery left is the
 * document load the browser would have made directly. Handing it that navigation up front also gives the
 * entry the file loads into the browser's own history, so Back is an ordinary cross-document traversal. An
 * intercepted entry is same-document by construction, and traversing one with nothing to repaint it changes
 * the URL and nothing else — which is what a Back press out of an opened file was doing.
 *
 * A dot in the last path segment rather than a list of extensions: a list is never complete, and every miss
 * is the failed round trip above. A page route whose last segment carries a dot (`/release-1.0`) therefore
 * costs a document load — the direction to err in, and what a `data-native` link already asks for by hand.
 */
function namesAFile(href: string): boolean {
  const lastSegment = new URL(href).pathname.split('/').pop() ?? '';
  return lastSegment.includes('.');
}

/**
 * Navigations the browser can hand over but shouldn't:
 *
 * - a fragment jump, which is same-document already and needs no payload — the browser's own jump is the one
 *   that honours `scroll-padding-top`, and re-rendering would pull the target out from under it;
 * - a download, which is not a navigation of this page at all;
 * - a `POST` form, which is a submission and the server's to answer (a `GET` form carries its fields in the
 *   URL, has no `formData`, and soft-navigates like any other link);
 * - a link marked `data-native`, the documented opt-out;
 * - a destination that names a file — see {@link namesAFile}.
 */
function leaveToBrowser(event: NavigateEvent): boolean {
  return (
    event.hashChange ||
    event.downloadRequest !== null ||
    event.formData !== null ||
    event.sourceElement?.hasAttribute('data-native') === true ||
    namesAFile(event.destination.url)
  );
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
    // A document navigation the runtime asked for itself, marked through `info`. Checked before the scroll
    // snapshot: the document is going away, so where its entry was left does not matter, and an unrelated
    // later navigation can never be mistaken for this one.
    if (event.info === documentNavigation) return;

    // A commit for the destination being left is no longer the screen's; its pending fragment target (or
    // `autofocus` element) must not scroll or focus the page that replaces it.
    cancelElementWatches();

    // Whatever the browser is about to do with this navigation, the entry it is leaving is about to lose the
    // offset it was at, and nothing else in this document will put it back. Saved before the branches below
    // return, so a fragment the browser performs itself is covered too.
    rememberCurrentScroll();

    if (!event.canIntercept || leaveToBrowser(event)) return;

    // A traversal is repainted by the `popstate` listener below, not intercepted. `intercept`ing one is what
    // makes WebKit stall the rendered viewport for about three seconds on a back swipe
    // (bugs.webkit.org/319414): the view gesture's snapshot is only removed once the navigation finishes, and
    // React's root attaches the wheel listener the bug also needs. Letting the traversal through means the
    // browser commits the entry straight away, and the runtime puts the payload on screen when it arrives.
    if (event.navigationType === 'traverse') return;

    // A replace or a refresh stays where it is, so neither should move. A push starts at the top of the
    // page, or at its fragment — and that scroll is the runtime's own now: WebKit performs no
    // `after-transition` reset at all for an intercepted push (bugs.webkit.org/304593). Chromium skips it
    // too, and a fragment jump rides the same code path. Passing `manual` here makes the browser hand the
    // handler over without scrolling; the `afterCommit` callback reaches the target once the new tree is on
    // screen. Focus stays the browser's, reset after the transition.
    const inPlace = event.navigationType === 'replace' || event.navigationType === 'reload';
    let afterCommit: (() => void) | undefined;
    if (event.navigationType === 'push') {
      const { hash } = new URL(event.destination.url);
      afterCommit = hash === '' ? scrollToTop : () => jumpToAnchor(hash);
    }

    event.intercept({
      scroll: 'manual',
      focusReset: inPlace ? 'manual' : 'after-transition',
      // The URL commits before the handler runs, so a failure leaves the address bar describing a page the
      // document is not showing. A real load is the only way back to agreement.
      handler: () => loadPayload(event.destination.url, event.signal, afterCommit).catch(() => loadDocument()),
    });
  };

  /**
   * Repaints a traversal the listener above deliberately left to the browser, and moves the viewport back
   * where the entry was left. `popstate` fires after the browser has committed the entry, so the destination
   * is `navigation.currentEntry` and its saved offset is in {@link scrollPositions}.
   */
  const onPopState = () => {
    // Same ownership as `onNavigate`: this traversal's commit replaces whatever the last one was waiting for.
    cancelElementWatches();
    const stored = scrollPointFor(currentEntryKey());
    const hash = location.hash;
    const apply = () => {
      if (stored) scrollToPoint(stored);
      else if (hash !== '') jumpToAnchor(hash);
      else scrollToTop();
    };

    // A fragment-only traversal never changed the payload: the address bar is back at an anchor of the page
    // already on screen, so there is nothing to fetch and nothing to wait for. The browser's own restoration
    // is off, so the offset comes from what `onNavigate` saved when the anchor was followed; no focus reset,
    // which is what leaving those navigations to the browser has always meant.
    if (documentUrl() === renderedUrl) {
      apply();
      return;
    }

    void loadPayload(location.href, undefined, () => {
      apply();
      // The browser performs this for an intercepted navigation; a traversal is no longer intercepted, so
      // without it Back would leave focus on the link that was clicked on the page being left.
      resetFocus();
    }).catch(() => loadDocument());
  };

  navigation.addEventListener('navigate', onNavigate);
  window.addEventListener('popstate', onPopState);
  return () => {
    navigation.removeEventListener('navigate', onNavigate);
    window.removeEventListener('popstate', onPopState);
  };
}

async function main() {
  // The assertion is load-bearing under the compiler that builds this: TypeScript 7 declares `nonce` on
  // HTMLElement, 6 declares it on Element. ESLint runs the older lib — where the narrowing is redundant —
  // so it reports an assertion that `tsc` requires. Believe `typecheck`, not the rule.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const cspMeta = document.querySelector('meta[property="csp-nonce"]') as HTMLMetaElement | null;
  if (cspMeta?.nonce) __webpack_nonce__ = cspMeta.nonce;

  const initialPayload = await createFromReadableStream<RscPayload>(flightStream);

  // The recovery reload landed: this document *is* the `notFound` page, so the signal that could only be a
  // digest on the `RSC: 1` request became a real 404 on the document request. The one-reload bound was spent
  // on a recovery that worked and has to be released — otherwise the *next* soft navigation to this URL sees a
  // spent key and paints {@link showLateNotFound} over a page the app can still render.
  //
  // This is the discriminator the bound was missing. A structurally late `notFound()` commits its 200 before
  // it signals, so its reloaded document is the page itself and carries no `notFound`: the key survives and
  // that loop stays bounded at one reload, which is the whole reason the bound exists.
  if (initialPayload.notFound) {
    try {
      sessionStorage.removeItem(lateNotFoundKey());
    } catch {
      // Blocked site data. `reloadOnceForLateNotFound` already treats that as the terminating case.
    }
  }

  // Everything the last document saved, read before any payload commits: the in-memory map alone would not
  // survive the reload that `history.scrollRestoration = 'manual'` just stopped the browser restoring. The
  // entry's key is stable across a reload, and the offset is applied by `BrowserRoot`'s first layout effect,
  // before the first paint of the new tree.
  if (canSoftNavigate) readStoredScrollPositions();
  const restored = scrollPointFor(currentEntryKey());

  function BrowserRoot() {
    const [payload, setPayloadState] = React.useState(initialPayload);
    const [pending, startTransition] = React.useTransition();
    // The payload the last `setPayload` put on screen or on its way there, so `reapplyPayload` re-renders
    // that one rather than a payload a later navigation or action has already replaced.
    const currentPayload = React.useRef<RscPayload>(initialPayload);
    // The resolver the payload on screen still owes — see {@link loadPayload}.
    const pendingCommit = React.useRef<(() => void) | null>(null);
    // The scroll the payload about to commit owes, set with it so a payload that supersedes another takes
    // its predecessor's scroll out of the queue along with its commit. Initialised with the reload's offset:
    // the first layout effect below applies it with the first payload, before the new tree is painted.
    const pendingScroll = React.useRef<(() => void) | null>(restored ? () => scrollToPoint(restored) : null);

    // Descendant passive effects can start a navigation before the root's passive effects run.
    // Install the live payload setter and transition runner before any such navigation starts.
    React.useLayoutEffect(() => {
      setPayload = (next, afterCommit) => {
        currentPayload.current = next;
        return new Promise<void>((resolve) => {
          // A payload replaced before it ever painted still has a navigation waiting on it. React commits
          // only the newest, so the effect below never runs for the one it skipped: release it here.
          pendingCommit.current?.();
          pendingCommit.current = resolve;
          // Replaced rather than kept: a server action's payload carries no `afterCommit`, and the
          // navigation it superseded must not scroll the page the action is about to replace it with.
          pendingScroll.current = afterCommit ?? null;
          setPayloadState(next);
        });
      };
      // A re-dispatch of the payload above, for the retry in `loadPayload`: keeping `pendingCommit` and
      // `pendingScroll` in place means the navigation already waiting resolves when this render commits,
      // not when the retry runs.
      reapplyPayload = () => setPayloadState(currentPayload.current);
      startNav = (run) => startTransition(run);
    }, [startTransition]);

    /**
     * Performs the pending scroll and releases the navigation waiting on this payload. A layout effect, so
     * the new tree is in the DOM and the pre-scroll position is never painted.
     */
    React.useLayoutEffect(() => {
      const scroll = pendingScroll.current;
      pendingScroll.current = null;
      scroll?.();
      // What the payload that just committed was rendered for — see {@link renderedUrl}. A redirect never
      // reaches here, and an action or a dev refresh keeps the URL it was fetched for.
      renderedUrl = documentUrl();
      const commit = pendingCommit.current;
      pendingCommit.current = null;
      commit?.();
    }, [payload]);

    // A descendant may navigate from its first passive effect. Intercept it before that effect runs.
    React.useLayoutEffect(() => listenNavigation(), []);

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
      // that had already run has its result carried across (see `actionResults` in entry.rsc.tsx), and the
      // ways a *caller* can get a request wrong are refused ahead of any render — an unknown id or an
      // undecodable body is a `text/plain` 400, which `payloadResponse` turns into an error of its own
      // before this.
      //
      // What is left is the server failing before the action ran, which is answered with the `error` page —
      // a flight payload, so it arrives here rather than at `payloadResponse`, with no `returnValue` in it.
      // A module the deployment no longer holds is the reachable case: `loadServerAction` throws, the
      // framework reports it and 500s, and this is what the caller has to go on. Hence the message: the
      // failure is on the server and its log is where the error is. Below that it is still the defensive
      // floor for a payload shaped by another deployment or replaced by a proxy — reading `.ok` off it used
      // to hand the caller `Cannot read properties of undefined`.
      throw new Error(
        '[rshono] the server action produced no result — the request failed around it and the server answered with a page instead. Its log has the error.',
      );
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
    loadDocument();
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
          await loadPayload(window.location.href).catch(() => loadDocument());
        }
        connectedOnce = true;
        break;
      case 'client-built':
        targetHash = message.hash;
        await applyClientUpdate();
        break;
      case 'rsc-update':
        console.log('[rshono] server components updated');
        await loadPayload(window.location.href).catch(() => loadDocument());
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
