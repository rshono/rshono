/**
 * The one import mistake the client compiler could not explain: `@rshono/core/server` reached from a
 * `'use client'` module.
 *
 * The entry point is server-only by construction — `getRequestContext()` is an `AsyncLocalStorage` lookup —
 * so the browser bundle cannot have it, and the build is right to fail. What it used to fail *with* was the
 * resolver's own report of the first `node:` builtin three modules down:
 *
 * ```
 * ERROR in node:async_hooks
 *   × Reading from "node:async_hooks" is not handled by plugins (Unhandled scheme).
 * ```
 *
 * No file path, no issuer, and no mention of rshono or of the import that caused it. Everything else in the
 * framework names the file to open; this was the one common mistake that did not, and the docs warn against it
 * often enough to suggest people make it.
 *
 * So the request is caught before it resolves, where the *issuer* is still known, and reported as itself.
 */
import type { Compiler } from '@rspack/core';
import { relative } from 'node:path';

/** Requests that exist only on the server, and what a browser module should reach for instead. */
const SERVER_ONLY: Record<string, string> = {
  '@rshono/core/server': [
    'It is server-only by construction: `getRequestContext()` reads an AsyncLocalStorage store that exists only while a request is being handled.',
    "In a 'use client' component, read the URL and params with `useNavigation()` from '@rshono/core/client', navigate with the `router` it returns, and take anything else as a prop from the server component that renders this one.",
    "If this module was not meant to be a client component, the 'use client' directive at the top of it — or of a module it imports — is what put it in the browser bundle.",
  ].join('\n'),
};

/**
 * Reports a server-only import by naming the module that made it.
 *
 * Two halves, because the resolver and the error list are reachable at different times. `beforeResolve` is
 * where `contextInfo.issuer` is still on the request, and returning `false` there drops the dependency — which
 * is what keeps the raw `node:` scheme error from being the build's only output. The error itself is pushed
 * once the compilation exists to hold it, so it prints as an error against the compilation rather than as a
 * throw out of a resolver hook.
 */
export function serverOnlyImportPlugin(rootDir: string): { apply(compiler: Compiler): void } {
  const NAME = 'rshono/server-only-imports';
  return {
    apply(compiler: Compiler): void {
      /** Issuer → the request it made. A Map, so one module importing the same thing twice is reported once. */
      const offenders = new Map<string, string>();

      compiler.hooks.normalModuleFactory.tap(NAME, (factory) => {
        factory.hooks.beforeResolve.tap(NAME, (data) => {
          // `hasOwn`, not `in`: a module named `toString` would otherwise inherit a match from Object.prototype.
          if (!Object.hasOwn(SERVER_ONLY, data.request)) return;
          offenders.set(data.contextInfo?.issuer ?? '', data.request);
          // Dropped rather than left to fail: the resolver's report would name a `node:` builtin the author
          // never wrote, and it would arrive beside this one.
          return false;
        });
      });

      // Cleared per compilation, so a watch rebuild that fixed the import stops reporting it.
      compiler.hooks.thisCompilation.tap(NAME, () => offenders.clear());

      compiler.hooks.afterCompile.tap(NAME, (compilation) => {
        for (const [issuer, request] of offenders) {
          const where = issuer ? relative(rootDir, issuer) : 'a module in the browser bundle';
          // `file` is what Rspack puts on its own "ERROR in …" line, so the path lands where a reader looks
          // for one instead of being the first words of the message.
          compilation.errors.push(
            Object.assign(new Error(`[rshono] ${where} imports '${request}', which the browser bundle cannot have.\n${SERVER_ONLY[request]}`), {
              file: where,
            }),
          );
        }
      });
    },
  };
}
