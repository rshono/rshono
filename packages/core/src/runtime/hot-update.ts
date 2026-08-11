/**
 * Walking the page from the build it is running to the build the dev server has announced.
 *
 * Its own module, apart from `entry.client.tsx`, because this is the one piece of the dev client
 * with enough decisions in it to be worth testing on its own — and every one of those decisions is
 * about *giving up correctly*. Dev-only: the sole caller sits behind `import.meta.webpackHot`, which
 * a production build replaces with `false`, so nothing here reaches a production bundle.
 */

/** The slice of `import.meta.webpackHot` the walk uses. */
export interface HotRuntime {
  /**
   * Fetches the update manifest for the build the page is running and, with `autoApply`, applies it.
   *
   * Resolves with the updated module ids — or with **null**, which is the case that has to be
   * handled: the manifest 404s, meaning no build followed this one on disk, and the runtime treats
   * that as "nothing to do" rather than an error. Rejects only when an update was found and could
   * not be applied.
   */
  check(autoApply?: boolean): Promise<Array<string | number> | null>;
  status(): string;
}

/** Why the page has to be reloaded rather than patched — `error` only where one was thrown. */
export interface ReloadReason {
  reason: string;
  error?: unknown;
}

/**
 * Advances the page to `targetHash()`, applying one build's worth of updates per round, and reports
 * whether it got there.
 *
 * Both hashes are read through functions rather than passed by value because both move underneath
 * this loop: `currentHash` is the bundler's own (`__webpack_hash__`, which an applied update
 * rewrites), and `targetHash` is the newest build the dev server has announced, which a save landing
 * mid-walk moves further out. Reading them fresh each round is what lets one walk absorb a burst of
 * saves instead of finishing against a target that is already stale.
 *
 * Returns `null` once the page is on the target build, or the reason it cannot get there — every one
 * of which is a reload, because the alternative is a page that silently stops updating:
 *
 * - **An update was already in flight.** `check` may only be called from `idle`.
 * - **`check` rejected.** An update was found and could not be applied — a module that declines
 *   updates, most often, which is the ordinary cost of changing something react-refresh can't patch.
 * - **`check` resolved with null, or applied without moving the hash.** The chain of
 *   `*.hot-update.json` files leading to the target is broken: the manifest for the build this page
 *   is on 404s, which the runtime reports as "no update available" rather than as an error. The
 *   everyday way to get there is restarting the dev server — its first act is to wipe `dist`, so
 *   every update file an already-open tab could ask for is gone. The hash cannot move from there, so
 *   this is the round that must not be retried: without it the walk re-requests the same 404 for as
 *   long as the tab stays open, and the page never picks up another change.
 */
export async function walkHotUpdates(hot: HotRuntime, currentHash: () => string, targetHash: () => string | undefined): Promise<ReloadReason | null> {
  while (targetHash() !== undefined && targetHash() !== currentHash()) {
    if (hot.status() !== 'idle') return { reason: 'a hot update was already in flight' };
    const before = currentHash();
    let applied: Array<string | number> | null;
    try {
      applied = await hot.check(true);
    } catch (error) {
      return { reason: 'a hot update failed to apply', error };
    }
    if (applied === null || currentHash() === before) return { reason: 'this build cannot be applied on top of the page' };
  }
  return null;
}
