import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RshonoConfig } from '../config.js';

const CONFIG_FILES = ['rshono.config.ts', 'rshono.config.js', 'rshono.config.mjs'];

/**
 * Imports the config module. A `.ts` config needs no loader: Node strips types natively from 22.18 on, which is
 * what the package's `engines` floor is for.
 *
 * The one thing native stripping will not do is resolve a `.js` specifier to a `.ts` file, so a config
 * importing a sibling has to name it with its real extension — {@link loadConfig} turns that resolution failure
 * into the advice rather than letting a raw `ERR_MODULE_NOT_FOUND` out.
 */
function importConfig(file: string): Promise<{ default?: RshonoConfig }> {
  return import(pathToFileURL(file).href) as Promise<{ default?: RshonoConfig }>;
}

/**
 * Loads the project config, or `{}` if there is none: scans `rshono.config.{ts,js,mjs}` at `rootDir`, unless an
 * explicit `configPath` is given (resolved relative to `cwd`).
 */
export async function loadConfig(rootDir: string, configPath?: string): Promise<RshonoConfig> {
  const file = configPath
    ? isAbsolute(configPath)
      ? configPath
      : resolve(process.cwd(), configPath)
    : CONFIG_FILES.map((f) => join(rootDir, f)).find(existsSync);
  if (!file) return {};
  if (!existsSync(file)) {
    throw new Error(`[rshono] config file not found: ${file}`);
  }
  let mod: { default?: RshonoConfig };
  try {
    mod = await importConfig(file);
  } catch (error) {
    // The one failure mode native type stripping has that a TypeScript-aware loader does not.
    if (/\.[cm]?ts$/.test(file) && (error as { code?: string } | null)?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        `[rshono] ${file} imports a module Node could not resolve: ${(error as Error).message}\n` +
          '  A .ts config is loaded by Node itself, which does not rewrite a .js specifier to the .ts file ' +
          'beside it. Import it by its real extension, or move the config to rshono.config.mjs.',
        { cause: error },
      );
    }
    throw error;
  }
  if (!mod.default) {
    throw new Error(`[rshono] ${file} must \`export default\` a config object (use \`defineConfig({ … })\`).`);
  }
  return mod.default;
}
