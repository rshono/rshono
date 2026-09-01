import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { parentPort, workerData } from 'node:worker_threads';
import { parsePort, SERVER_DEFAULTS } from '../../server/server-config.js';
import { onShutdown } from '../../server/shutdown.js';
import type { DeployRuntime } from '../contract.js';
import { fileSystemRuntime } from '../filesystem.js';

/** Bound to every interface — so the address printed on start is `localhost`, not this. */
const WILDCARD_HOST = '0.0.0.0';

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

    onShutdown(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  },
};
