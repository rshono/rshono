import { spawnSync } from 'node:child_process';

function git(args: string[], cwd: string): { ok: boolean; stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() };
}

export function hasGit(cwd: string): boolean {
  return git(['--version'], cwd).ok;
}

/**
 * Whether the new project already sits inside somebody's repository — a monorepo or an existing checkout, where
 * a nested repo would be a surprise rather than a convenience.
 */
export function isInsideRepo(cwd: string): boolean {
  const { ok, stdout } = git(['rev-parse', '--is-inside-work-tree'], cwd);
  return ok && stdout === 'true';
}

export type GitResult = 'committed' | 'initialized' | 'failed';

/**
 * Initializes a repository and makes the first commit. `initialized` is the honest answer when the commit itself
 * fails, as it does with no `user.email` configured — the files are all there and staged, so the caller reports
 * it and moves on rather than failing the scaffold.
 */
export function initRepo(cwd: string): GitResult {
  const init = git(['init', '-b', 'main'], cwd).ok || git(['init'], cwd).ok;
  if (!init) return 'failed';
  if (!git(['add', '-A'], cwd).ok) return 'initialized';
  return git(['commit', '-m', 'Initial commit from create-rshono'], cwd).ok ? 'committed' : 'initialized';
}
