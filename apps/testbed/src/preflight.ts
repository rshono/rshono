import type { Handler } from 'hono';

/**
 * A CORS preflight answer — the realistic reason an endpoint route names `method: 'options'`.
 *
 * A page route answers `GET`, `POST` and the `HEAD` that rides the `GET`, and nothing else, so an `OPTIONS`
 * is one of the methods only an endpoint can answer. A client-initiated server action from another origin
 * needs this one answered before the browser will send the action at all — see SECURITY.md.
 */
export const handler: Handler = (c) =>
  c.body(null, 204, {
    'access-control-allow-origin': c.req.header('origin') ?? '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-rsc-action, rsc',
  });
