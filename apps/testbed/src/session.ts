import type { Handler } from 'hono';

/**
 * A two-method endpoint — `method: ['get', 'delete']` in routes.ts.
 *
 * One handler for both, which is what a list of methods is for: without it this would have to be
 * `method: 'all'` plus a hand-rolled method check, and every other method would reach it.
 */
export const handler: Handler = (c) => c.json({ method: c.req.method });
