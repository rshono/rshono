/**
 * The `process.env` view compiled into the browser bundle: `NODE_ENV` plus the `PUBLIC_`-prefixed variables.
 * A stray read of anything else in client code becomes `undefined` rather than shipping the value.
 *
 * Also what `env-shadow-loader.cjs` shadows SSR-layer modules with, so the server renders what the browser
 * hydrates.
 */
export function publicEnv(isDev: boolean): Record<string, string> {
  const entries = Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].startsWith('PUBLIC_') && entry[1] !== undefined);
  return { NODE_ENV: isDev ? 'development' : 'production', ...Object.fromEntries(entries) };
}
