import type { Handler } from 'hono';

// An endpoint that always throws, to exercise the framework's uncaught-error path: anything that
// escapes a handler reaches Hono's onError, which renders the `error` page from routes.ts as HTML or
// as a flight payload depending on what the client asked for — with the real message redacted in
// production. Nothing here is fit for a real app; it exists so the tests have an honest 500.
export const handler: Handler = (c) => {
  // `?throw=plain` throws something that is not an `Error`, which is the one shape Hono's dispatcher
  // re-throws instead of handing to `onError` — so without the framework's own conversion this answered a
  // bodiless 500 raised outside the app: no error page, nothing reported, not even the baseline security
  // headers. With it, this answers exactly as the `Error` below does.
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- throwing a non-Error is the whole point
  if (c.req.query('throw') === 'plain') throw 'a plain string';
  throw new Error('Intentional endpoint failure');
};
