// Hand-written declarations for `react-server-dom-rspack` and the manifest global its Rspack plugins inject.
// Narrowed to what the framework calls: the package is pre-1.0, so anything declared here that nothing
// uses would be an unverified guess about an API that moves underneath us.

declare const __rspack_rsc_manifest__: {
  serverManifest: Record<string, { id: string; name: string; chunks: string[]; async?: boolean }>;
};

/**
 * The runtime-agnostic server entry. The package resolves it to a per-runtime build through export
 * conditions (`node`, `workerd`, `deno`, `edge-light`), all of which expose this same surface, so the
 * deploy target decides which one lands in the bundle rather than the specifier.
 */
declare module 'react-server-dom-rspack/server' {
  import type { ReactFormState } from 'react-dom/client';

  export type TemporaryReferenceSet = WeakMap<any, string>;
  export type ServerManifest = Record<string, { id: string; name: string; chunks: string[]; async?: boolean }>;

  export type ServerEntry<T> = T & {
    entryJsFiles?: string[];
    entryCssFiles?: string[];
  };

  export function renderToReadableStream(
    model: unknown,
    options?: {
      temporaryReferences?: TemporaryReferenceSet;
      onError?: (error: unknown) => void;
      signal?: AbortSignal;
    },
  ): ReadableStream<Uint8Array>;

  export function createTemporaryReferenceSet(): TemporaryReferenceSet;

  export function decodeReply<T = unknown[]>(body: string | FormData, options?: { temporaryReferences?: TemporaryReferenceSet }): Promise<T>;

  export function loadServerAction(actionId: string): (...args: unknown[]) => Promise<unknown>;

  export function decodeAction(body: FormData, serverManifest: ServerManifest): Promise<() => Promise<unknown>> | null;

  export function decodeFormState(actionResult: unknown, body: FormData, serverManifest: ServerManifest): Promise<ReactFormState | null>;
}

declare module 'react-server-dom-rspack/client' {
  export function createFromReadableStream<T>(stream: ReadableStream<Uint8Array>, options?: { nonce?: string }): Promise<T>;
}

declare module 'react-server-dom-rspack/client.browser' {
  export type TemporaryReferenceSet = Map<string, unknown>;

  export function createFromReadableStream<T>(
    stream: ReadableStream<Uint8Array>,
    options?: { temporaryReferences?: TemporaryReferenceSet },
  ): Promise<T>;

  export function createFromFetch<T>(promiseForResponse: Promise<Response>, options?: { temporaryReferences?: TemporaryReferenceSet }): Promise<T>;

  export function createTemporaryReferenceSet(): TemporaryReferenceSet;

  export function encodeReply(value: unknown, options?: { temporaryReferences?: TemporaryReferenceSet }): Promise<string | FormData>;

  export function setServerCallback(callback: (id: string, args: unknown[]) => Promise<unknown>): void;
}
