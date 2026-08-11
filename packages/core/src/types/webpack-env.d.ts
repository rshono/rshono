interface ImportMeta {
  webpackHot?: {
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
  };
}

declare const __webpack_hash__: string;

declare var __webpack_nonce__: string | undefined;
