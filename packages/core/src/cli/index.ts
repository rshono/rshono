import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { DEPLOY_TARGETS, resolveDeployPreset } from '../deploy/presets.js';
import { loadConfig } from '../server/load-config.js';
import { loadEnvFiles } from '../server/load-env.js';
import { parsePort } from '../server/server-config.js';

// The commands are imported where they are dispatched: `build` and `dev` pull in Rspack, and a static import
// would load it for `start` too — ~30 MB of RSS and ~70ms of startup that would then sit in the server's own
// process for its whole life, since `start` imports the bundle rather than spawning it.

const HELP = `rshono — Hono + Rspack + React Server Components

Usage:
  rshono dev     [--port 3000]   start the dev server
  rshono build                   build for production (client + server + SSG)
  rshono start   [--port 3000]   run the production build

Options:
  -p, --port <n>      port to listen on (default: PORT env or 3000)
  -c, --config <path> path to a config file (default: rshono.config.{ts,js,mjs})
  -d, --deploy <name> platform to build for: ${DEPLOY_TARGETS.join(' | ')} (default: node)
  -h, --help          show this help
  -v, --version       print the version
`;

/** {@link parsePort}, reported the way the CLI reports every other bad input: one line, no stack. */
function readPort(value: string | undefined, source: string): number | undefined {
  try {
    return parsePort(value, source);
  } catch (error) {
    console.error(`rshono: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      config: { type: 'string', short: 'c' },
      deploy: { type: 'string', short: 'd' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
  });

  if (values.version) {
    const require = createRequire(import.meta.url);
    const { version } = require('@rshono/core/package.json') as { version: string };
    console.log(version);
    return;
  }

  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  const rootDir = process.cwd();
  loadEnvFiles(rootDir);
  const config = await loadConfig(rootDir, values.config);

  // Precedence: --port flag > PORT env > the command's built-in default. Both sources go through the same
  // parse as the bundle's own, so `PORT=""` means "unset" in the CLI and in the server it starts alike.
  const port = readPort(values.port, '--port') ?? readPort(process.env.PORT, 'PORT');
  const host = process.env.HOST;

  switch (command) {
    case 'dev':
      return (await import('./dev.js')).devCommand({ rootDir, port, config });
    case 'build':
      return (await import('./build.js')).buildCommand({
        rootDir,
        config,
        preset: resolveDeployPreset({ flag: values.deploy, env: process.env.RSHONO_DEPLOY, config: config.deploy }),
      });
    case 'start':
      return (await import('./start.js')).startCommand({ rootDir, port, host });
    default:
      console.error(`rshono: unknown command "${command}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
