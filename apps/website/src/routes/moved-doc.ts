import type { Handler } from 'hono';

export const handler: Handler = (c) => c.redirect('/docs/pages#server-actions', 301);
