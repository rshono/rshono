import { spawnSync } from 'node:child_process';
import { PACKAGE_MANAGERS, type PackageManagerName } from './options.js';

export interface PackageManager {
  name: PackageManagerName;
  /** The exact version, when the environment told us — written into `packageManager` for Corepack. */
  version?: string;
  /** Argv for a full install in the project directory. */
  install: string[];
  /** What precedes a script name: `pnpm dev`, but `npm run dev`. */
  run: string;
  /**
   * How this manager runs a CLI it has *not* installed — `npx`, `pnpm dlx`, `yarn dlx`, `bunx`. The Vercel
   * target needs it: its `deploy` script fetches the CLI through this rather than assuming a global `vercel`.
   */
  dlx: string;
}

const INSTALL: Record<PackageManagerName, string[]> = {
  npm: ['install'],
  pnpm: ['install'],
  yarn: [],
  bun: ['install'],
};

const RUN: Record<PackageManagerName, string> = {
  npm: 'npm run',
  pnpm: 'pnpm',
  yarn: 'yarn',
  bun: 'bun',
};

const DLX: Record<PackageManagerName, string> = {
  npm: 'npx',
  pnpm: 'pnpm dlx',
  yarn: 'yarn dlx',
  bun: 'bunx',
};

function isKnown(name: string): name is PackageManagerName {
  return PACKAGE_MANAGERS.includes(name as PackageManagerName);
}

export function packageManager(name: PackageManagerName, version?: string): PackageManager {
  return { name, version, install: INSTALL[name], run: RUN[name], dlx: DLX[name] };
}

/**
 * Which package manager invoked us. All four set `npm_config_user_agent` on the process they spawn — `pnpm/11.9.0
 * npm/? node/v22.14.0 darwin arm64` — so `pnx @rshono/create` scaffolds a pnpm project without asking, exact
 * version included. Falls back to npm, which is also what a bare `node bin/create-rshono.mjs` gets.
 */
export function detectPackageManager(userAgent = process.env.npm_config_user_agent): PackageManager {
  const [spec] = (userAgent ?? '').split(' ');
  const [name, version] = (spec ?? '').split('/');
  if (name && isKnown(name)) return packageManager(name, version && /^\d+\.\d+\.\d+/.test(version) ? version : undefined);
  return packageManager('npm');
}

/**
 * Runs the install, streaming its output. `shell: true` on Windows, where npm, pnpm and yarn are `.cmd` shims
 * `spawn` cannot execute directly — safe because every argument is a fixed string from the tables above.
 */
export function runInstall(pm: PackageManager, cwd: string): boolean {
  return run(pm, pm.install, cwd);
}

function run(pm: PackageManager, args: string[], cwd: string): boolean {
  const result = spawnSync(pm.name, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  return result.status === 0;
}
