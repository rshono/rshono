import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
export const TESTBED_DIR = join(ROOT, 'apps', 'testbed');
export const TESTBED_DIST = join(TESTBED_DIR, 'dist');
/** Where `rshono dev` builds to — deliberately not `dist/`, so `rshono build` cannot overwrite a running server. */
export const TESTBED_DEV_DIR = join(TESTBED_DIR, '.rshono');
export const FIXTURES_DIR = join(ROOT, 'packages', 'core', 'test', 'fixtures');
/** The smallest app the framework accepts: src/routes.ts and nothing else. */
export const MINIMAL_APP_DIR = join(FIXTURES_DIR, 'minimal-app');
/** An app whose CSS only compiles if the builder found its `postcss.config.mjs`. */
export const POSTCSS_APP_DIR = join(FIXTURES_DIR, 'postcss-app');
const CLI = join(ROOT, 'packages', 'core', 'bin', 'rshono.mjs');

/** What each command prints once it is listening; the capture group is the port. */
const READY = {
  start: /serving on http:\/\/localhost:(\d+)/,
  dev: /dev server: http:\/\/localhost:(\d+)/,
};

/**
 * The environment the testbed is built and served with. It lives here rather than in the testbed's
 * `.env`, because `.env*` is gitignored: a suite that asserts on these values has to carry them
 * itself or it passes locally and fails on a fresh checkout. The real environment wins over a
 * `.env` file, so this also pins the values against whatever a contributor happens to have there.
 */
export const APP_ENV = {
  /** Secret — asserted never to reach the browser, in the HTML, the flight payload or a chunk. */
  DATABASE_URL: 'my private database url',
  /** `PUBLIC_`-prefixed — asserted to be inlined into the client bundle and visible via `ctx.env`. */
  PUBLIC_API_ENDPOINT: 'public dummy url',
};

/**
 * Build any app directory with the real CLI, the way a user would. `config` is an absolute path to a
 * fixture config: config bakes into the bundle at build time, so exercising a non-default setting
 * (`trustProxy`) means building with one. The security middleware in the testbed's src/server.ts —
 * `csrf()`, `bodyLimit()`, `secureHeaders()` — is read from the environment at start instead, and
 * needs no build of its own.
 */
export function buildApp(dir, { config, args = [], env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI, 'build', ...(config ? ['--config', config] : []), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...APP_ENV, ...env },
    timeout: 180_000,
  });
  if (result.status !== 0) {
    throw new Error(`build failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  // Both streams, the way {@link runCli} returns them: a build says what it did on stdout and warns about it
  // on stderr, and a test asserting on what the build said wants the pair. Concatenated rather than
  // interleaved — which of them a line landed on is not what any of these assert.
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

export function buildTestbed(config, { env } = {}) {
  return buildApp(TESTBED_DIR, { config, env });
}

/**
 * Runs `rshono <args>` to completion — for asserting on a command that is expected to *exit*, where
 * {@link startApp} would only ever reject. Both streams are returned as one string, because which of
 * them a refusal lands on is not the point of any test that uses this.
 */
export function runCli(dir, args, { env = {}, timeoutMs = 60_000 } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...APP_ENV, ...env },
    timeout: timeoutMs,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * Imports the server bundle the last build produced, for a suite that calls its export the way a
 * platform would rather than over HTTP.
 *
 * `import()` resolves a *URL*, not a path, so the path has to be converted: on Windows an absolute
 * path starts with a drive letter, which parses as a `d:` scheme and Node rejects with
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`. A bare path only gets away with it on POSIX, where it happens to
 * read as a URL path — so this lives here rather than at each call site.
 *
 * `cacheKey` is appended as a query. Every target builds to the same filename and the module cache
 * is keyed by specifier, so importing twice without one hands back the previous build.
 */
export function importServerBundle(cacheKey) {
  return importAppBundle(TESTBED_DIR, cacheKey);
}

/** {@link importServerBundle} for any app directory — the fixtures included. */
export function importAppBundle(dir, cacheKey) {
  return import(`${pathToFileURL(join(dir, 'dist', 'server', 'main.mjs')).href}?${cacheKey}`);
}

/** Runs `rshono <command>` in `dir` and resolves once it reports the address it is listening on. */
export function startApp(dir, command, { env = {}, timeoutMs = 60_000 } = {}) {
  const ready = READY[command];
  if (!ready) throw new Error(`no ready pattern for \`rshono ${command}\` — it would resolve on any output`);
  const child = spawn(process.execPath, [CLI, command], {
    cwd: dir,
    env: { ...process.env, PORT: '0', ...APP_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`server did not report ready within ${timeoutMs / 1000}s:\n${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      const match = output.match(ready);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]), base: `http://localhost:${match[1]}`, getOutput: () => output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}):\n${output}`));
    });
  });
}

export function startTestbed(command, options) {
  return startApp(TESTBED_DIR, command, options);
}

export function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  });
}

/** The built browser bundle's sources — the only way to assert what did, and did not, ship to it. */
export function clientChunks() {
  const dir = join(TESTBED_DIST, 'static', 'chunks');
  return readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8'));
}

/** Where one module's body starts inside a minified chunk: `DRuE(e,c,a){` or `"+TQ/"(e,c,a){`. */
const MODULE_BOUNDARY = /(?:"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)\(\w+,\w+,\w+\)\{/g;

/** The chunk from the start of the module containing `marker` — enough to read that module's call sites. */
function moduleContaining(chunk, marker) {
  const at = chunk.indexOf(marker);
  if (at === -1) return null;
  let start = 0;
  for (const boundary of chunk.matchAll(MODULE_BOUNDARY)) {
    if (boundary.index > at) break;
    start = boundary.index;
  }
  return chunk.slice(start);
}

/**
 * The id React assigned a server action, found the way the browser finds it: through the `'use client'`
 * component that calls it, identified by `marker` — a string only that component renders.
 *
 * Not by position. The RSC transform turns the app's action module into a proxy of
 * `createServerReference("<id>")` declarations, and *every* chunk that needs *any* action gets the whole
 * proxy — so all of the app's ids appear in all of them, in an order that is the minifier's business and
 * shifts when an action is added. What is unambiguous is the call site: the component reaches for exactly
 * one of the proxy's mangled exports, and that name maps back to a declaration and so to an id.
 */
export function serverActionId(marker) {
  for (const chunk of clientChunks()) {
    const body = moduleContaining(chunk, marker);
    if (!body) continue;

    // `let r=(0,f.createServerReference)("<id>"),d=…` — the declaration order, as local names.
    const idForLocal = new Map(
      [...chunk.matchAll(/([A-Za-z_$][\w$]*)=\(0,\w+\.createServerReference\)\(\s*"([0-9a-f]{20,})"/g)].map((m) => [m[1], m[2]]),
    );
    // `a.d(c,{},{$5:b,Oy:n,…})` — the mangled export names those locals are published under.
    const localForExport = new Map(
      [...chunk.matchAll(/\.d\(\w+,\{\},\{([^}]*)\}\)/g)].flatMap((m) => [...m[1].matchAll(/([\w$]+):([\w$]+)/g)].map((e) => [e[1], e[2]])),
    );

    // The first of those exports the marker's own module calls, e.g. `(0,d.ri)()`.
    for (const call of body.matchAll(/\(0,[\w$]+\.([\w$]+)\)\(/g)) {
      const id = idForLocal.get(localForExport.get(call[1]));
      if (id) return id;
    }
  }
  throw new Error(
    `no client component rendering ${JSON.stringify(marker)} calls a server action. ` +
      'It has to *call* one — an action handed to `useActionState` is passed along as a value and never ' +
      'appears as a call site, so there is no mangled export name to trace back to an id.',
  );
}

/**
 * The body a browser would POST for a form React rendered, with no JavaScript involved. React emits
 * one of two field shapes: the `$ACTION_REF`/`$ACTION_KEY` set for a `useActionState` form, or a
 * single `$ACTION_ID_<id>` when a server component renders the form itself.
 */
export function actionFormData(html, fields = {}) {
  const form = new FormData();
  const hidden = (name) => {
    const match = html.match(new RegExp(`name="\\${name}" value="([^"]*)"`));
    return match ? match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&') : undefined;
  };

  const meta = hidden('$ACTION_1:0');
  const key = hidden('$ACTION_KEY');
  const id = html.match(/name="(\$ACTION_ID_[0-9a-f]+)"/)?.[1];
  if (meta && key) {
    form.set('$ACTION_REF_1', hidden('$ACTION_REF_1') ?? '');
    form.set('$ACTION_1:0', meta);
    form.set('$ACTION_1:1', hidden('$ACTION_1:1') ?? '[{}]');
    form.set('$ACTION_KEY', key);
  } else if (id) {
    form.set(id, '');
  } else {
    throw new Error('the rendered form carries no $ACTION fields, so it cannot be submitted');
  }

  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
}
