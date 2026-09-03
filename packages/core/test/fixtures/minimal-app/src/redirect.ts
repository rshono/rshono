import type { Handler } from 'hono';

/**
 * An endpoint that hands back a `Response` it did not build — the one shape the framework's response floor
 * has to decorate without owning. `Response.redirect()` here because a test has to run offline; every
 * `fetch()` result is the same thing, and proxying an upstream verbatim is the commonest thing a Worker does.
 *
 * The header bag of either is guarded `immutable`, so writing to it throws. This app has no `src/server.ts`,
 * which is what makes it the app that could see it: middleware of the app's own unwinds before the floor
 * does, so it gets first crack at the bag — and repairs it, or throws in the floor's place.
 */
export const handler: Handler = (c) => Response.redirect(new URL('/', c.req.url).href, 302);
