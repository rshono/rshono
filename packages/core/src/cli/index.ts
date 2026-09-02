import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { DEPLOY_TARGETS, resolveDeployPreset } from '../deploy/presets.js';
import { loadConfig } from '../server/load-config.js';
import { loadEnvFiles } from '../server/load-env.js';
import { parsePort } from '../server/server-config.js';
import { exit } from './exit.js';

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

Environment:
  PORT                port to listen on, unless --port is given
  HOST                address \`start\` binds to (default 0.0.0.0); \`dev\` always binds 127.0.0.1
  RSHONO_DEPLOY       platform to build for, unless --deploy is given
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

/** `as const` so `parseArgs` can type `values` off the literal `type` fields rather than widening them. */
const CLI_OPTIONS = {
  port: { type: 'string', short: 'p' },
  config: { type: 'string', short: 'c' },
  deploy: { type: 'string', short: 'd' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

/**
 * {@link parseArgs}, reported the way the CLI reports every other bad input: one line, then the help.
 *
 * A typo'd flag is the likeliest of the three bad inputs and used to get by far the worst output. `parseArgs`
 * was the first statement of `main`, with nothing between it and the `main().catch` that prints the raw error
 * object — so `rshono build --porf 3000` answered with nine frames of Node internals, where an unknown
 * command and an unparseable `--port` each answered with a sentence.
 *
 * Node's own message is kept: it names the offending flag, which is the whole content of the error, and
 * `HELP` beneath it lists the ones that exist. Through {@link exit} rather than `process.exit`, because that
 * help goes to stdout and a piped stdout drops whatever has not left the buffer.
 */
async function readArgs(): Promise<ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true }>>> {
  try {
    return parseArgs({ options: CLI_OPTIONS, allowPositionals: true });
  } catch (error) {
    console.error(`rshono: ${error instanceof Error ? error.message : String(error)}\n`);
    console.log(HELP);
    return exit(1);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = await readArgs();

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
      // `HOST` belongs to `start`. The dev server binds loopback unconditionally — its source maps embed the
      // original source of `'use server'` modules — and `DevOptions` has no `host` field to pass one to, so
      // the drop is structural rather than conditional. Said out loud because the variable is read a few
      // lines up and the README lists it under all three commands: `HOST=0.0.0.0 rshono dev` used to do
      // nothing, with nothing to notice.
      if (host !== undefined) {
        console.warn('rshono: HOST is ignored by `rshono dev`, which always binds 127.0.0.1 — it applies to `rshono start`.');
      }
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
      return exit(1);
  }
}

/**
 * The one place a failure becomes output, for every command.
 *
 * A `[rshono]` message was written for whoever is running the command, so it is printed as the one line it
 * is; anything else is a bug in the framework and keeps its stack, because that stack is the report.
 *
 * This rule used to live in `build.ts`, as a `phase()` wrapper around three stages of one command — which
 * left everything outside those three going out through a bare `console.error(error)`: the whole of
 * `rshono dev`, and `build`'s own `createConfigs`, which is where a missing `src/routes.ts` is found. So the
 * likeliest first-run mistake there is answered with a raw `Error` object and two frames of framework
 * internals, which is the same shape of problem an unknown CLI flag had.
 */
main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('[rshono]')) console.error(`\n  ✗ ${message}\n`);
  else console.error(error);
  await exit(1);
});
