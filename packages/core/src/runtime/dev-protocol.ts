/**
 * The messages the dev server pushes over the `/_rshono/hmr` SSE channel — one closed union shared by the
 * producer (`cli/dev.ts`) and the consumer (`runtime/entry.client.tsx`), so the wire protocol cannot drift.
 *
 * - `hello` — sent on (re)connect with the latest build hash; a mismatch means events were missed.
 * - `client-built` — the client bundle rebuilt; the client hot-applies the update.
 * - `rsc-update` — server component code changed; the client re-fetches the flight payload in place.
 */
export type DevMessage = { type: 'hello'; hash?: string } | { type: 'client-built'; hash: string } | { type: 'rsc-update' };
