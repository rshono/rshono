// What `plan.test.mjs` cannot tell you: that the manifest it produces installs, that the tsconfig it
// writes typechecks against the framework's real declarations, and that the app builds. Every failure
// this has caught was of that kind — a `baseUrl` TypeScript 7 had removed, a peer range no package
// manager would resolve — and none of them are visible in the file contents.
//
// Opt-in: it packs the framework, then installs from the registry twice. Set CREATE_RSHONO_E2E=1.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const REPO_ROOT = join(PACKAGE_DIR, '..', '..');
const CLI = join(PACKAGE_DIR, 'bin', 'create-rshono.mjs');

const enabled = process.env.CREATE_RSHONO_E2E === '1';
const workspace = enabled ? mkdtempSync(join(tmpdir(), 'create-rshono-')) : '';
after(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', timeout: 600_000 });
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

let packed;

/**
 * The framework as a tarball, so the scaffolded app installs the code in this checkout rather than
 * whatever is on npm — which for an unreleased version is nothing at all.
 *
 * Packed on first use and reused, rather than produced by the first test for the rest to find on disk. That
 * arrangement made every test after the first silently depend on it having run: with
 * `--test-name-pattern`, they resolved the tarball to the empty string, installed a `@rshono/core` that was
 * not the framework, and failed with a type error in the scaffolded app that had nothing to do with the case
 * under test. Any one of these can now be run on its own.
 */
function frameworkTarball() {
  if (packed) return packed;
  run('pnpm', ['--filter', '@rshono/core', 'pack', '--pack-destination', workspace], REPO_ROOT, 'pnpm pack');
  const tarball = readdirSync(workspace).find((entry) => entry.endsWith('.tgz'));
  assert.ok(tarball, 'pnpm pack produced no tarball');
  packed = join(workspace, tarball);
  return packed;
}

function scaffold(name, flags, tarball) {
  run(process.execPath, [CLI, name, '-y', '--pm', 'npm', '--no-install', '--no-git', ...flags], workspace, `scaffold ${name}`);
  const dir = join(workspace, name);

  // The one edit a user would not make: point `@rshono/core` at the packed tarball.
  const manifestPath = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.dependencies['@rshono/core'] = `file:${tarball}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  run('npm', ['install', '--no-audit', '--no-fund'], dir, `npm install (${name})`);

  // Deliberately no `format` run: the CLI does not format either, so the `format:check` further down is a
  // real check that the templates ship clean. The tarball edit above is written back with the same
  // two-space indent a formatter would produce, so it does not disturb that.
  return dir;
}

test('a scaffolded app installs, typechecks and builds', { skip: enabled ? false : 'set CREATE_RSHONO_E2E=1' }, () => {
  const tarball = frameworkTarball();
  const dir = scaffold('plain-app', [], tarball);

  run('npm', ['run', 'typecheck'], dir, 'typecheck');
  const output = run('npm', ['run', 'build'], dir, 'build');
  assert.match(output, /build complete/);

  run('npm', ['run', 'format:check'], dir, 'format:check');
  run('npm', ['run', 'lint'], dir, 'lint');
});

/**
 * The same app on pnpm, which is a different question and not a redundant one: npm, yarn and bun hoist
 * the framework's dependencies into the app's own `node_modules`, and pnpm gives the framework a private
 * directory with its dependencies *beside* it. Anything the framework relies on being resolvable from
 * app source — the RSC runtime the transform injects into pages, client components and actions — is
 * reachable by accident under the first layout and only on purpose under the second, so a build that
 * passes above can still fail here with `Can't resolve 'react-server-dom-rspack/client'`.
 */
test(
  "and installs and builds on pnpm, whose layout hides the framework's own dependencies",
  { skip: enabled ? false : 'set CREATE_RSHONO_E2E=1' },
  () => {
    const tarball = frameworkTarball();
    const name = 'pnpm-app';
    run(process.execPath, [CLI, name, '-y', '--pm', 'pnpm', '--no-install', '--no-git'], workspace, `scaffold ${name}`);
    const dir = join(workspace, name);

    const manifestPath = join(dir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies['@rshono/core'] = `file:${tarball}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // Exactly what a user runs, with no flags to smooth anything over. `pnpm install` fails on an install
    // script the project has not decided about, and `pnpm run` fails again on its way to the script — so
    // this is also what proves a default scaffold needs no `allowBuilds` at all, and is right to ship no
    // pnpm-workspace.yaml. (Cloudflare, the one target that does bring install scripts, ships one.)
    run('pnpm', ['install'], dir, `pnpm install (${name})`);
    run('pnpm', ['run', 'typecheck'], dir, 'typecheck (pnpm)');
    assert.match(run('pnpm', ['run', 'build'], dir, 'build (pnpm)'), /build complete/);
  },
);

/**
 * The ESLint preset, which the stripped install below cannot cover: its rules are type-aware, so they need
 * the same program `tsc` builds — React's types, the framework's declarations, the whole app.
 *
 * Two things are on trial. That the peer set *resolves at all*, which is the reason this preset pins
 * TypeScript 6 (typescript-eslint accepts nothing newer, and npm fails an unsatisfiable peer outright
 * rather than warning). And that the scaffold passes its own `lint` — a fresh app reporting errors in code
 * the user has not written yet is worse than shipping no linter option.
 */
test(
  'the ESLint preset installs on the TypeScript it pins, and the scaffold passes its own rules',
  { skip: enabled ? false : 'set CREATE_RSHONO_E2E=1' },
  () => {
    const tarball = frameworkTarball();
    const dir = scaffold('eslint-app', ['--quality', 'prettier-eslint'], tarball);

    const installed = JSON.parse(readFileSync(join(dir, 'node_modules', 'typescript', 'package.json'), 'utf8')).version;
    assert.match(installed, /^6\.0\./, `typescript-eslint's peer range stops below 6.1 — installed ${installed}`);

    run('npm', ['run', 'typecheck'], dir, 'typecheck (eslint)');
    run('npm', ['run', 'lint'], dir, 'lint (eslint)');
    run('npm', ['run', 'format:check'], dir, 'format:check (eslint)');
    assert.match(run('npm', ['run', 'build'], dir, 'build (eslint)'), /build complete/);
  },
);

/**
 * Every quality preset ships config files for tools this package does not control, and a key one of them
 * has renamed is a broken scaffold that no amount of asserting on file contents would reveal. Only the
 * tools are installed — the framework and React are not needed to find out whether Biome accepts its own
 * config — which keeps this to a few seconds per preset. ESLint is not among them: type-aware rules need
 * the real dependency graph, so it gets the full install above.
 */
test('every quality preset produces configs its own tools accept', { skip: enabled ? false : 'set CREATE_RSHONO_E2E=1' }, () => {
  for (const preset of ['prettier-oxlint', 'biome', 'oxc']) {
    const name = `quality-${preset}`;
    run(process.execPath, [CLI, name, '-y', '--pm', 'npm', '--quality', preset, '--no-install', '--no-git'], workspace, `scaffold ${name}`);
    const dir = join(workspace, name);

    const manifestPath = join(dir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const tools = ['prettier', 'oxfmt', 'oxlint', '@biomejs/biome'];
    manifest.dependencies = {};
    manifest.devDependencies = Object.fromEntries(Object.entries(manifest.devDependencies).filter(([dep]) => tools.includes(dep)));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    run('npm', ['install', '--no-audit', '--no-fund'], dir, `npm install (${name})`);
    // No `format` first: the templates are written to satisfy every formatter at its configured width, and
    // this is the assertion that keeps them that way now that the CLI no longer formats what it scaffolds.
    run('npm', ['run', 'format:check'], dir, `format:check (${preset})`);
    run('npm', ['run', 'lint'], dir, `lint (${preset})`);
  }
});

test('Tailwind compiles through its own PostCSS pass, on a real install', { skip: enabled ? false : 'set CREATE_RSHONO_E2E=1' }, () => {
  const tarball = frameworkTarball();
  const dir = scaffold('tw-app', ['--tailwind', '--quality', 'biome', '--deploy', 'cloudflare'], tarball);

  run('npm', ['run', 'typecheck'], dir, 'typecheck');
  assert.match(run('npm', ['run', 'build'], dir, 'build'), /build complete/);

  const chunks = join(dir, 'dist', 'static', 'chunks');
  const css = readdirSync(chunks)
    .filter((file) => file.endsWith('.css'))
    .map((file) => readFileSync(join(chunks, file), 'utf8'))
    .join('\n');
  assert.doesNotMatch(css, /@import\s+['"]tailwindcss['"]/, 'an unexpanded @import means no PostCSS pass ran');
  assert.match(css, /\.font-semibold\{/, 'a utility used by the scaffolded page should be compiled in');

  // Biome has to accept its own generated config, and the Tailwind stylesheet it cannot parse must be
  // outside what it checks.
  run('npm', ['run', 'check'], dir, 'biome check');
});

/**
 * Every deploy target, scaffolded and built the way a user would.
 *
 * The tests above only ever built the default (`node`, implicitly) and `cloudflare`, so a target whose
 * scaffold did not build was invisible here — and "it builds for the platform I picked" is the whole promise of
 * choosing one in the prompt. What a target contributes is small (scripts, a CLI, gitignore lines, a note), but
 * each one also selects a different server-compiler configuration inside the framework: a different externals
 * policy, different resolve conditions, a different syntax target, and a `finalize` hook that has to assemble a
 * layout on disk. That is the part worth building for real.
 *
 * `--no-install` plus one shared install per target keeps this to a build each. `cloudflare` is skipped: the
 * Tailwind test above already builds it, and it is the one target that installs a CLI with platform binaries.
 */
test('every deploy target scaffolds an app that installs, typechecks and builds', { skip: enabled ? false : 'set CREATE_RSHONO_E2E=1' }, () => {
  const tarball = frameworkTarball();

  /** What each target has to leave on disk for its platform to be deployable, beyond `dist/server`. */
  const outputs = {
    node: ['dist/static'],
    // The Build Output API layout the platform uploads verbatim.
    vercel: ['.vercel/output/config.json', '.vercel/output/functions/index.func/.vc-config.json', '.vercel/output/static'],
    // No finalize hook — the deployment package is `dist/` itself, handler included.
    'aws-lambda': ['dist/server/main.mjs', 'dist/static'],
  };

  for (const [target, expected] of Object.entries(outputs)) {
    const dir = scaffold(`deploy-${target}`, ['--deploy', target], tarball);

    run('npm', ['run', 'typecheck'], dir, `typecheck (${target})`);
    const output = run('npm', ['run', 'build'], dir, `build (${target})`);
    assert.match(output, /build complete/, `${target}: the build has to finish`);

    for (const path of expected) {
      assert.ok(existsSync(join(dir, ...path.split('/'))), `${target}: the build did not produce ${path}`);
    }

    // The scripts the target's own README tells the user to run have to exist under those exact names — the
    // README is generated from this same table, so a missing one is a document describing a different app.
    const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts;
    assert.ok(scripts.build && scripts.dev && scripts.typecheck, `${target}: the base scripts must survive`);
    assert.ok(scripts.start ?? scripts.preview ?? scripts.deploy, `${target}: a target has to offer at least one way to run or ship what it built`);
  }
});
