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
import { checkReactVersions } from './react-versions.js';

// This file lives in `dist/builder/`, so the entries and loaders below are the *built* framework.
const FRAMEWORK_DIST = join(import.meta.dirname, '..');
const FRAMEWORK_ROOT = join(FRAMEWORK_DIST, '..');

const BUNDLED_PACKAGES = /^(@rshono\/core|react|react-dom|react-server-dom-rspack|hono|@hono\/node-server)(\/|$)/;

/**
 * The directory a command writes its bundles to, relative to the project root — one per command, never
 * shared: a `rshono build` alongside a running `rshono dev` would `clean` away the route chunks that
 * server imports lazily, and Rspack's watch-mode emit never re-emits a file it believes it wrote.
 *
 * Both names are a single level under the root, which `deploy/filesystem.ts` relies on to derive the
 * project root from where the bundle ended up.
 */
export const BUILD_OUT_DIR = 'dist';
export const DEV_OUT_DIR = '.rshono';

/**
 * Packages the app's source ends up importing without ever naming them: the RSC transform rewrites a
 * `'use client'` module, a page or an action into imports of the RSC runtime, resolved from the app's `src/`.
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
 * Where packages are resolved from: the app's own `node_modules`, then the framework's — which is what makes
 * {@link INJECTED_PACKAGES} resolvable from app source under pnpm, where the framework's dependencies are
 * installed as siblings of `@rshono/core` rather than hoisted into the app's tree.
 *
 * Asking Node where the framework resolves the package finds it in any layout, and a search path rather than
 * an alias keeps the package's own `exports` conditions in play — the RSC layer, the SSR layer and each
 * deploy target need a different build of it.
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
  // A checkout or a vendored copy, where the framework has real dependencies of its own.
  dirs.add(join(FRAMEWORK_ROOT, 'node_modules'));
  return ['node_modules', ...dirs];
}

/**
 * Whether a request names a file rather than a package, and so belongs in the bundle.
 *
 * Rspack's RSC plugins ask for their proxies by absolute path, which on Windows carries a drive letter —
 * externalizing one emits an `import("D:\\…")` Node rejects. `win32.isAbsolute` accepts the POSIX form too,
 * so it runs on every platform and the Windows shapes stay testable off Windows.
 */
function isPathRequest(request: string): boolean {
  return request.startsWith('.') || win32.isAbsolute(request);
}

const BROWSER_TARGETS = ['last 2 versions', '> 0.2%', 'not dead', 'Firefox ESR'];
const NODE_TARGETS = ['node >= 22'];

/**
 * Rspack's native CSS pipeline, which both compilers get. It parses *finished* CSS, so a stylesheet needing
 * PostCSS — Tailwind, most obviously — adds that loader through the {@link RshonoConfig.rspack} hook, which
 * keeps `postcss` a dependency of the apps that want one.
 *
 * A fresh object per compiler, so an app changing this rule does not silently change the other bundle's.
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

  // Before anything is compiled: a react/react-dom split fails inside React at render time, and this is the
  // one place that can say so with the two versions in hand.
  checkReactVersions(rootDir);

  const routesFile = ['routes.ts', 'routes.tsx'].map((f) => join(srcDir, f)).find(existsSync);
  if (!routesFile) {
    throw new Error(`[rshono] src/routes.ts not found in ${rootDir} — it is the one required file.`);
  }
  const serverAppFile = ['server.ts', 'server.tsx'].map((f) => join(srcDir, f)).find(existsSync);
  const serverAppAlias = serverAppFile ?? join(FRAMEWORK_DIST, 'runtime', 'empty-server-app.js');
  // Optional, and staying optional — but per-request security is Hono middleware registered there, so an app
  // without one has opted out of all of it, which is worth hearing once rather than discovering. Builds only:
  // `dev` would print it on every rebuild, and it is not news on a developer's machine.
  if (!serverAppFile && !isDev) {
    console.warn(
      '  ⚠ No src/server.ts — this build has no CSRF check and no request body cap. Both are Hono middleware\n' +
        '    (`csrf()`, `bodyLimit()`); `npx @rshono/create` scaffolds a src/server.ts with them registered.',
    );
  }

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

  // Ahead of whatever the Rspack target implies ('...'), which is what hands the server bundle the right
  // build of React and the RSC runtime. Unset for Node, whose target already implies the `node` condition.
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
    // Never in a build: a client map is served from `/_static` like everything else beside it, and it would
    // publish the original source of the app's own modules. Dev binds 127.0.0.1 only.
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
    // In a build too, unlike the client's: the bundle is minified, and without a map every stack trace that
    // reaches `onServerError` — the error-tracker funnel — is unmappable minified frames. A server map is
    // never served to anyone; `dist/server` is not on a public path, and the runtime enables Node's own
    // mapping so no host has to pass a flag.
    devtool: 'source-map',
    entry: { main: rscEntry },
    output: {
      path: join(rootDir, outDir, 'server'),
      // Off in dev: route chunks are imported lazily, so a superseded one on disk is harmless where deleting
      // one mid-request is not. `rshono dev` empties the directory on startup instead.
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
        // Split on '/' so a preset can declare a POSIX-looking path and still resolve on Windows.
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
          // Deliberately not scoped to `srcDir`: a `'use client'` component from `node_modules` is SSR'd in
          // the same layer, and scoping this to the app's own source left those rendering against the real
          // `process.env` while the browser bundle saw the `PUBLIC_`-only view — a hydration mismatch on
          // anything the host sets, and a leak for anything secret. The loader's own layer check is what
          // decides; every other module gets one `includes('process.env')` scan.
          test: /\.[cm]?[tj]sx?$/,
          enforce: 'pre',
          use: [
            {
              loader: join(FRAMEWORK_DIST, 'builder', 'env-shadow-loader.cjs'),
              // `Object.create` over the real `process`, not a bare `{ env }`: the prelude shadows the whole
              // binding for that module, and `react-dom/server` is in this layer too — anything reading
              // `process.nextTick` or `process.platform` has to still find it. Not a `{ __proto__: … }`
              // literal, whose meaning would change if a minifier ever quoted the key.
              options: {
                prelude: `const process = Object.assign(Object.create(globalThis.process ?? Object.prototype), { env: ${JSON.stringify(publicEnv(isDev))} }); `,
                layer: Layers.ssr,
              },
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

  // The platform's overrides first, then the user's hook — so an app can adjust whatever a preset decided.
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
