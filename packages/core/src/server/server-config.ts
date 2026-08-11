import type { RshonoConfig } from '../config.js';

/**
 * The framework settings the server bundle needs at request time, fully resolved.
 *
 * The value is produced once by {@link resolveServerConfig} from `rshono.config.ts`
 * and compiled into the server bundle as the `__RSHONO_CONFIG__` literal (see
 * `builder/rspack-config.ts`) — there is no runtime env-var interface for these.
 *
 * Only what the *build* decides. The per-request security controls that used to live alongside these
 * — the CSRF check, the CSP, the body cap — are Hono middleware an app registers in `src/server.ts`,
 * where they can be configured per route and per environment instead of once per bundle.
 */
export interface ServerConfig {
  /**
   * `true` when the bundle came from `rshono dev`.
   *
   * Baked in rather than read from `process.env.NODE_ENV` at runtime: it is decided by which command
   * produced the bundle, and a deploy target need not have a `process` to read it from.
   */
  isDev: boolean;
  /** Honour `X-Forwarded-Host` / `-Proto` when resolving the browser-facing URL. Forced on in dev. */
  trustProxy: boolean;
  /**
   * The output directory this bundle was written to, relative to the project root — `dist` for a
   * build, something of its own for `rshono dev` (see `BUILD_OUT_DIR` / `DEV_OUT_DIR`).
   *
   * Carried into the bundle because `deploy/filesystem.ts` locates the static assets and the
   * prerendered pages beside it at runtime, and only the compiler knows which directory it used.
   */
  outDir: string;
}

/**
 * The framework's built-in defaults.
 *
 * `port` and `host` are not config fields at all — they come from `PORT` / `HOST` (or `--port`)
 * wherever the address is resolved, `deploy/node/runtime.ts` for a server bundle and `cli/dev.ts`
 * for the dev server, and this is what both fall back to.
 */
export const SERVER_DEFAULTS = {
  port: 3000,
  host: '0.0.0.0',
} as const;

/**
 * Resolve the user's {@link RshonoConfig} into the {@link ServerConfig} baked into the bundle.
 *
 * `isDev` is a build-time input rather than a config field because it decides one thing the user
 * shouldn't have to: `trustProxy` is forced on under `rshono dev`, where the framework's own proxy
 * is the only way in (it sets the forwarded headers itself and binds to localhost).
 */
export function resolveServerConfig(config: RshonoConfig, { isDev, outDir }: { isDev: boolean; outDir: string }): ServerConfig {
  return {
    isDev,
    trustProxy: isDev || (config.trustProxy ?? false),
    outDir,
  };
}
