// Checks that the exactly-pinned dependencies agree everywhere they are written down.
//
// RSC internals are coupled across builds — `react-server-dom-rspack` reaches into `ReactSharedInternals`
// and emits a flight payload the matching `react-dom` has to parse, and its `@rspack/core` peer range moves
// with it — so the coupled set is pinned in three places at once: the two published manifests, and the
// `overrides` in `pnpm-workspace.yaml` that force one resolution on every workspace member and fixture.
// Three copies of one fact, and nothing made them agree.
//
// They once did not. `6d8e3e4` moved the manifests to `@rspack/core` 2.2.0 / `react-server-dom-rspack` 0.1.0
// and left the overrides on 2.1.7 / 0.0.3, so the suite, CI and every fixture ran against one pair while
// `npm i @rshono/core` would have installed the other — for a month, silently, because a manifest pin is
// what a consumer resolves and an override is what this repo resolves, and no check compared them. That is
// the whole reason this file exists: the version the suite tests has to be the version a consumer gets.
//
// Reported here rather than as a unit test because the invariant spans both published packages and the root
// workspace file, which neither package's own suite owns. Wired into the `lint` CI job and into
// `scripts/release.mjs`, so it holds for a laptop release too.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// The manifests a consumer installs. `peerDependencies` are deliberately wide ranges — the pins are what the
// framework is *tested* against, the peers are what it *accepts* — so only these two fields are compared.
const MANIFESTS = ['packages/core/package.json', 'packages/create/package.json'];
const PINNED_FIELDS = ['dependencies', 'devDependencies'];

/** An exact version, as every override has to be: no `^`, no `~`, no range, no tag. */
const EXACT = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/**
 * The `overrides:` block of a pnpm YAML file, without a YAML parser — the block is flat `name: version`
 * pairs and the two files that carry one are both in this repo.
 *
 * Strict on purpose. A line it cannot account for throws rather than being skipped, because the failure mode
 * this whole file guards against is a pin that silently went unchecked.
 */
function readOverrides(relPath) {
  const lines = readFileSync(join(rootDir, relPath), 'utf8').split(/\r?\n/);
  const start = lines.indexOf('overrides:');
  if (start === -1) throw new Error(`${relPath} has no \`overrides:\` block — the pins are no longer where this check looks for them.`);

  const overrides = new Map();
  for (const [offset, line] of lines.slice(start + 1).entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // The block ends at the first line that is not indented, i.e. the next top-level key.
    if (!/^\s/.test(line)) break;
    const entry = /^\s+'?([^':\s]+)'?:\s*'?([^'\s#]+)'?\s*(?:#.*)?$/.exec(line);
    if (!entry) throw new Error(`${relPath}:${start + 2 + offset} is inside \`overrides:\` but is not a \`name: version\` pair: ${line.trim()}`);
    overrides.set(entry[1], entry[2]);
  }

  if (overrides.size === 0) throw new Error(`${relPath} has an empty \`overrides:\` block.`);
  return overrides;
}

/** The version of `name` as the package in `packageDir` actually resolves it, or `undefined` if it has none. */
function installedVersion(packageDir, name) {
  try {
    const require = createRequire(join(rootDir, packageDir, 'package.json'));
    return require(`${name}/package.json`).version;
  } catch {
    return undefined;
  }
}

/**
 * Every disagreement between the overrides, the manifests, the lockfile and what is installed, as lines
 * ready to print. Empty means they agree.
 */
export function checkPinnedDeps() {
  const overrides = readOverrides('pnpm-workspace.yaml');
  const problems = [];
  // Which pins were compared against a real install, so the summary claims only what it checked: a tree that
  // has not been installed yet answers for the files alone.
  const resolved = new Set();

  // The lockfile restates the overrides it was resolved with, so this is the "you edited the workspace file
  // and did not install" check. CI's `--frozen-lockfile` also catches it; a laptop release does not install.
  const locked = readOverrides('pnpm-lock.yaml');
  for (const [name, version] of overrides) {
    const lockedVersion = locked.get(name);
    if (lockedVersion !== version) {
      problems.push(
        `pnpm-lock.yaml was resolved with ${name} ${lockedVersion ?? '(no override)'}, but pnpm-workspace.yaml now pins ${version} — run \`pnpm install\``,
      );
    }
  }

  for (const relPath of MANIFESTS) {
    const manifest = JSON.parse(readFileSync(join(rootDir, relPath), 'utf8'));
    const packageDir = dirname(relPath);

    for (const field of PINNED_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        const pinned = overrides.get(name);
        if (pinned === undefined) continue;

        if (range !== pinned) {
          problems.push(
            `${relPath} declares ${field}.${name} as ${range}, but pnpm-workspace.yaml pins ${pinned} — ` +
              `a consumer resolves the manifest, this repo resolves the override, so these are two different tested versions`,
          );
        }

        // What the suite actually ran against. Catches a stale `node_modules` that agrees with nothing.
        const installed = installedVersion(packageDir, name);
        if (installed !== undefined) resolved.add(name);
        if (installed !== undefined && installed !== pinned) {
          problems.push(`${packageDir} has ${name} ${installed} installed, but the pin is ${pinned} — run \`pnpm install\``);
        }
      }
    }
  }

  for (const [name, version] of overrides) {
    if (!EXACT.test(version)) {
      problems.push(
        `pnpm-workspace.yaml pins ${name} as ${version}, which is a range — the coupled set has to be exact or a resolution can move underneath a release`,
      );
    }
  }

  return { overrides, problems, resolved };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { overrides, problems, resolved } = checkPinnedDeps();

  if (problems.length > 0) {
    console.error('\n✗ the exact pins disagree\n');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      '\n  Every pin is written in three places — packages/core/package.json, packages/create/package.json and\n' +
        '  the `overrides` in pnpm-workspace.yaml — plus the lockfile. Move all of them together, then re-run the\n' +
        '  whole suite: a bump to this set is a release. See CONTRIBUTING.md.\n',
    );
    process.exit(1);
  }

  for (const [name, version] of overrides) {
    const sources = resolved.has(name) ? 'manifests, overrides, lockfile and node_modules' : 'manifests, overrides and lockfile';
    console.log(`  ✓ ${name} ${version} — ${sources} agree`);
  }
}
