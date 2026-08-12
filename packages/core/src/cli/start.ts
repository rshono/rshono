import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBuildMarker } from '../deploy/build-marker.js';
import { deployHintFor } from '../deploy/presets.js';

interface StartOptions {
  rootDir: string;
  port?: number;
  host?: string;
}

export async function startCommand(options: StartOptions): Promise<void> {
  const { rootDir, port, host } = options;
  const distDir = join(rootDir, 'dist');
  const mainPath = join(distDir, 'server', 'main.mjs');
  if (!existsSync(mainPath)) {
    console.error('rshono: no production build found — run `rshono build` first.');
    process.exit(1);
  }

  // A bundle built for a hosting platform has no listener in it, so starting one here would exit silently the
  // moment the module finished evaluating.
  const target = readBuildMarker(distDir);
  if (target !== null && target !== 'node') {
    const hint = deployHintFor(target);
    console.error(`rshono: this build targets ${target}, which \`rshono start\` cannot run${hint ? ` — ${hint}` : '.'}`);
    console.error('  Rebuild for a server with `rshono build --deploy node` to run it here.');
    process.exit(1);
  }

  // Read by the bundle as it evaluates, which is what binds the port — so they have to be set first.
  if (port !== undefined) process.env.PORT = String(port);
  if (host !== undefined) process.env.HOST = host;

  // Imported into this process rather than spawned into a child. The child only ever existed to pass
  // `--enable-source-maps`, and `bin/rshono.mjs` already enables the same thing in-process before the CLI
  // loads — so a supervisor bought a second PID and its own heap in every container, an extra frame in every
  // stack, and signal forwarding for signals the bundle already handles itself through `onShutdown`. `start`
  // deliberately imports no Rspack, so the process this leaves behind is the server and little else.
  await import(pathToFileURL(mainPath).href);
}
