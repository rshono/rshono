# <img src="../../logo.svg" alt="" width="26" height="26" align="top" /> Testbed

Test app for `packages/core` — exercises every framework feature. The core suites build and serve
this app (`test/helpers.mjs`, `playwright.config.mjs`), so it carries deliberate failure routes and
is not a starting point for your own app — `npx @rshono/create@latest` generates that.

| Route               | Demonstrates                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| `/`                 | Route index of every page + `'use client'` counter island, PUBLIC\_ env inlining     |
| `/users`            | Async server component reading the `db` module directly + direct server action call  |
| `/signup`           | `useActionState` form action with progressive enhancement (works without JS)         |
| `/profile/:id`      | Typed route params (`PageProps<'/profile/:id'>`)                                     |
| `/whoami`           | `getRequestContext()` inside a nested async server component (headers, cookies, env) |
| `/docs/:slug`       | `render: 'static'` — prerendered at build time via `staticPaths`                     |
| `/api/quick-health` | `type: 'endpoint'` route with a Hono handler in a server module (`health.ts`)        |
| `/api/*`            | Hono sub-app (`src/server.ts`) mounted at `/`                                        |

```bash
pnpm dev     # http://localhost:3000
pnpm build
pnpm start
```

`.env` holds `DATABASE_URL` (secret — never reaches the browser) and `PUBLIC_API_ENDPOINT` (inlined into the client bundle).
