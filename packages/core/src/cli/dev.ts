import { serve } from '@hono/node-server';
import { rspack, type Stats } from '@rspack/core';
import { Hono } from 'hono';
import { proxy } from 'hono/proxy';
import { watch } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DEV_OUT_DIR, createConfigs } from '../builder/rspack-config.js';
import type { RshonoConfig } from '../config.js';
import { NODE_PRESET } from '../deploy/presets.js';
import type { DevMessage } from '../runtime/dev-protocol.js';
import { SERVER_DEFAULTS } from '../server/server-config.js';
import { createStaticAssetsApp } from '../server/static.js';
import { exit } from './exit.js';

const WORKER_READY_TIMEOUT_MS = 15_000;

/**
 * Files whose contents are *compiled into* a build rather than read per request, so no rebuild picks a change
 * to them up: `.env` because the `PUBLIC_` view of it is baked into the client bundle by DefinePlugin and into
 * the SSR layer by the env-shadow prelude, and `rshono.config.ts` because `ServerConfig` is a DefinePlugin
 * literal too. `.env` is worse than the config, which the docs at least describe as build-time: a page that
 * reads `process.env` rebuilds, serves, and shows the old value.
 */
const BAKED_IN_FILES = ['.env.local', '.env', 'rshono.config.ts', 'rshono.config.js', 'rshono.config.mjs'];

/**
 * Watches those files, only to say that a restart is needed.
 *
 * Reloading them for real means re-exec'ing this process: `process.loadEnvFile` does not override a variable
 * that is already set, so the copy this process took at startup would survive an in-place reload — and the
 * worker is spawned with `env: process.env`, so it would inherit the stale value too. Choreographing that
 * against a bound port and a live SSE connection is a great deal of machinery to save one Ctrl-C; a line
 * saying which key to press costs nothing and loses nobody an afternoon.
 *
 * The directory is watched rather than each file, so a file that does not exist yet is still covered — and
 * because an editor's atomic save replaces the file, which a watch on the file itself does not survive. An
 * explicit `--config` outside the project root is not covered: this is a convenience, not a contract.
 */
function warnOnBakedInFileChanges(rootDir: string): void {
  const warnedAt = new Map<string, number>();
  try {
    // `persistent: false`: the dev server is kept alive by its listener, and a watcher that outlived it
    // would hold the process open with nothing left to report to.
    watch(rootDir, { persistent: false }, (_event, filename) => {
      if (!filename || !BAKED_IN_FILES.includes(filename)) return;
      // One save fires several events — a write, a rename, an attribute change — and they are all the same
      // save. The window is short enough that a second real edit still gets its own line.
      const now = Date.now();
      if (now - (warnedAt.get(filename) ?? 0) < 250) return;
      warnedAt.set(filename, now);
      console.warn(`  ⚠ ${filename} changed — restart \`rshono dev\` to pick it up. It is compiled into the build, not read per request.`);
    });
  } catch {
    // No watcher available: a filesystem that cannot, or a platform limit reached. Rebuilding still works,
    // so the dev server goes on without the reminder rather than refusing to start over one.
  }
}

/** An error as the dev server shows it in the browser: the stack where there is one, since this is dev. */
function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Whether nothing is listening on the port yet — checked before the output directory is emptied, because a
 * second `rshono dev` would otherwise wipe the chunks the running one is still importing and only then exit
 * on EADDRINUSE.
 */
function portAvailable(port: number, hostname: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, hostname, () => probe.close(() => resolve(true)));
  return promise;
}

interface DevOptions {
  rootDir: string;
  port?: number;
  config: RshonoConfig;
}

export async function devCommand(options: DevOptions): Promise<void> {
  const { rootDir, config } = options;
  const port = options.port ?? SERVER_DEFAULTS.port;
  // Its own directory, never `dist/`: a `rshono build` in another terminal must not be able to delete the
  // chunks this server is still importing.
  const outDir = join(rootDir, DEV_OUT_DIR);

  // Before the `rm` below, not at `serve` where the bind happens — see {@link portAvailable}.
  if (!(await portAvailable(port, '127.0.0.1'))) {
    console.error(`  ✗ port ${port} is already in use`);
    return exit(1);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'static'), { recursive: true });

  const encoder = new TextEncoder();
  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let clientHash: string | undefined;

  const sseChunk = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

  /**
   * Writes one already-encoded SSE frame to every open client. A failed write is what retires a client:
   * `cancel` is not always reached first when a browser navigates away.
   */
  function sendToAll(chunk: Uint8Array): void {
    for (const controller of sseClients) {
      try {
        controller.enqueue(chunk);
      } catch {
        sseClients.delete(controller);
      }
    }
  }

  function broadcast(message: DevMessage): void {
    sendToAll(sseChunk(message));
  }

  let serverComponentsChanged = false;
  const [clientConfig, serverConfig] = createConfigs({
    rootDir,
    isDev: true,
    config,
    // Always Node, whatever `deploy` says: that is a property of `build` output, and the dev server runs the
    // bundle in a worker thread of this process.
    preset: NODE_PRESET,
    onServerComponentChanges: () => {
      serverComponentsChanged = true;
    },
  });
  const compiler = rspack([clientConfig, serverConfig]);
  const [clientCompiler, serverCompiler] = compiler.compilers;

  let currentWorker: Worker | null = null;
  let workerPort: number | null = null;
  let workerGate = createGate();
  let restartChain: Promise<void> = Promise.resolve();

  function createGate() {
    const { promise, resolve } = Promise.withResolvers<{ error?: string }>();
    return { promise, open: resolve };
  }

  function spawnWorker(): Promise<{ worker: Worker; port: number }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(join(outDir, 'server', 'main.mjs'), {
        workerData: { port: 0, hostname: '127.0.0.1' },
        execArgv: ['--enable-source-maps'],
        env: process.env as Record<string, string>,
      });
      const timeout = setTimeout(() => {
        // Nothing waits on the termination: the promise below is already being rejected, and a worker that
        // never reported ready has no state left worth draining.
        void worker.terminate();
        reject(new Error(`server worker did not become ready within ${WORKER_READY_TIMEOUT_MS / 1000}s`));
      }, WORKER_READY_TIMEOUT_MS);

      let ready = false;
      worker.once('message', (message: { type?: string; port?: number }) => {
        if (message?.type === 'ready' && typeof message.port === 'number') {
          ready = true;
          clearTimeout(timeout);
          resolve({ worker, port: message.port });
        }
      });
      // `on`, not `once`: an error after the worker is ready has no pending promise left to reject, and a
      // consumed `once` would leave it unlistened — which Node turns into an uncaught exception here.
      worker.on('error', (error: Error) => {
        if (ready) {
          console.error('  ✗ server worker crashed:', error);
          return;
        }
        clearTimeout(timeout);
        reject(error);
      });
      worker.on('exit', (code) => {
        if (worker === currentWorker && code !== 0) {
          console.error(`  ✗ server worker exited with code ${code} — waiting for the next rebuild`);
          currentWorker = null;
          // Opened with the reason rather than left closed, so a request arriving before the next rebuild sees
          // it instead of hanging. `hooks.invalid` installs a fresh closed gate as soon as a file changes.
          workerGate = createGate();
          workerGate.open({ error: `The server worker exited with code ${code}. See the terminal for the error it crashed with.` });
        }
      });
    });
  }

  serverCompiler.hooks.invalid.tap('rshono/gate', () => {
    workerGate = createGate();
  });

  serverCompiler.hooks.done.tapPromise('rshono/worker', async (stats: Stats) => {
    const gate = workerGate;
    restartChain = restartChain.then(async () => {
      if (stats.hasErrors()) {
        console.error(stats.toString({ preset: 'errors-warnings', colors: true }));
        gate.open({ error: stats.toString({ preset: 'errors-only', colors: false }) });
        return;
      }
      try {
        if (currentWorker) {
          const old = currentWorker;
          currentWorker = null;
          await old.terminate();
        }
        const { worker, port: newPort } = await spawnWorker();
        currentWorker = worker;
        workerPort = newPort;
        gate.open({});
        if (serverComponentsChanged) {
          serverComponentsChanged = false;
          broadcast({ type: 'rsc-update' });
        }
      } catch (error) {
        console.error('  ✗ failed to start server worker:', error);
        gate.open({ error: describe(error) });
      }
    });
    // No link in this queue may be left rejected: `.then` on a rejected promise short-circuits, and from there
    // no worker is spawned and no gate is opened again.
    restartChain = restartChain.catch((error) => {
      console.error('  ✗ dev server restart failed:', error);
      gate.open({ error: describe(error) });
    });
    await restartChain;
  });

  clientCompiler.hooks.done.tap('rshono/hmr', (stats: Stats) => {
    if (stats.hasErrors()) {
      console.error(stats.toString({ preset: 'errors-warnings', colors: true }));
      return;
    }
    clientHash = stats.hash ?? undefined;
    if (clientHash) broadcast({ type: 'client-built', hash: clientHash });
  });

  let firstBuild = true;
  compiler.watch([{}, {}] as never, (err, multiStats) => {
    if (err) {
      console.error('  ✗ build failed:', err);
      return;
    }
    if (multiStats && !multiStats.hasErrors()) {
      // Errors print themselves through the per-compiler `done` hooks; a warning has nowhere else to go, and
      // the env shadow reports what it cannot cover that way. See `env-shadow-loader.cjs`.
      if (multiStats.hasWarnings()) console.warn(multiStats.toString({ preset: 'errors-warnings', colors: true }));
      const seconds = Math.max(...multiStats.stats.map((s) => (s.endTime ?? 0) - (s.startTime ?? 0))) / 1000;
      console.log(`  ${firstBuild ? '✓ built' : '✓ rebuilt'} in ${seconds.toFixed(1)}s`);
      firstBuild = false;
    }
  });

  const front = new Hono();

  // **Answered here, not proxied — so the app's own middleware does not see an asset request in dev.**
  // That is a divergence from a build, where `/_static` is mounted *inside* the app so an asset carries
  // HSTS, the app's CSP and anything else its middleware sets (`prod-config.test.mjs` asserts it). It is
  // kept deliberately, and the reason is the gate below: every request the front-end proxies first awaits
  // `workerGate.promise`. The client bundle is built by a compiler that finishes independently of the
  // server one, so proxying assets would park the browser's JS and CSS behind the *server* rebuild — a save
  // touching one server component would stall the whole page's assets, and a server bundle that failed to
  // build would take them down with it. A worse dev experience than the divergence.
  //
  // What it costs is real and worth knowing: a CSP is developed against a policy that does not apply to the
  // files it is most likely to break, so the first time it does is in a build. If this ever has to go, the
  // shape that keeps both properties is narrower than a plain move — proxy `/_static` only while a worker
  // is live, and answer locally while the gate is closed.
  front.route('/_static', createStaticAssetsApp({ root: join(outDir, 'static'), isDev: true }));

  front.get('/_rshono/hmr', () => {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller;
        sseClients.add(controller);
        controller.enqueue(encoder.encode('retry: 500\n\n'));
        controller.enqueue(sseChunk({ type: 'hello', hash: clientHash } satisfies DevMessage));
      },
      cancel() {
        sseClients.delete(ctrl);
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  });

  // An SSE comment, not a message: it keeps an idle connection off a proxy's timeout without the client
  // having to know a frame type that means nothing.
  const ping = encoder.encode(': ping\n\n');
  setInterval(() => sendToAll(ping), 15_000).unref();

  front.all('*', async (c) => {
    const { error } = await workerGate.promise;
    if (error || workerPort === null) {
      return c.text(`Build failed:\n\n${error ?? 'server not running'}`, 500);
    }

    const incoming = new URL(c.req.url);
    const target = `http://127.0.0.1:${workerPort}${incoming.pathname}${incoming.search}`;

    // Hono's proxy helper rather than a hand-rolled `fetch`: it carries the method, the streamed body (with
    // the `duplex` Node requires) and the client's abort signal, and strips the hop-by-hop headers on the way
    // back. `headers` replaces the set wholesale, so the request's own are spread back in first.
    const response = await proxy(target, {
      raw: c.req.raw,
      // The worker's redirects are the app's answer to this request, to be rewritten below and passed on.
      redirect: 'manual',
      headers: {
        ...c.req.header(),
        // This front-end *is* the proxy the app sits behind, which is why `trustProxy` is forced on in dev:
        // without these the app resolves every URL against the worker's random 127.0.0.1 port.
        'x-forwarded-host': incoming.host,
        'x-forwarded-proto': incoming.protocol.replace(':', ''),
      },
    });

    // A redirect to the worker's own address has to become a relative one, or the browser leaves the dev
    // server for a random port only this process knows about.
    const location = response.headers.get('location');
    const loc = location ? URL.parse(location, target) : null;
    if (loc && loc.host === `127.0.0.1:${workerPort}`) {
      response.headers.set('location', `${loc.pathname}${loc.search}${loc.hash}`);
    }
    return response;
  });

  warnOnBakedInFileChanges(rootDir);

  serve({ fetch: front.fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`  ➜ rshono dev server: http://localhost:${info.port}`);
  });
}
