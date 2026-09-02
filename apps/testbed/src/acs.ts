import type { Handler } from 'hono';

/**
 * The documented way to receive a cross-site form post: an `{ type: 'endpoint' }` route.
 *
 * A *page* route refuses every one of these — a form post to a page is how a `<form action={serverAction}>`
 * reaches the server, and telling one that carries an action from one that does not would mean buffering an
 * untrusted body first. So the framework refuses on `Sec-Fetch-Site` and the content type, ahead of any app
 * policy. That rules out the arrival shape of a SAML ACS callback, OIDC `response_mode=form_post` and most
 * payment-gateway returns, which is what this stands in for.
 *
 * An endpoint calls its handler directly and never reaches the page renderer, so it never meets that check —
 * and the app owns the verification the check was standing in for. A real one would validate the assertion's
 * signature here before trusting a byte of it.
 */
export const handler: Handler = async (c) => {
  const form = await c.req.formData();
  const assertion = form.get('SAMLResponse');
  if (typeof assertion !== 'string') return c.text('Bad Request: no SAMLResponse', 400);
  return c.json({ received: assertion.length });
};
