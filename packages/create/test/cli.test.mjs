// The wiring around the generator: argument parsing, the non-interactive path, and the two decisions
// that can destroy something the user already had — writing into a directory that is not empty, and
// resolving `.` against the current one. No installs here; `e2e.test.mjs` does that.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = join(fileURLToPath(import.meta.url), '..', '..', 'bin', 'create-rshono.mjs');
const workspace = mkdtempSync(join(tmpdir(), 'create-rshono-cli-'));
after(() => rmSync(workspace, { recursive: true, force: true }));

function create(args, { cwd = workspace } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** A subdirectory of the temp workspace, made fresh. */
function dir(name) {
  const path = join(workspace, name);
  mkdirSync(path, { recursive: true });
  return path;
}

test('--help and --version answer without writing anything', () => {
  const help = create(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.output, /Usage:/);
  assert.match(help.output, /--deploy/);

  const version = create(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.output.trim(), /^\d+\.\d+\.\d+/);
  assert.equal(readdirSync(workspace).length, 0, 'neither should create a project');
});

test('a bad flag value is refused, naming what is accepted', () => {
  const result = create(['app', '-y', '--deploy', 'heroku']);
  assert.equal(result.status, 1);
  assert.match(result.output, /--deploy must be one of: node, cloudflare/);
  assert.ok(!existsSync(join(workspace, 'app')));
});

test('contradicting flags are refused rather than silently ordered', () => {
  const result = create(['app', '-y', '--tailwind', '--no-tailwind']);
  assert.equal(result.status, 1);
  assert.match(result.output, /contradict/);
});

test('a mistyped flag says so and points at --help', () => {
  const result = create(['app', '-y', '--tailwnid']);
  assert.equal(result.status, 1);
  assert.match(result.output, /--tailwnid/, 'the message should name the flag that was not understood');
  assert.match(result.output, /--help/, "and where to find the ones that are — parseArgs' own message does not");
});

test('a target that exists and is not a directory is refused before anything is written', () => {
  writeFileSync(join(workspace, 'taken.txt'), 'mine\n');
  const result = create(['taken.txt', '-y', '--no-install', '--no-git']);
  assert.equal(result.status, 1);
  assert.match(result.output, /not a directory/, 'and not with a raw ENOTDIR from mkdir');
  assert.equal(readFileSync(join(workspace, 'taken.txt'), 'utf8'), 'mine\n');
});

test('--formatter and --linter each override half of --quality', () => {
  const result = create(['halves', '-y', '--quality', 'biome', '--linter', 'oxlint', '--no-install', '--no-git']);
  assert.equal(result.status, 0);

  const target = join(workspace, 'halves');
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.format, 'biome format --write .', 'the preset still chose the formatter');
  assert.equal(manifest.scripts.lint, 'oxlint', 'and the flag replaced only the linter');
  assert.ok(existsSync(join(target, '.oxlintrc.json')) && existsSync(join(target, 'biome.json')));
});

test('--dry-run lists the files and writes none of them', () => {
  const result = create(['dry-app', '-y', '--dry-run']);
  assert.equal(result.status, 0);
  assert.match(result.output, /src\/routes\.ts/);
  assert.match(result.output, /nothing was written/i);
  assert.ok(!existsSync(join(workspace, 'dry-app')));
});

test('a non-empty directory is refused, and --force is what overrides it', () => {
  const target = dir('occupied');
  writeFileSync(join(target, 'keep.txt'), 'mine\n');

  const refused = create(['occupied', '-y', '--no-install', '--no-git']);
  assert.equal(refused.status, 1, 'a non-interactive run must not write into an occupied directory');
  assert.match(refused.output, /not empty \(keep\.txt\) — pass --force/);
  assert.deepEqual(readdirSync(target), ['keep.txt'], 'nothing should have been written');

  const forced = create(['occupied', '-y', '--force', '--no-install', '--no-git']);
  assert.equal(forced.status, 0);
  assert.ok(existsSync(join(target, 'src', 'routes.ts')));
  assert.ok(existsSync(join(target, 'keep.txt')), 'a file we did not generate is left alone');
});

test('a directory holding only a repository or editor state counts as empty', () => {
  const target = dir('fresh-clone');
  mkdirSync(join(target, '.git'));
  mkdirSync(join(target, '.vscode'));

  const result = create(['fresh-clone', '-y', '--no-install', '--no-git']);
  assert.equal(result.status, 0, 'running `git init` before scaffolding should not need --force');
  assert.ok(existsSync(join(target, 'package.json')));
});

test('"." scaffolds into the current directory and takes its name', () => {
  const target = dir('named-from-cwd');
  const result = create(['.', '-y', '--no-install', '--no-git'], { cwd: target });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name, 'named-from-cwd');
  assert.doesNotMatch(result.output, /\bcd\b/, 'there is nowhere to cd to when the project is the current directory');
  assert.match(result.output, /(npm run|pnpm|yarn|bun) dev/, 'the next step is still to start it');
});

test('flags reach the generated project, with no prompt in a non-interactive run', () => {
  const result = create(['flagged', '-y', '--deploy', 'vercel', '--tailwind', '--quality', 'biome', '--no-install', '--no-git']);
  assert.equal(result.status, 0);

  const target = join(workspace, 'flagged');
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  assert.match(readFileSync(join(target, 'rshono.config.ts'), 'utf8'), /deploy: 'vercel'/);
  assert.ok(existsSync(join(target, 'postcss.config.mjs')));
  assert.ok(existsSync(join(target, 'biome.json')));
  assert.ok(manifest.devDependencies['@biomejs/biome'] && manifest.devDependencies.tailwindcss);
  // The closing summary points at the app's own script rather than restating the command inside it, and
  // the target's note is what explains the one flag that script cannot do without.
  assert.match(result.output, /npm run deploy/, 'the closing summary should say how to deploy it');
  assert.match(result.output, /--prebuilt uploads what rshono build assembled/, 'and why the flag is in the script');
});

test('--no-git leaves no repository, and the scaffold is not committed by accident', () => {
  const result = create(['ungit', '-y', '--no-install', '--no-git']);
  assert.equal(result.status, 0);
  assert.ok(!existsSync(join(workspace, 'ungit', '.git')));
});

test('the dotfiles a published tarball cannot carry arrive as dotfiles', () => {
  create(['dotfiles', '-y', '--no-install', '--no-git']);
  const target = join(workspace, 'dotfiles');
  for (const file of ['.gitignore', '.env', '.prettierrc.json', '.prettierignore', '.oxlintrc.json']) {
    assert.ok(existsSync(join(target, file)), `${file} should exist, un-underscored`);
  }
  assert.ok(!existsSync(join(target, '_gitignore')));
});

/*
 * `.` was special-cased as a literal, so `./` — the same directory, spelled the way a shell completes it —
 * missed the branch and reached `toPackageName('./')`, which strips the `./` and the trailing `/` and has
 * nothing left to name the package with. Resolving the path first answers for every spelling of it.
 */
test('every spelling of the current directory scaffolds into it and takes its name', () => {
  for (const [index, spelling] of ['.', './', 'sub/..'].entries()) {
    const target = dir(`cwd-spelling-${index}`);
    const result = create([spelling, '-y', '--no-install', '--no-git'], { cwd: target });
    assert.equal(result.status, 0, `"${spelling}" should scaffold into the current directory:\n${result.output}`);
    assert.equal(
      JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name,
      `cwd-spelling-${index}`,
      `"${spelling}" should take the directory's name`,
    );
  }
});

/*
 * A dry run writes nothing, so there is nothing for an existing file to conflict with — and the refusal's
 * advice (`--force`) described an action the user had not asked for. The check itself still stands for a run
 * that writes, which is the assertion that matters here.
 */
test('--dry-run reports the plan in a directory that is not empty, and a real run still refuses', () => {
  const target = dir('dry-in-occupied');
  writeFileSync(join(target, 'existing.txt'), 'mine\n');

  const dry = create(['dry-in-occupied', '-y', '--dry-run']);
  assert.equal(dry.status, 0, `a dry run writes nothing, so it has nothing to conflict with:\n${dry.output}`);
  assert.match(dry.output, /Dry run: nothing was written/);
  assert.doesNotMatch(dry.output, /--force/, 'the advice describes an action the user did not ask for');
  assert.deepEqual(readdirSync(target), ['existing.txt'], 'and it really wrote nothing');

  const real = create(['dry-in-occupied', '-y', '--no-install', '--no-git']);
  assert.equal(real.status, 1, 'the check still stands for a run that writes');
  assert.match(real.output, /"dry-in-occupied" is not empty \(existing\.txt\) — pass --force to scaffold into it anyway\./);
});
