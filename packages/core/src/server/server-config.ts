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
  /**
   * Whether this target's platform supplies per-request bindings as the second argument to
   * `app.fetch(request, env)`. Baked in because only the build knows which preset was selected, and
   * `getRequestContext().env` has to know: see `DeployPreset.envBindings`, which decides it.
   */
  envBindings: boolean;
}

/**
 * The framework's built-in defaults. `port` and `host` are not config fields — they come from `PORT` / `HOST`
 * or `--port` wherever the address is resolved, and this is what those fall back to.
 */
export const SERVER_DEFAULTS = {
  port: 3000,
  host: '0.0.0.0',
} as const;

/** The highest port a TCP listener can bind. `0` is the lowest, and means "any free port". */
const MAX_PORT = 65535;

/**
 * Reads a port out of `--port` or `PORT`, so both are read the same way wherever the address is resolved.
 *
 * A blank value is `undefined` — "unset", falling through to {@link SERVER_DEFAULTS}. An empty `PORT` is
 * common in CI images and container templates, and the other reading of it is a silent failure: `Number('')`
 * is `0`, which binds a random free port and then reports success.
 *
 * @param source how to name the value in the error — the flag or the variable it came from.
 * @throws RangeError for anything present that is not a port, rather than letting `NaN` reach Node as a raw
 *   `ERR_SOCKET_BAD_PORT` with a bundler frame in the stack.
 */
export function parsePort(value: string | undefined, source: string): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  // Digits only: `Number` alone would also accept `0x50`, `1e3`, `+80` and `3.0`, none of which anyone
  // typed meaning the port they would get.
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isNaN(port) || port > MAX_PORT) {
    throw new RangeError(`invalid ${source} ${JSON.stringify(value)} — expected an integer between 0 and ${MAX_PORT}.`);
  }
  return port;
}

/**
 * Resolves the user's config into the {@link ServerConfig} baked into the bundle. `isDev` is a build-time input
 * rather than a config field because it decides one thing the user should not have to: `trustProxy` is forced on
 * under `rshono dev`, where the framework's own localhost proxy is the only way in.
 */
export function resolveServerConfig(
  config: RshonoConfig,
  { isDev, outDir, envBindings = false }: { isDev: boolean; outDir: string; envBindings?: boolean },
): ServerConfig {
  return {
    isDev,
    trustProxy: isDev || (config.trustProxy ?? false),
    outDir,
    envBindings,
  };
}
