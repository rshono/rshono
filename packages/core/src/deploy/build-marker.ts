import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeployTarget } from './contract.js';

/** Records which platform a build was for, so `rshono start` can refuse one it cannot run. */
export interface BuildMarker {
  deploy: DeployTarget;
}

const MARKER_FILE = 'rshono-build.json';

export function writeBuildMarker(distDir: string, deploy: DeployTarget): void {
  writeFileSync(join(distDir, MARKER_FILE), `${JSON.stringify({ deploy } satisfies BuildMarker, null, 2)}\n`);
}

/**
 * The target the build in `distDir` was produced for, or `null` when there is nothing to go on — a missing
 * marker is not an error, since a build from an older rshono has none and refusing to start one that would
 * have worked is worse than the failure this guards against.
 */
export function readBuildMarker(distDir: string): DeployTarget | null {
  const file = join(distDir, MARKER_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildMarker>;
    return typeof parsed.deploy === 'string' ? parsed.deploy : null;
  } catch {
    return null;
  }
}
