/**
 * The messages the dev server pushes over the `/_rshono/hmr` SSE channel — one closed union shared by the
 * producer (`cli/dev.ts`) and the consumer (`runtime/entry.client.tsx`), so the wire protocol cannot drift.
 *
 * - `hello` — sent on (re)connect with the latest build hash; a mismatch means events were missed.
 * - `client-built` — the client bundle rebuilt; the client hot-applies the update.
 * - `rsc-update` — server component code changed; the client re-fetches the flight payload in place.
 */
export type DevMessage = { type: 'hello'; hash?: string } | { type: 'client-built'; hash: string } | { type: 'rsc-update' };

/**
 * The messages the dev server sends its own worker thread over `parentPort` — the other direction from the
 * SSE channel above. Shared by `cli/dev.ts` and `deploy/node/runtime.ts` for the same reason.
 *
 * - `shutdown` — drain and stop. Between rebuilds the dev server asks the old worker to close its listener
 *   and exit once the requests it is serving have finished, rather than severing them with `terminate()`.
 */
export type DevWorkerMessage = { type: 'shutdown' };
