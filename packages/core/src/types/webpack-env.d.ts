interface ImportMeta {
  webpackHot?: {
    /**
     * Fetches the update manifest for the build the page is running and, with `autoApply`, applies it.
     * Resolves with the updated module ids, or with `null` when the manifest 404s. See `hot-update.ts`.
     */
    check(autoApply?: boolean): Promise<Array<string | number> | null>;
    status(): string;
  };
}

declare const __webpack_hash__: string;

declare var __webpack_nonce__: string | undefined;
