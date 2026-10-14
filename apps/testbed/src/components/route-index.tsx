import type { HTTPMethod, Route } from '@rshono/core';
import { routes } from '../routes';

/**
 * The manual-test index at the bottom of the home page.
 *
 * The route list itself is derived from `src/routes.ts` — the very objects the framework routes — so a
 * route added there shows up here without anyone remembering to edit two places. What cannot be derived
 * is what a route is *for*, so every path has an entry in `META`, and `META` is annotated with the route
 * paths as a union: adding a route without describing it is a compile error here rather than a page that
 * stays invisible.
 */

/**
 * Section order on the page. A `group` in `META` has to be one of these, so a typo is a type error
 * rather than a section that silently never renders.
 */
const GROUPS = ['Pages & forms', 'Navigation', 'Streaming & suspense', 'Errors & fallbacks', 'API endpoints'] as const;

type Group = (typeof GROUPS)[number];

/** Every route path in `src/routes.ts`, as a union of literals. */
type RoutePath = (typeof routes.routes)[number]['path'];

/**
 * The route table widened to `Route[]`: `defineRoutes` keeps the literals (that is what `RoutePath` and the
 * `META` check below need), but the literal entries omit optional fields — `type` on a page, `render` on
 * most — and the union does not let us read them. `Route` is the shape with those fields answered.
 */
const ALL_ROUTES: readonly Route[] = routes.routes;

interface RouteMeta {
  /** Short label shown next to the path. */
  title: string;
  /** What the route demonstrates — the reason to open it. */
  description: string;
  group: Group;
  /** Where the path link points when the route needs params. Defaults to the path itself. */
  example?: string;
  /** Other URLs worth a manual look: query variants, a second param value. */
  variants?: Array<{ href: string; label: string }>;
}

// Annotated, not inferred: `Record<RoutePath, RouteMeta>` is what makes a missing description an error.
const META: Record<RoutePath, RouteMeta> = {
  '/': {
    group: 'Pages & forms',
    title: 'Home',
    description: "This page: the route index below, then the `'use client'` counter island and the `PUBLIC_` env check.",
  },
  '/signup': {
    group: 'Pages & forms',
    title: 'Sign Up',
    description: 'A `useActionState` form action with progressive enhancement — it submits before hydration and with JavaScript disabled.',
  },
  '/subscribe': {
    group: 'Pages & forms',
    title: 'Subscribe',
    description: "A form a server component renders, wired straight to a `'use server'` action — the no-`useActionState` shape.",
  },
  '/login': {
    group: 'Pages & forms',
    title: 'Log in',
    description: "A server action sets a session cookie and calls `redirect('/dashboard')` — a real POST-redirect-GET without JS.",
  },
  '/dashboard': {
    group: 'Pages & forms',
    title: 'Dashboard',
    description: 'Reads the session cookie and `redirect()`s to `/login` when it is missing. Log in first to see it.',
  },
  '/docs/:slug': {
    group: 'Pages & forms',
    title: 'Static docs',
    description:
      "`render: 'static'` — prerendered at build time via `staticPaths`, including a slug that is not ASCII (`café`) to prove the encoding round trip.",
    example: '/docs/getting-started',
    variants: [
      { href: '/docs/deployment', label: '/docs/deployment' },
      { href: '/docs/café', label: '/docs/café (encoded slug)' },
    ],
  },
  '/profile/:id': {
    group: 'Pages & forms',
    title: 'Profile',
    description: "Typed route params (`PageProps<'/profile/:id'>`), with `notFound()` for an id that does not exist.",
    example: '/profile/1',
    variants: [{ href: '/profile/999', label: '/profile/999 → the 404 page' }],
  },
  '/users': {
    group: 'Pages & forms',
    title: 'Users',
    description: 'Async server component reading the server-only `db` module directly, plus a form that calls a server action.',
  },
  '/whoami': {
    group: 'Pages & forms',
    title: 'whoami',
    description: '`getRequestContext()` inside a nested async component — headers, cookies and env without imports.',
  },

  '/navigation-async-boundary': {
    group: 'Navigation',
    title: 'Async boundary',
    description: 'A soft navigation whose URL update is suspended on an async boundary. Press Navigate, then Resolve or Reject.',
  },
  '/navigation-async-other': {
    group: 'Navigation',
    title: 'Async boundary (second URL)',
    description: 'The same fixture at a second path, so a navigation can be made from one stable URL to another.',
  },
  '/navigation-async-propagate': {
    group: 'Navigation',
    title: 'Async boundary — propagate',
    description: 'The fixture with the boundary error fallback omitted, so a rejected child has to propagate outward.',
  },
  '/navigation-async-nested': {
    group: 'Navigation',
    title: 'Async boundary — nested',
    description: 'The fixture with an outer boundary around the inner one, to see which one catches a rejection.',
  },
  '/navigation-address-suspense': {
    group: 'Navigation',
    title: 'Address suspense',
    description: 'A destination that suspends while the browser address is already committed to the new URL.',
  },
  '/navigation-suspense': {
    group: 'Navigation',
    title: 'Suspense destination',
    description: 'A navigation payload that suspends independently of the live address.',
    variants: [{ href: '/navigation-suspense?tab=activity', label: '/navigation-suspense?tab=activity' }],
  },
  '/streamed-boundary-a': {
    group: 'Navigation',
    title: 'Streamed boundary A',
    description:
      'Soft navigation between two pages whose async boundary child resolves only after the shell — the streamed-navigation-payload shape.',
  },
  '/streamed-boundary-b': {
    group: 'Navigation',
    title: 'Streamed boundary B',
    description: 'The other half of the pair; linked from A and back again.',
  },
  '/mount-navigation': {
    group: 'Navigation',
    title: 'Navigate on mount',
    description: 'A client component that soft-navigates to `/users` on mount, replace or push.',
    variants: [{ href: '/mount-navigation?method=push', label: '/mount-navigation?method=push' }],
  },
  '/slow-shell': {
    group: 'Navigation',
    title: 'Slow shell',
    description: "The testbed's middleware holds this response's head for five seconds, so a navigation to it can be cancelled mid-flight.",
  },
  '/slow-shell-source': {
    group: 'Navigation',
    title: 'Slow shell source',
    description: 'The page you navigate from in the cancelled-navigation test: links to /slow-shell and a same-page anchor to cancel with.',
  },

  '/slow-stream': {
    group: 'Streaming & suspense',
    title: 'Slow stream',
    description:
      'The shell flushes immediately and the content arrives after a two-second suspension — a response still open when a dev rebuild lands.',
  },
  '/anchor-stream': {
    group: 'Streaming & suspense',
    title: 'Streamed anchor',
    description: 'A `#hash` target that only exists after the stream, so a soft anchor navigation has to wait for it.',
  },
  '/boundary': {
    group: 'Streaming & suspense',
    title: 'AsyncBoundary',
    description: 'One `<AsyncBoundary>` with loading and error fallbacks around an async section.',
    variants: [{ href: '/boundary?fail=1', label: '/boundary?fail=1 → the section throws' }],
  },
  '/suspense-redirect': {
    group: 'Streaming & suspense',
    title: 'Suspense redirect',
    description: '`redirect()` from inside a bare `<Suspense>` after the shell resolved — a 303 on a hard load, a control signal on a soft one.',
  },
  '/late-signal': {
    group: 'Streaming & suspense',
    title: 'Late control signal',
    description:
      'A control signal raised well after the shell, where no 3xx is possible any more: the response has to stop cleanly while a slow section is still rendering.',
    variants: [{ href: '/late-signal?signal=notfound', label: '/late-signal?signal=notfound' }],
  },

  '/crash': {
    group: 'Errors & fallbacks',
    title: 'Error-page demos',
    description:
      'A throwing server action, or a render that throws before the shell — both reach the `error` page, the second one from a fresh render.',
    variants: [
      { href: '/crash?render=1', label: '/crash?render=1 → throw during render' },
      { href: '/crash?ssr=1', label: '/crash?ssr=1 → fail only the SSR pass' },
    ],
  },
  '/unloadable': {
    group: 'Errors & fallbacks',
    title: 'Unloadable page',
    description:
      'Deliberately broken: the page module throws as it evaluates, which is what a missing chunk after a deploy looks like. It answers with the `error` page.',
  },

  '/api/quick-health': {
    group: 'API endpoints',
    title: 'Health check',
    description: "A `type: 'endpoint'` route with a Hono handler in a server module. GET (and the HEAD that rides it).",
  },
  '/api/preflight': {
    group: 'API endpoints',
    title: 'CORS preflight',
    description: 'Answers the OPTIONS a cross-origin server action needs before the browser will send it.',
  },
  '/api/session': {
    group: 'API endpoints',
    title: 'Session echo',
    description: 'One handler behind two methods; it replies with the method it was called with.',
  },
  '/api/acs': {
    group: 'API endpoints',
    title: 'Cross-site form post',
    description:
      'Takes the arrival shape of a SAML ACS or OIDC `form_post` callback — a POST a page route refuses. Send one with `curl`; a GET just answers 400.',
  },
  '/api/boom': {
    group: 'API endpoints',
    title: 'Throwing endpoint',
    description: 'Always throws, to exercise the uncaught-error path. `?throw=plain` throws a non-Error.',
    variants: [{ href: '/api/boom?throw=plain', label: '/api/boom?throw=plain' }],
  },
};

function metaFor(path: string): RouteMeta {
  // The cast is sound and the runtime lookup always hits: `META` is a `Record` over exactly these paths.
  return META[path as RoutePath];
}

/** An endpoint's `method`, human-readable; a route with none answers every method. */
function methodLabel(method: HTTPMethod | readonly HTTPMethod[] | undefined): string {
  if (method === undefined) return 'ALL';
  const methods = typeof method === 'string' ? [method] : method;
  return methods.map((m) => m.toUpperCase()).join(' + ');
}

/** Renders the backtick spans in a description as `<code>`, so the prose can name identifiers. */
function Description({ text }: { text: string }) {
  return <p className="route-desc">{text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}</p>;
}

function RouteRow({ route }: { route: Route }) {
  const meta = metaFor(route.path);
  const isEndpoint = route.type === 'endpoint';

  return (
    <li className="route-item">
      <div className="route-head">
        {/* Endpoints answer JSON or a redirect, not a page, so they get a document load rather than an RSC fetch. */}
        <a className="route-path" href={isEndpoint ? route.path : (meta.example ?? route.path)} data-native={isEndpoint ? '' : undefined}>
          <code>{route.path}</code>
        </a>
        <span className="route-title">{meta.title}</span>
        {isEndpoint && <span className="route-tag">{methodLabel(route.method)}</span>}
        {!isEndpoint && route.render === 'static' && <span className="route-tag">static</span>}
      </div>
      <Description text={meta.description} />
      {meta.variants && (
        <p className="route-variants">
          Also try{' '}
          {meta.variants.map((variant, i) => (
            <span key={variant.href}>
              {i > 0 && ' · '}
              <a href={variant.href} data-native={isEndpoint ? '' : undefined}>
                {variant.label}
              </a>
            </span>
          ))}
        </p>
      )}
    </li>
  );
}

export function RouteIndex() {
  const groups = GROUPS.map((group) => ({
    group,
    entries: ALL_ROUTES.filter((route) => metaFor(route.path).group === group),
  })).filter(({ entries }) => entries.length > 0);

  return (
    <section className="route-index" aria-labelledby="route-index-heading">
      <h1 id="route-index-heading">Test pages</h1>
      <p className="description">
        Every route in <code>src/routes.ts</code>, grouped. Click a path to open it — the description says what it exercises.
      </p>

      {groups.map(({ group, entries }) => (
        <section key={group} className="route-group">
          <h2>{group}</h2>
          <ul className="route-list">
            {entries.map((route) => (
              <RouteRow key={route.path} route={route} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
