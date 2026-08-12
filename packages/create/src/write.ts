import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plan } from './plan.js';

/** Files that do not make a directory "occupied": a `git init` or an editor has put nothing there to overwrite. */
const IGNORED_ENTRIES = new Set(['.git', '.DS_Store', '.idea', '.vscode', 'Thumbs.db']);

/**
 * What is already at the target path, ignoring the entries a fresh clone or an editor leaves behind — which is
 * what decides whether scaffolding into it is safe. A path that does not exist yet is no conflict; one that
 * exists and is not a directory throws, since `--force` should not write into it either.
 */
export function conflictingEntries(dir: string): string[] {
  const stats = statSync(dir, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory()) throw new Error(`${dir} already exists and is not a directory.`);
  return readdirSync(dir).filter((entry) => !IGNORED_ENTRIES.has(entry));
}

/**
 * Writes the plan, creating directories as needed and keeping the plan's own ordering — so a failure part-way
 * through leaves something a person can make sense of.
 */
export function writePlan(plan: Plan, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const [path, contents] of plan.files) {
    const absolute = join(targetDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}
