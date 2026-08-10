import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { selectFeatures, type Feature } from './features/index.js';
import type { Answers } from './options.js';
import { buildPackageJson, buildPnpmSettings } from './pkg.js';
import type { PackageManager } from './pm.js';
import { render, tokensFor } from './render.js';

/** `dist/cli.mjs` and `templates/` are siblings in the published package, as they are in the repo. */
const TEMPLATES_DIR = join(import.meta.dirname, '..', 'templates');

/**
 * Every file the scaffold will consist of, keyed by its path relative to the project root (POSIX
 * separators, so a snapshot taken on one platform matches the next).
 *
 * Text only, so a plan can be token-substituted and diffed in a test. An overlay wanting to ship a
 * binary asset would need this to widen.
 */
export interface Plan {
  files: Map<string, string>;
  /** The features that produced it, kept so callers can ask what the app got rather than re-derive it. */
  features: Feature[];
  /** Lines for the "next steps" block, contributed by features. */
  notes: string[];
}

function readTemplateDir(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const relative = absolute
      .slice(dir.length + 1)
      .split(sep)
      .join(posix.sep);
    files.set(relative, readFileSync(absolute, 'utf8'));
  }
  return files;
}

/**
 * `_gitignore` → `.gitignore`, and so on for every dotfile.
 *
 * npm strips a literal `.gitignore` out of a published tarball, so a template cannot contain one — it
 * would exist in the repo, pass every local test, and be missing from the package everybody installs.
 * Applies to the basename only, so `src/lib/_x.ts` is a dotfile but `templates/_x/y.ts` is not.
 */
function undotted(path: string): string {
  const segments = path.split(posix.sep);
  const name = segments.pop()!;
  return [...segments, name.startsWith('_') ? `.${name.slice(1)}` : name].join(posix.sep);
}

/**
 * A feature's `.gitignore` lines, appended under a heading naming it — so somebody reading the file six
 * months later can tell why `.wrangler/` is in there.
 */
function appendGitignore(existing: string, features: Feature[]): string {
  const additions = features.filter((feature) => feature.gitignore?.length);
  if (additions.length === 0) return existing;

  const blocks = additions.map((feature) => `\n# ${feature.id}\n${feature.gitignore!.join('\n')}\n`);
  return existing + blocks.join('');
}

/**
 * Turns answers into the exact set of files to write, without touching the target directory — the
 * decisions and the I/O are separated so the whole matrix of answers can be asserted on in a test, and
 * so `--dry-run` is the same code path minus the last step.
 */
export function plan(answers: Answers, pm: PackageManager): Plan {
  const features = selectFeatures(answers, pm);
  const tokens = tokensFor(answers, features, pm);

  const raw = readTemplateDir(join(TEMPLATES_DIR, 'base'));
  for (const feature of features) {
    for (const overlay of feature.overlays ?? []) {
      for (const [path, contents] of readTemplateDir(join(TEMPLATES_DIR, overlay))) {
        raw.set(path, contents);
      }
    }
  }

  const files = new Map<string, string>();
  for (const [path, contents] of raw) {
    files.set(undotted(path), render(contents, tokens, path));
  }

  const gitignore = files.get('.gitignore');
  if (gitignore) files.set('.gitignore', appendGitignore(gitignore, features));

  files.set('package.json', buildPackageJson(answers, features, pm));
  // Only for pnpm, and only when a feature brought an install script to answer for — see `buildPnpmSettings`.
  const pnpmSettings = pm.name === 'pnpm' ? buildPnpmSettings(features) : null;
  if (pnpmSettings) files.set('pnpm-workspace.yaml', pnpmSettings);

  return {
    // Sorted, so both the write order and a test's snapshot are stable.
    files: new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1))),
    features,
    notes: features.flatMap((feature) => feature.notes ?? []),
  };
}
