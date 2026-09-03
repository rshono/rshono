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
 *
 * `string`, not {@link DeployTarget}: the file is on disk and whoever wrote it may be a *newer* rshono with
 * a target this one has never heard of. Narrowing an unrecognised name to `null` would be the wrong repair —
 * `rshono start`'s only use for this is refusing anything that is not `'node'`, so a `null` would let it
 * start a build with no listener in it and exit silently, which is the failure the marker exists to prevent.
 * Reporting the name it does not know is the deliberate behaviour; the return type now says so.
 */
export function readBuildMarker(distDir: string): string | null {
  const file = join(distDir, MARKER_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildMarker>;
    return typeof parsed.deploy === 'string' ? parsed.deploy : null;
  } catch {
    return null;
  }
}
