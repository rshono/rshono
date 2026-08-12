import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { DEPLOY_TARGETS, resolveDeployPreset } from '../deploy/presets.js';
import { loadConfig } from '../server/load-config.js';
import { loadEnvFiles } from '../server/load-env.js';

// The commands are imported where they are dispatched: `build` and `dev` pull in Rspack, and a static import
// would load it for `start` too — ~30 MB of RSS and ~70ms of startup for a command that only spawns a server.

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
    console.log(require('@rshono/core/package.json').version);
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

  const flagPort = values.port ? Number(values.port) : undefined;
  if (values.port && Number.isNaN(flagPort)) {
    console.error(`rshono: invalid --port "${values.port}"`);
    process.exit(1);
  }
  // Precedence: --port flag > PORT env > the command's built-in default.
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = flagPort ?? envPort;
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
