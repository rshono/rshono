import type { RshonoConfig } from '../config.js';

/**
 * The framework settings the server bundle needs at request time, fully resolved — produced once by
 * {@link resolveServerConfig} and compiled in as the `__RSHONO_CONFIG__` literal. There is no runtime env-var
 * interface for these, and nothing here is a per-request concern: those are Hono middleware in `src/server.ts`.
 */
export interface ServerConfig {
  /**
   * `true` when the bundle came from `rshono dev`. Baked in rather than read from `process.env.NODE_ENV`,
   * because a deploy target need not have a `process`.
   */
  isDev: boolean;
  /** Honour `X-Forwarded-Host` / `-Proto` when resolving the browser-facing URL. Forced on in dev. */
  trustProxy: boolean;
  /**
   * The output directory this bundle was written to, relative to the project root. Carried into the bundle
   * because `deploy/filesystem.ts` locates the assets and prerendered pages beside it at runtime, and only the
   * compiler knows which directory it used.
   */
  outDir: string;
}

/**
 * The framework's built-in defaults. `port` and `host` are not config fields — they come from `PORT` / `HOST`
 * or `--port` wherever the address is resolved, and this is what those fall back to.
 */
export const SERVER_DEFAULTS = {
  port: 3000,
  host: '0.0.0.0',
} as const;

/**
 * Resolves the user's config into the {@link ServerConfig} baked into the bundle. `isDev` is a build-time input
 * rather than a config field because it decides one thing the user should not have to: `trustProxy` is forced on
 * under `rshono dev`, where the framework's own localhost proxy is the only way in.
 */
export function resolveServerConfig(config: RshonoConfig, { isDev, outDir }: { isDev: boolean; outDir: string }): ServerConfig {
  return {
    isDev,
    trustProxy: isDev || (config.trustProxy ?? false),
    outDir,
  };
}
