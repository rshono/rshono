import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { parentPort, workerData } from 'node:worker_threads';
import { parsePort, SERVER_DEFAULTS } from '../../server/server-config.js';
import { onShutdown } from '../../server/shutdown.js';
import type { DevWorkerMessage } from '../../runtime/dev-protocol.js';
import type { DeployRuntime } from '../contract.js';
import { fileSystemRuntime } from '../filesystem.js';

/** Bound to every interface — so the address printed on start is `localhost`, not this. */
const WILDCARD_HOST = '0.0.0.0';

/** How long a graceful stop waits for in-flight requests before the process is ended anyway. */
const DRAIN_TIMEOUT_MS = 3000;

/**
 * The address to listen on: an explicit override (the dev server, which picks the port for its worker) beats
 * `PORT` / `HOST`, which beat the built-in default. `??` rather than `||`, so an explicit `PORT=0` — "any free
 * port" — is honoured, and so that {@link parsePort} is never consulted for a port the override already won.
 */
function listenAddress(overrides?: { port?: number; hostname?: string }): { port: number; hostname: string } {
  return {
    port: overrides?.port ?? parsePort(process.env.PORT, 'PORT') ?? SERVER_DEFAULTS.port,
    hostname: overrides?.hostname ?? process.env.HOST ?? SERVER_DEFAULTS.host,
  };
}

/**
 * Node: a long-lived process that owns its own port, with a filesystem behind every asset — the shape the
 * framework was built against, and the only target `rshono dev` produces.
 *
 * Anything that runs a Node process runs this build, Bun and Deno included: the listener is
 * `@hono/node-server`, and both implement the `node:` APIs it needs.
 */
export const runtime: DeployRuntime = {
  ...fileSystemRuntime,

  serveApp(app: Hono): undefined {
    // The prerender pass renders through `app.fetch` directly, and a bound port would keep the build alive.
    if (process.env.RSHONO_PRERENDER) return;

    // The dev server runs this in a worker thread and picks the port itself, so its choice wins.
    const devWorker = workerData as { port?: number; hostname?: string } | null;
    const address = listenAddress(devWorker ?? undefined);

    const server = serve({ fetch: app.fetch, ...address }, (info) => {
      if (parentPort) {
        parentPort.postMessage({ type: 'ready', port: info.port });
      } else {
        const host = address.hostname === WILDCARD_HOST ? 'localhost' : address.hostname;
        console.log(`  ➜ rshono serving on http://${host}:${info.port}`);
      }
    });

    // Stop accepting connections, let the in-flight ones finish, then exit. `boundMs` is the point at which
    // the process is ended anyway; the signal path passes its own, and the dev worker passes nothing because
    // its parent is the bound — `rshono dev` terminates a worker that misses its deadline. In a worker thread
    // neither SIGINT nor SIGTERM is delivered, so the message below is the only way the dev server can ask.
    const drain = (boundMs: number | undefined): void => {
      server.close(() => process.exit(0));
      if (boundMs !== undefined) setTimeout(() => process.exit(0), boundMs).unref();
    };

    onShutdown(() => drain(DRAIN_TIMEOUT_MS));
    // `rshono dev` replaces this worker on every server rebuild. Without the message it would have to
    // `terminate()`, which severs every response still being streamed.
    parentPort?.on('message', (message: DevWorkerMessage) => {
      if (message?.type === 'shutdown') drain(undefined);
    });
  },
};
