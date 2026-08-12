/**
 * Walking the page from the build it is running to the build the dev server has announced. Its own module
 * because every decision in it is about *giving up correctly*, which is worth testing on its own.
 *
 * Dev-only: the sole caller sits behind `import.meta.webpackHot`, which a production build replaces with
 * `false`.
 */

/** The slice of `import.meta.webpackHot` the walk uses. */
export interface HotRuntime {
  /**
   * Fetches the update manifest for the build the page is running and, with `autoApply`, applies it.
   *
   * Resolves with the updated module ids, or with **null** when the manifest 404s — which the runtime
   * treats as "nothing to do" rather than an error. Rejects only when an update was found and could not be
   * applied.
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
 * Advances the page to `targetHash()`, applying one build's worth of updates per round, and reports whether
 * it got there.
 *
 * Both hashes are read through functions because both move underneath this loop: an applied update rewrites
 * `__webpack_hash__`, and a save landing mid-walk moves the target further out. Reading them fresh each
 * round is what lets one walk absorb a burst of saves.
 *
 * Returns `null` once the page is on the target build, or the reason it cannot get there — every one of
 * which is a reload, because the alternative is a page that silently stops updating:
 *
 * - **An update was already in flight.** `check` may only be called from `idle`.
 * - **`check` rejected.** An update was found and could not be applied — usually a module that declines
 *   them, which is the ordinary cost of changing something react-refresh cannot patch.
 * - **`check` resolved with null, or applied without moving the hash.** The chain of `*.hot-update.json`
 *   files leading to the target is broken — as it is after a dev-server restart, whose first act is to wipe
 *   the output directory an already-open tab would ask for. The hash cannot move from there, so retrying
 *   would re-request the same 404 for as long as the tab stays open.
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
