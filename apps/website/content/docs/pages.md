---
title: Pages
description: A page is a React server component that renders the whole document and receives the request — and the 'use server' actions it mutates through.
---

Every page module **default-exports a server component** — nothing else. It may be `async` and await
data directly.

```tsx
import type { PageProps } from '@rshono/core';
import { db } from '../db';

export default async function Profile({ params, ctx }: PageProps<'/profile/:id'>) {
  const user = await db.getUser(params.id);
  const theme = ctx.cookies.get('theme') ?? 'light';
  return <Layout theme={theme}>{user.name}</Layout>;
}
```

Pages render the **entire document** (`<html>…</html>`), usually through a shared layout component.
Interactive parts are `'use client'` components the page imports — only those ship JavaScript.

There is no `<Link>`, `<Image>`, `<Script>` or `<Head>`: links are `<a href>`, images are `<img>`, forms
are `<form action>`. Same-origin anchors are soft-navigated automatically; `data-native` opts one out.

## Page props

Every page receives `{ url, params, ctx }`. They are server-only and never serialized — React puts a
server component's _output_ on the wire, not its props.

| Prop     | What it is                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`    | The absolute browser-facing `URL`, proxy-header aware. A fresh instance per request.                                                                                                         |
| `params` | The matched route params. `PageProps<'/profile/:id'>` types `params.id` as `string`.                                                                                                         |
| `ctx`    | The request context — `req`, cookies, env, middleware variables. Same object `getRequestContext()` returns. Reads only in a page: [writes throw](/docs/api#writes-happen-before-the-render). |

Type `ctx.var` and `ctx.env` for your app by passing its Hono `Env`:

```tsx
export default function Dashboard({ ctx }: PageProps<'/dashboard', AppEnv>) {
  const session = ctx.cookies.get('session');
  if (!session) redirect('/login');
  return <Layout>Signed in as {session}</Layout>;
}
```

Nested server components and `'use server'` actions get no props — they call `getRequestContext()` from
`@rshono/core/server` for the same object. There, `ctx.params` stands in for the `params` prop and
`ctx.req` for the parsed request:

```tsx
import { getRequestContext } from '@rshono/core/server';

async function Breadcrumb() {
  const ctx = getRequestContext(); // no props down here
  return (
    <nav>
      {ctx.params.id} · {ctx.req.method}
    </nav>
  );
}
```

### A page can read `ctx`, not write to it

`ctx.cookies.set()`, `ctx.cookies.delete()` and `ctx.setHeader()` **throw inside a page**. A page
streams, so its response head is committed before the component runs — a cookie set here would arrive
on a full page load and silently vanish on a soft navigation. Write it from a
[server action](#cookies-and-headers) or from
[middleware](/docs/hono#response-headers-and-cookies), both of which run first.

Hono's response builders are the same story, and say so: `ctx.redirect()`, `ctx.notFound()`, `ctx.json()`
and friends throw with a pointer to the API that works — `redirect()` and `notFound()` from
`@rshono/core/server`, or an [endpoint route](/docs/routing#endpoint-routes) for a non-HTML response.
`ctx.hono` is the full Hono `Context` for the long tail, and going through it bypasses the error rather
than fixing it.

### `ctx` cannot cross into the client

`ctx` wraps the live request and response, so it is non-enumerable and never reaches the browser.

- Passing it explicitly (`<Counter ctx={ctx} />`) fails the render with React's _"Only plain objects …
  can be passed to Client Components"_.
- Spreading page props (`<Counter {...props} />`) drops it silently — a spread copies enumerables only.
  That spread still fails, on `url`, which is enumerable and just as unserializable.

Read what you need on the server and pass plain values down: `url.href`, not `url`.

On a [prerendered page](/docs/routing#static-rendering) reading `ctx` throws — there is no request.

## Client components

A `'use client'` module is the interactive part, and `useNavigation()` is the whole client-side routing
API:

```tsx
'use client';
import { useNavigation } from '@rshono/core/client';

export function NextPage() {
  const { url, router } = useNavigation();
  const page = Number(url.searchParams.get('page') ?? '1');
  return (
    <button disabled={router.pending} onClick={() => router.push(`${url.pathname}?page=${page + 1}`)}>
      Next
    </button>
  );
}
```

`url` and `params` are the same names and types a page gets as props, so moving a read across the
server/client line is a copy-paste. `router` holds `push`, `replace`, `refresh` and `pending`; all three
are soft navigations, so client state outside the changed subtree survives. History traversal is
`history.back()` / `history.forward()`.

`<AsyncBoundary>` pairs a Suspense fallback with an error fallback, and `<CatchBoundary>` is the error
half alone. Both are `'use client'` modules a server component can render directly. A `redirect()` is
never absorbed by either — it is navigation, not failure.

## Server actions

A `'use server'` module exports functions a client component can call directly, with typed arguments and
result:

```ts
'use server';

export async function createUser(data: { name: string; email: string }) {
  // runs on the server, always
}
```

There is no route handler in between, and no client bundle carries the body — only a reference to it.
[Usage](/docs/usage) covers wiring them into components with `useActionState`, `useTransition` and
`useOptimistic`; what follows is what an action _is_ on this side of the wire.

### Progressive enhancement

A `<form action={createUser}>` posts **before hydration and with JavaScript disabled**. The client
runtime upgrades it to a fetch once loaded; until then the browser's own form post does the job.

Every action response carries a fresh page payload, so server-rendered UI updates after a mutation with
no refetch and no cache invalidation call.

### Cookies and headers

An action runs **before** the page it re-renders, which is what makes it the place to write to the
response — [the rule above](#a-page-can-read-ctx-not-write-to-it) is the other side of the same coin:

```ts
'use server';
import { getRequestContext, redirect } from '@rshono/core/server';

export async function login(form: FormData) {
  const ctx = getRequestContext();
  ctx.cookies.set('session', await createSession(form), { httpOnly: true, sameSite: 'Lax', path: '/' });
  redirect('/dashboard');
}

export async function logout() {
  const ctx = getRequestContext();
  ctx.cookies.delete('session', { path: '/' });
  ctx.setHeader('clear-site-data', '"cache", "storage"');
  redirect('/');
}
```

Both survive the `redirect()` — the signal is thrown after the cookie is already on the response.

For headers that belong to a route rather than to a mutation, use
[middleware](/docs/hono#response-headers-and-cookies).

### Every action is a public endpoint

That is the RSC model, not an rshono choice: the client is handed an id for each action and can call it
with whatever arguments it likes. A [CSRF check](/docs/configuration#security-middleware) proves a
request came from your own site; it says nothing about _who_ sent it. Authenticate, authorize and validate
arguments inside the action, exactly as in a route handler.

### Errors

Thrown action errors are logged server-side and **redacted in the production payload** — React sends no
message and no digest. Return values, not throws, for anything the user should see:

```ts
'use server';

export async function createUser(data: FormData) {
  const email = String(data.get('email') ?? '');
  if (!email.includes('@')) return { ok: false, error: 'That email looks wrong.' };
  return { ok: true };
}
```

Errors that do escape reach [`onServerError`](/docs/hono#error-reporting) like everything else the
framework catches.

### Secrets

Actions compile to server references and run only on the server, so they read the real `process.env`.
See [Environment & secrets](/docs/configuration#environment-and-secrets).

## The `'use server-entry'` directive

A technical note, not a step: none of the pages above write this directive, and neither does an app. It
shows up in Rspack's output and in one error message, which is the only reason it is documented here.

Compiled pages carry Rspack's `'use server-entry'`, which hangs the page's own client JS and CSS off its
default export. The framework reads them back as the document's bootstrap scripts and stylesheet links —
per-page code splitting with no asset manifest. The build finds the pages to mark by reading `routes.ts` for
inline `component: () => import('…')` thunks and prepending the directive to exactly the modules they name.
It re-scans on every rebuild, so a route added while the dev server is running needs no restart.

Write the thunk inline and there is nothing to do. A `component` reached some other way — through a variable,
a barrel re-export, a computed specifier — is invisible to that scan, and a module that already opens with a
directive of its own is left untouched; in either case put `'use server-entry'` on the page module's first
line yourself. A page that ends up without it renders into a descriptive error naming the route and both
ways of fixing it.
