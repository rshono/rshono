// `rshono start` decides, from what is on disk, whether it can run the build at all.
//
// The gate reads two files, so the fixtures are written directly rather than produced by building the
// testbed once per platform — the same assertions, without six production builds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const CLI = fileURLToPath(new URL('../bin/rshono.mjs', import.meta.url));

const start = (cwd, { env = {}, args = [] } = {}) =>
  spawnSync(process.execPath, [CLI, 'start', ...args], { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });

/**
 * A project directory holding what `rshono start` inspects: the server bundle it would spawn, and the
 * marker `rshono build` leaves recording which platform produced it. `deploy: null` writes no marker,
 * standing in for a build from a version of rshono that predates it.
 */
function projectWith({ deploy, bundle = 'process.exit(0);\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rshono-start-'));
  mkdirSync(join(dir, 'dist', 'server'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'server', 'main.mjs'), bundle);
  if (deploy) writeFileSync(join(dir, 'dist', 'rshono-build.json'), JSON.stringify({ deploy }));
  return dir;
}

describe('`rshono start` refuses what it cannot run', () => {
  test('a build made for a platform, which has no listener in it and would exit silently', () => {
    const result = start(projectWith({ deploy: 'cloudflare' }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /targets cloudflare/);
    assert.match(result.stderr, /wrangler deploy/, 'names the command that does deploy it');
    assert.match(result.stderr, /--deploy node/, 'and how to get a build it can run');
  });

  test('no build at all, naming the command that makes one', () => {
    const result = start(mkdtempSync(join(tmpdir(), 'rshono-unbuilt-')));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no production build found/);
    assert.match(result.stderr, /rshono build/);
  });
});

describe('`rshono start` runs what it can', () => {
  test('a node build', () => {
    const result = start(projectWith({ deploy: 'node' }));
    assert.equal(result.status, 0, result.stderr);
  });

  // Refusing a build that would have worked is worse than the confusing failure the marker guards
  // against, so an absent one is not treated as a refusal.
  test('a build with no marker, rather than refusing one that predates it', () => {
    const result = start(projectWith({ deploy: null }));
    assert.equal(result.status, 0, result.stderr);
  });

  test('and exits with the bundle when it stops', () => {
    const result = start(projectWith({ deploy: 'node', bundle: 'process.exit(3);\n' }));
    assert.equal(result.status, 3, 'the exit code is the app’s, not swallowed');
  });
});

// The port is settled twice — once by the CLI, which puts it in the environment, and once by the bundle,
// which binds it — so the two readings have to agree. `parsePort` is the single reading (unit-tested in
// test/unit.test.mjs); these cover the CLI half: what it refuses, and what it hands on untouched.
describe('`rshono start` and the port', () => {
  /** A bundle that reports the environment the CLI left it, instead of binding anything. */
  const echoPort = 'console.log("PORT=" + JSON.stringify(process.env.PORT));\n';

  test('leaves an empty PORT alone, for the bundle to read as unset', () => {
    const result = start(projectWith({ deploy: 'node', bundle: echoPort }), { env: { PORT: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PORT=""/, 'not rewritten to 0 — that would bind a random port and report success');
  });

  test('passes a valid PORT and --port through, the flag winning', () => {
    const project = projectWith({ deploy: 'node', bundle: echoPort });
    assert.match(start(project, { env: { PORT: '4000' } }).stdout, /PORT="4000"/);
    assert.match(start(project, { env: { PORT: '4000' }, args: ['--port', '8080'] }).stdout, /PORT="8080"/);
    assert.match(start(project, { env: { PORT: '0' } }).stdout, /PORT="0"/, 'an explicit 0 means "any free port"');
  });

  for (const [label, value] of [
    ['not a number', 'abc'],
    ['out of range', '999999'],
  ]) {
    test(`refuses a PORT that is ${label}, before anything binds`, () => {
      const result = start(projectWith({ deploy: 'node', bundle: echoPort }), { env: { PORT: value } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /rshono: invalid PORT/, 'reported like every other bad CLI input');
      assert.match(result.stderr, /0 and 65535/, 'and says what a port is');
      assert.doesNotMatch(result.stderr, /\n\s+at /, 'one line, not a RangeError with a bundler frame in it');
      assert.doesNotMatch(result.stdout, /PORT=/, 'the bundle never ran');
    });

    test(`refuses a --port that is ${label}`, () => {
      const result = start(projectWith({ deploy: 'node', bundle: echoPort }), { args: ['--port', value] });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /rshono: invalid --port/);
    });
  }

  test('hands HOST to the bundle, which is the command it belongs to', () => {
    // The counterpart to the `rshono dev` warning: `start` is where `HOST` does something, and it reaches
    // the bundle as the environment variable the listener reads.
    const bundle = 'console.log("HOST=" + JSON.stringify(process.env.HOST));\n';
    assert.match(start(projectWith({ deploy: 'node', bundle }), { env: { HOST: '0.0.0.0' } }).stdout, /HOST="0\.0\.0\.0"/);
  });
});

describe('HOST belongs to `start`, and `dev` says so', () => {
  // `cli/index.ts` reads `HOST` for both, but `DevOptions` has no `host` field and `dev.ts` binds
  // `hostname: '127.0.0.1'` unconditionally — a structural drop, not a conditional one. Binding dev to
  // loopback is right (its source maps embed `'use server'` source); doing it in silence was not, with the
  // README listing `HOST` under all three commands.
  //
  // Run in an empty directory, so `dev` fails on the missing `src/routes.ts` a moment later and the command
  // exits instead of serving. The warning is printed before that, which is the whole point: it comes from
  // the dispatch, ahead of anything dev does.
  const dev = (env) =>
    spawnSync(process.execPath, [CLI, 'dev'], {
      cwd: mkdtempSync(join(tmpdir(), 'rshono-nohost-')),
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, ...env },
    });

  test('warns that `rshono dev` ignores it', () => {
    const result = dev({ HOST: '0.0.0.0' });
    assert.match(result.stderr, /HOST is ignored by `rshono dev`/, 'setting it must not be a silent no-op');
    assert.match(result.stderr, /always binds 127\.0\.0\.1/, 'and the message has to say what it does instead');
    assert.match(result.stderr, /applies to `rshono start`/, 'and where the variable does work');
  });

  test('says nothing when it is not set', () => {
    assert.doesNotMatch(dev({ HOST: undefined }).stderr, /HOST/, 'a warning nobody asked for is noise on every dev start');
  });

  test('is listed in the help, where it was missing entirely', () => {
    const help = spawnSync(process.execPath, [CLI, '--help'], { cwd: tmpdir(), encoding: 'utf8', timeout: 30_000 });
    assert.match(help.stdout, /HOST\s+address `start` binds to/, 'the one setting with no flag needs the help to mention it');
  });
});

describe('the CLI reports a bad flag the way it reports every other bad input', () => {
  // `parseArgs` was the first statement of `main()` with nothing between it and the `main().catch` that
  // prints the raw error object, so a typo'd flag — the likeliest of the three bad inputs — answered with a
  // nine-frame `ERR_PARSE_ARGS_UNKNOWN_OPTION` stack while an unknown command and an unparseable `--port`
  // each answered with a sentence. Run from a directory with no project in it: this has to be refused
  // before anything is loaded, so there is nothing for the command to need.
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: tmpdir(), encoding: 'utf8', timeout: 30_000 });

  for (const [what, args, expected] of [
    ['an unknown long flag', ['build', '--porf', '3000'], /rshono: Unknown option '--porf'/],
    ['an unknown short flag', ['build', '-z'], /rshono: Unknown option '-z'/],
    ['a flag missing its value', ['start', '--port'], /rshono: Option '-p, --port <value>' argument missing/],
    ['a value given to a boolean flag', ['build', '--help=x'], /rshono: Option '-h, --help' does not take an argument/],
  ]) {
    test(`refuses ${what}`, () => {
      const result = cli(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected, 'one line naming the flag, like `rshono: unknown command` beside it');
      assert.doesNotMatch(result.stderr, /\n\s+at /, 'and no stack: node:internal frames are not the user’s to read');
      assert.match(result.stdout, /Usage:\n {2}rshono dev/, 'with the help beneath it, which is where the real flags are listed');
    });
  }
});
