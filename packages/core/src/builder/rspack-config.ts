import { rspack, type Compiler, type RspackOptions, type RuleSetRule } from '@rspack/core';
import { ReactRefreshRspackPlugin } from '@rspack/plugin-react-refresh';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, win32 } from 'node:path';
import type { RshonoConfig } from '../config.js';
import type { DeployPreset } from '../deploy/presets.js';
import { resolveServerConfig } from '../server/server-config.js';
import { scanPageFiles } from './page-files.js';
import { publicEnv } from './public-env.js';

// The framework's own compiled output (this file lives in `dist/builder/`), which is what the two
// compilers consume: the entries and loaders below are the *built* framework, not its TypeScript.
const FRAMEWORK_DIST = join(import.meta.dirname, '..');
const FRAMEWORK_ROOT = join(FRAMEWORK_DIST, '..');

const BUNDLED_PACKAGES = /^(@rshono\/core|react|react-dom|react-server-dom-rspack|hono|@hono\/node-server)(\/|$)/;

/**
 * The directory a command writes its bundles to, relative to the project root — one per command,
 * never shared.
 *
 * `rshono build` run while `rshono dev` is up would otherwise write over the dev server's own
 * output: the build's `clean` empties `<out>/server`, and the route chunks it deletes are exactly
 * the ones the running server worker imports *lazily, at request time*. Every route the worker had
 * not already loaded then fails with `ERR_MODULE_NOT_FOUND`, and no later edit repairs it, because
 * Rspack's watch-mode emit compares against what it believes it already wrote rather than against
 * the disk — so it never re-emits the deleted files. The dev server 500s until it is restarted.
 *
 * Both names are a single level under the root, which {@link ../deploy/filesystem.ts} relies on: it
 * derives the project root from where the bundle ended up, `<out>/server/main.mjs` → `../..`.
 */
export const BUILD_OUT_DIR = 'dist';
export const DEV_OUT_DIR = '.rshono';

/**
 * Packages that end up imported *by app source* without the app ever mentioning them: the RSC
 * transform rewrites a `'use client'` module, a page or a server action into imports of the RSC
 * runtime, and those requests resolve from the app's own `src/`.
 */
const INJECTED_PACKAGES = ['react-server-dom-rspack'];

/** The `node_modules` directory a resolved file sits in — `…/node_modules/pkg/index.js` → `…/node_modules`. */
function enclosingNodeModules(file: string): string | undefined {
  let dir = dirname(file);
  while (basename(dir) !== 'node_modules') {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return dir;
}

/**
 * Where packages are resolved from: the app's own `node_modules`, then the framework's.
 *
 * The second part is what makes {@link INJECTED_PACKAGES} resolvable from app source. npm, yarn and
 * bun hoist the framework's dependencies into the app's own `node_modules`; pnpm installs them as
 * *siblings* of `@rshono/core` where nothing under the app's tree can see them, and the build then
 * fails with `Can't resolve 'react-server-dom-rspack/client'` in a file the user never wrote that
 * import into.
 *
 * Asking Node where the framework itself resolves the package finds the directory in any layout, and
 * a search path rather than an alias keeps the package's own `exports` conditions in play — the RSC
 * layer, the SSR layer and each deploy target need a different build of it.
 */
function resolveModules(): string[] {
  const require = createRequire(import.meta.url);
  const dirs = new Set<string>();
  for (const name of INJECTED_PACKAGES) {
    try {
      const dir = enclosingNodeModules(require.resolve(name));
      if (dir) dirs.add(dir);
    } catch {
      // Left to the resolver to report against the request that actually needed it.
    }
  }
  // A checkout or a vendored copy, where the framework has real dependencies of its own and the lookup
  // above found nothing to add.
  dirs.add(join(FRAMEWORK_ROOT, 'node_modules'));
  return ['node_modules', ...dirs];
}

/**
 * Whether a request names a file rather than a package, and so belongs in the bundle.
 *
 * Rspack's RSC plugins ask for their client and server-entry proxies by *absolute path*, which on
 * Windows means a drive letter (`D:\app\src\home.tsx`) instead of a leading slash. Externalizing one
 * of those emits `import("D:\\app\\src\\home.tsx")`, which Node rejects with
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`. `win32.isAbsolute` also accepts the POSIX form, so it is used on
 * every platform — one code path, and the Windows shapes stay testable off Windows.
 */
function isPathRequest(request: string): boolean {
  return request.startsWith('.') || win32.isAbsolute(request);
}

const BROWSER_TARGETS = ['last 2 versions', '> 0.2%', 'not dead', 'Firefox ESR'];
const NODE_TARGETS = ['node >= 22'];

/**
 * Rspack's native CSS pipeline, which both compilers get.
 *
 * It parses *finished* CSS, so a stylesheet needing a PostCSS plugin — Tailwind, most obviously —
 * adds the loader through the {@link RshonoConfig.rspack} hook, along with the packages a PostCSS
 * pass takes. `postcss` is then a dependency of the apps that want one rather than of every app.
 *
 * A fresh object per compiler, so an app that reaches in to change this rule does not find it has
 * changed the other bundle's too.
 */
function cssRule(): RuleSetRule {
  return { test: /\.css$/i, type: 'css/auto' };
}

export interface RspackConfigOptions {
  rootDir: string;
  isDev: boolean;
  /** The project's resolved config — supplies the {@link RshonoConfig.rspack} hook and the runtime settings baked into the server bundle. */
  config: RshonoConfig;
  /** The platform being built for: decides the `@rshono/deploy` runtime and any server-compiler overrides. */
  preset: DeployPreset;
  onServerComponentChanges?: () => void;
}

export function createConfigs(options: RspackConfigOptions): [RspackOptions, RspackOptions] {
  const { rootDir, isDev, config, preset, onServerComponentChanges } = options;
  const srcDir = join(rootDir, 'src');
  const mode = isDev ? 'development' : 'production';
  const outDir = isDev ? DEV_OUT_DIR : BUILD_OUT_DIR;

  const routesFile = ['routes.ts', 'routes.tsx'].map((f) => join(srcDir, f)).find(existsSync);
  if (!routesFile) {
    throw new Error(`[rshono] src/routes.ts not found in ${rootDir} — it is the one required file.`);
  }
  const serverAppFile = ['server.ts', 'server.tsx'].map((f) => join(srcDir, f)).find(existsSync);
  const serverAppAlias = serverAppFile ?? join(FRAMEWORK_DIST, 'runtime', 'empty-server-app.js');

  const rscEntry = join(FRAMEWORK_DIST, 'runtime', 'entry.rsc.js');
  const ssrEntry = join(FRAMEWORK_DIST, 'runtime', 'entry.ssr.js');
  const clientEntry = join(FRAMEWORK_DIST, 'runtime', 'entry.client.js');

  const swcRule = (targets: string[]): RuleSetRule => ({
    test: /\.[cm]?[jt]sx?$/,
    exclude: /[\\/]core-js[\\/]/,
    use: {
      loader: 'builtin:swc-loader',
      options: {
        detectSyntax: 'auto',
        jsc: {
          transform: { react: { runtime: 'automatic', development: isDev } },
          experimental: { keepImportAttributes: true },
        },
        env: { targets },
        rspackExperiments: { reactServerComponents: true },
      },
    },
    type: 'javascript/auto',
  });

  const resolveBase = {
    extensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    modules: resolveModules(),
  };

  // The platform's own resolve conditions, ahead of whatever the Rspack target implies ('...'). This
  // is what hands the server bundle the right build of React and the RSC runtime, both of which ship
  // one per runtime. Left unset for Node, where the target already implies the `node` condition.
  const runtimeConditions = preset.resolveConditions ?? [];
  const serverResolveBase = runtimeConditions.length > 0 ? { ...resolveBase, conditionNames: [...runtimeConditions, '...'] } : resolveBase;
  const rscConditionNames = ['react-server', ...runtimeConditions, '...'];

  const { ServerPlugin, ClientPlugin } = rspack.experiments.rsc.createPlugins();
  const { Layers } = rspack.experiments.rsc;

  const pageFiles = new Set<string>();
  scanPageFiles(routesFile, srcDir, pageFiles);
  const pageScanPlugin = {
    apply(compiler: Compiler) {
      const refresh = () => scanPageFiles(routesFile, srcDir, pageFiles);
      compiler.hooks.beforeRun.tap('rshono/page-scan', refresh);
      compiler.hooks.watchRun.tap('rshono/page-scan', refresh);
    },
  };

  const clientConfig: RspackOptions = {
    name: 'client',
    mode,
    target: 'web',
    context: rootDir,
    devtool: isDev ? 'source-map' : false,
    entry: { main: clientEntry },
    output: {
      path: join(rootDir, outDir, 'static'),
      publicPath: '/_static/',
      clean: !isDev,
      filename: isDev ? 'chunks/main.js' : 'chunks/main.[contenthash].js',
      chunkFilename: isDev ? 'chunks/[name].js' : 'chunks/[name].[contenthash].js',
      cssFilename: isDev ? 'chunks/[name].css' : 'chunks/[name].[contenthash].css',
      cssChunkFilename: isDev ? 'chunks/[name].css' : 'chunks/[name].[contenthash].css',
      assetModuleFilename: 'assets/[name].[hash][ext]',
    },
    optimization: {
      moduleIds: isDev ? 'named' : 'hashed',
    },
    resolve: {
      ...resolveBase,
      alias: { '@': srcDir },
    },
    module: {
      rules: [swcRule(BROWSER_TARGETS), cssRule(), { test: /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf)$/i, type: 'asset' }],
    },
    plugins: [
      new ClientPlugin(),
      new rspack.DefinePlugin({ 'process.env': JSON.stringify(publicEnv(isDev)) }),
      ...(isDev ? [new rspack.HotModuleReplacementPlugin(), new ReactRefreshRspackPlugin()] : []),
    ],
    performance: false,
  };

  const serverConfig: RspackOptions = {
    name: 'server',
    mode,
    target: 'node',
    context: rootDir,
    devtool: isDev ? 'source-map' : false,
    entry: { main: rscEntry },
    output: {
      path: join(rootDir, outDir, 'server'),
      // Off in dev, matching the client compiler above. The server bundle's route chunks are imported
      // lazily, at request time, so the worker keeps reading this directory for as long as it runs —
      // and a rebuild that renames or drops a chunk (renaming a page file is enough) would delete one
      // the live worker still intends to import. Stale chunks are inert instead: nothing references
      // them, and `rshono dev` empties the directory on startup.
      clean: !isDev,
      module: true,
      chunkFormat: 'module',
      chunkLoading: 'import',
      library: { type: 'module' },
      filename: 'main.mjs',
      chunkFilename: 'chunks/[name].mjs',
      publicPath: '/_static/',
      assetModuleFilename: 'assets/[name].[hash][ext]',
    },
    optimization: {
      minimize: isDev ? false : true,
    },
    externalsType: 'module-import',
    externals: [
      ({ request }, callback) => {
        if (
          !request ||
          isPathRequest(request) ||
          request.startsWith('@/') ||
          request.startsWith('@rshono/') ||
          request.startsWith('builtin:') ||
          request.includes('!') ||
          BUNDLED_PACKAGES.test(request)
        ) {
          return callback();
        }
        callback(undefined, `module-import ${request}`);
      },
    ],
    resolve: {
      ...serverResolveBase,
      alias: {
        '@rshono/routes$': routesFile,
        '@rshono/server-app$': serverAppAlias,
        // The one import that decides which platform the server bundle is for. Split on '/' so the
        // preset can declare a POSIX-looking path and still resolve on Windows.
        '@rshono/deploy$': join(FRAMEWORK_DIST, ...preset.runtimeModule.split('/')),
        '@': srcDir,
      },
    },
    module: {
      rules: [
        {
          test: (resource: string) => pageFiles.has(resource),
          enforce: 'pre',
          use: [{ loader: join(FRAMEWORK_DIST, 'builder', 'page-entry-loader.cjs') }],
        },
        {
          test: /\.[cm]?[tj]sx?$/,
          include: srcDir,
          enforce: 'pre',
          use: [
            {
              loader: join(FRAMEWORK_DIST, 'builder', 'env-shadow-loader.cjs'),
              options: { prelude: `const process = { env: ${JSON.stringify(publicEnv(isDev))} }; `, layer: Layers.ssr },
            },
          ],
        },
        swcRule([...(preset.syntaxTargets ?? NODE_TARGETS)]),
        cssRule(),
        {
          test: /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf)$/i,
          type: 'asset',
          generator: { emit: false },
        },
        { resource: ssrEntry, layer: Layers.ssr },
        {
          resource: rscEntry,
          layer: Layers.rsc,
          resolve: { conditionNames: rscConditionNames },
        },
        {
          issuerLayer: Layers.rsc,
          exclude: ssrEntry,
          resolve: { conditionNames: rscConditionNames },
        },
      ],
    },
    plugins: [
      pageScanPlugin,
      new ServerPlugin({ onServerComponentChanges }),
      // Bakes rshono.config.ts into the bundle, read back as `__RSHONO_CONFIG__` at request time.
      new rspack.DefinePlugin({ __RSHONO_CONFIG__: JSON.stringify(resolveServerConfig(config, { isDev, outDir })) }),
    ],
    performance: false,
  };

  // The platform's own overrides, then the user's hook — so an app can still adjust whatever a
  // preset decided.
  preset.configureServer?.(serverConfig);

  const rspackHook = config.rspack;
  if (rspackHook) {
    return [
      rspackHook(clientConfig, { isServer: false, isDev }) ?? clientConfig,
      rspackHook(serverConfig, { isServer: true, isDev }) ?? serverConfig,
    ];
  }
  return [clientConfig, serverConfig];
}
