---
title: Project layout
description: The two files the framework knows about — everything else is yours to arrange.
---

```
rshono.config.ts   optional — every field has a default
public/            optional — served verbatim at the web root
src/
  routes.ts        required — the route table
  server.ts        optional — a Hono sub-app mounted ahead of the page routes
  …                everything else is yours to arrange
```

Only those two files under `src/` mean anything to the framework. No convention is attached to any other
name or directory: no `pages/`, no `app/`, no `*.server.ts`. Arrange `src/` by domain, by feature, by
team — routes are one explicit array, so moving a page is an edit to one line.

## Path aliases

`@/…` resolves to `src/…` in both compilers. Tell TypeScript the same thing — relative, and with no
`baseUrl`, which TypeScript 7 removed:

```json
{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
```

## What the build produces

| Output                 | Contents                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `dist/static`          | Hydration runtime, `'use client'` chunks, CSS. Served under `/_static`, cached immutably.       |
| `dist/server/main.mjs` | The app server, self-contained.                                                                 |
| Prerendered pages      | A document and a flight payload per [`render: 'static'`](/docs/routing#static-rendering) route. |
| A copy of `public/`    | So a deployed build needs nothing beside it.                                                    |

Where those land, and what the entry's default export looks like, depends on the
[deploy target](/docs/deployment).
