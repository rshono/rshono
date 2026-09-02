import type { RspackOptions } from '@rspack/core';
import { finalizeCloudflareBuild } from './cloudflare/build.js';
import type { DeployTarget } from './contract.js';
import { finalizeVercelBuild } from './vercel/build.js';

/** What a preset's {@link DeployPreset.finalize} is told about the build it is arranging. */
export interface DeployBuildContext {
  /** The project root — where `rshono build` ran, and what a platform config file is written next to. */
  rootDir: string;
  /** `<root>/dist`. */
  distDir: string;
  /** The hashed client bundle, `<root>/dist/static` — served at `/_static`. */
  staticDir: string;
  /** The copy of the app's `public/`, or `null` when it has none. Served at the web root. */
  publicDir: string | null;
  /** Prerendered pages, `<root>/dist/ssg` — empty when the app has no `render: 'static'` routes. */
  ssgDir: string;
}

/**
 * The build-time half of a deploy target: which runtime module the bundle gets, how the server compiler has
 * to change to produce something the platform can run, and how the output is arranged once it exists.
 *
 * The runtime half is `DeployRuntime`, in its own file because it is compiled *into* the app bundle — this
 * side only ever runs in the CLI.
 */
export interface DeployPreset {
  readonly name: DeployTarget;
  /**
   * The module `@rshono/deploy` resolves to, as a path relative to the framework's own `dist/`.
   * Slash-separated and split on use, so it stays a valid path on Windows too.
   */
  readonly runtimeModule: string;
  /** How to run what was just built, completing the "build complete —" line. */
  readonly deployHint: string;
  /**
   * `true` where the platform hands per-request bindings to `app.fetch(request, env)` — Workers, and
   * nowhere else. It gates the `getRequestContext().env` merge, because every other target passes its own
   * private handles in that argument (`{ incoming, outgoing }` on Node, the whole invocation on Lambda) and
   * merging those would put a live socket, or a request's headers and cookies, behind a name typed
   * `string | undefined`.
   */
  readonly envBindings?: boolean;
  /**
   * Extra resolve conditions for the server bundle, most specific first — what picks the right build of React
   * and the RSC runtime, both of which ship one per runtime. Omit to accept whatever the Rspack target
   * implies, which is correct for Node.
   */
  readonly resolveConditions?: readonly string[];
  /** browserslist-style targets for the server bundle's swc pass. Defaults to Node. */
  readonly syntaxTargets?: readonly string[];
  /**
   * Adjusts the generated server Rspack config for this platform — target, externals policy, output shape.
   * Mutates in place, and runs before the user's `rspack` hook so that hook keeps the last word.
   */
  configureServer?(config: RspackOptions): void;
  /**
   * Arranges the finished build for the platform: assembles the directory layout it expects, emits its config
   * file, and prints how to deploy. Runs last, so everything it needs to move is already on disk.
   */
  finalize?(ctx: DeployBuildContext): Promise<void> | void;
}

/**
 * Node: a long-lived server process. The generated config is already this shape — `target: 'node'`, the
 * externals policy and ESM chunk output are all defaults — so the preset has nothing to contribute.
 */
export const NODE_PRESET: DeployPreset = {
  name: 'node',
  runtimeModule: 'deploy/node/runtime.js',
  deployHint: 'run `rshono start`',
};

/**
 * Cloudflare Workers: the host owns the process, the CDN owns the assets, and there is no filesystem.
 *
 * Every setting here follows from `workerd` not being Node. Dependencies are bundled because nothing resolves
 * `node_modules` at runtime; `node:` and `cloudflare:` imports stay external because the runtime provides
 * them under `nodejs_compat`; and async chunks are inlined because Wrangler's bundler cannot follow the
 * computed specifier Rspack's ESM chunk loader emits — a split bundle deploys and then fails on first render.
 */
const CLOUDFLARE_PRESET: DeployPreset = {
  name: 'cloudflare',
  runtimeModule: 'deploy/cloudflare/runtime.js',
  deployHint: 'deploy with `wrangler deploy`',
  envBindings: true,
  resolveConditions: ['workerd'],
  syntaxTargets: ['chrome 120'],
  configureServer(config) {
    config.target = 'webworker';
    config.externalsType = 'module-import';
    config.externals = [/^(?:node|cloudflare):/];
    config.output = { ...config.output, asyncChunks: false };
  },
  finalize: finalizeCloudflareBuild,
};

/**
 * Bundles the app's dependencies into the server output instead of importing them from `node_modules`.
 *
 * The generated config externalizes them, which is right where the bundle runs *inside* the project — but a
 * serverless function is uploaded as a directory rather than installed into one, so nothing resolves
 * `node_modules` at request time and an externalized `import 'some-package'` is a cold start that dies on
 * `ERR_MODULE_NOT_FOUND`. Node's own builtins stay external either way, through the `node` externals preset
 * that `target: 'node'` already enables.
 *
 * The cost is a dependency that cannot be bundled — a native addon, or one that reads its own files off disk
 * relative to `__dirname`. Those now fail the build rather than the deploy, which is the same constraint
 * `cloudflare` has always had; the `rspack` hook in `rshono.config.ts` is the way out.
 */
function bundleDependencies(config: RspackOptions): void {
  config.externals = [];
}

/**
 * Vercel: one Node function behind the platform's CDN, which serves the assets and reaches the function only
 * for a page. `finalize` assembles the Build Output API layout the platform uploads — including the
 * `supportsResponseStreaming` flag, without which Vercel buffers the whole response and silently undoes
 * streamed SSR.
 *
 * Only `dist/server` is uploaded with the function, which is why dependencies are bundled: see
 * {@link bundleDependencies}.
 */
const VERCEL_PRESET: DeployPreset = {
  name: 'vercel',
  runtimeModule: 'deploy/vercel/runtime.js',
  deployHint: 'deploy with `vercel deploy --prebuilt`',
  configureServer: bundleDependencies,
  finalize: finalizeVercelBuild,
};

/**
 * AWS Lambda behind a Function URL in `RESPONSE_STREAM` mode — the AWS shape that keeps streaming. The
 * runtime wraps the app in `awslambda.streamifyResponse`; the buffered alternative would deploy fine and then
 * hold every page until its last byte rendered.
 *
 * The deployment package is `dist/` and nothing else, which is why dependencies are bundled: see
 * {@link bundleDependencies}.
 */
const AWS_LAMBDA_PRESET: DeployPreset = {
  name: 'aws-lambda',
  runtimeModule: 'deploy/aws-lambda/runtime.js',
  deployHint: 'zip dist/ with the handler at dist/server/main.mjs',
  configureServer: bundleDependencies,
};

const PRESETS: Record<DeployTarget, DeployPreset> = {
  node: NODE_PRESET,
  cloudflare: CLOUDFLARE_PRESET,
  vercel: VERCEL_PRESET,
  'aws-lambda': AWS_LAMBDA_PRESET,
};

/** Every target `deploy` accepts, for error messages and docs. */
export const DEPLOY_TARGETS = Object.keys(PRESETS) as DeployTarget[];

/**
 * `PRESETS[target]` for a target that really is one.
 *
 * `Object.hasOwn` rather than a bare bracket access, which resolves every `Object.prototype` key —
 * `constructor`, `__proto__`, `toString` — to an inherited value that then passes a truthiness guard. A typo
 * that happens to be one of those used to reach the builder and die on `preset.runtimeModule.split('/')`
 * instead of getting the message written for an unknown target.
 */
function presetFor(target: string): DeployPreset | undefined {
  return Object.hasOwn(PRESETS, target) ? PRESETS[target as DeployTarget] : undefined;
}

/**
 * How to deploy what a given target built, or `null` for a name this rshono does not know — which a `dist/`
 * from a newer version can legitimately carry.
 */
export function deployHintFor(target: string): string | null {
  return presetFor(target)?.deployHint ?? null;
}

/** Where a deploy target can be named, in precedence order. */
export interface DeploySources {
  /** The `--deploy` flag. */
  flag?: string;
  /** The `RSHONO_DEPLOY` env var — for a CI job that deploys the same app to more than one place. */
  env?: string;
  /** The `deploy` field in `rshono.config.ts`. */
  config?: string;
}

/**
 * Resolves the preset to build with: the flag wins over the environment, which wins over the config file,
 * which wins over the `node` default. Blank values are ignored at every level, so an unset-but-present
 * `RSHONO_DEPLOY=` in CI falls through rather than failing the build.
 */
export function resolveDeployPreset(sources: DeploySources = {}): DeployPreset {
  const target = sources.flag?.trim() || sources.env?.trim() || sources.config?.trim();
  if (!target) return NODE_PRESET;

  const preset = presetFor(target);
  if (!preset) {
    throw new Error(`[rshono] unknown deploy target ${JSON.stringify(target)} — expected one of: ${DEPLOY_TARGETS.join(', ')}.`);
  }
  return preset;
}
