/**
 * The framework config resolved from `rshono.config.ts` and inlined into the server bundle by DefinePlugin.
 *
 * Its own file, apart from the bundler-internal globals, because `runtime/context.ts` references it
 * directly — so `tsc` works in an app importing `@rshono/core/server` without webpack's globals leaking
 * into that app's global scope.
 */
declare const __RSHONO_CONFIG__: import('../server/server-config.js').ServerConfig;
