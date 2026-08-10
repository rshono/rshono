/**
 * The messages the dev server pushes over the `/_rshono/hmr` SSE channel, as a
 * single closed union shared by both ends — the producer (`cli/dev.ts`) and the
 * consumer (`runtime/entry.client.tsx`). Adding a variant here forces both sides
 * to handle it, so the wire protocol can't drift.
 *
 * - `hello` — sent on (re)connect with the latest build hash; a mismatch means
 *   events were missed while disconnected, so the client resyncs.
 * - `client-built` — the client bundle rebuilt; the client hot-applies the update.
 * - `rsc-update` — server component code changed; the client re-fetches the flight
 *   payload for the current URL in place.
 */
export type DevMessage = { type: 'hello'; hash?: string } | { type: 'client-built'; hash: string } | { type: 'rsc-update' };
