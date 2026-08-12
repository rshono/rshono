import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readBuildMarker } from '../deploy/build-marker.js';
import { deployHintFor } from '../deploy/presets.js';
import { onShutdown } from '../server/shutdown.js';

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

  const env = { ...process.env };
  if (port !== undefined) env.PORT = String(port);
  if (host !== undefined) env.HOST = host;

  const child = spawn(process.execPath, ['--enable-source-maps', mainPath], {
    stdio: 'inherit',
    env,
  });

  onShutdown((signal) => child.kill(signal));
  child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 1));
  });
}
