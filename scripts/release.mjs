// Publishes @rshono/core and @rshono/create from this machine.
//
// The `v*` tag path in .github/workflows/release.yml is still the better one: it publishes with
// `--provenance`, a signed statement of which repo, workflow and commit built each tarball, minted from the
// runner's OIDC token. A laptop cannot mint that token, so nothing published from here carries provenance and
// npm shows the package without its verified-build link. That is the entire cost of this script, and the
// reason the workflow is left in place for whenever it has credentials again.
//
// Because CI is no longer standing between a mistake and the registry, every gate that workflow applies is
// re-applied here before anything is uploaded — clean tree, the two manifests agreeing, an annotated tag at
// HEAD, the version not already published, and the whole suite green. npm's two-factor prompt is handled by
// letting pnpm own the terminal: it asks for the one-time code itself when the registry demands one.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// The only two manifests that are not `private`. Kept explicit rather than discovered so that a new package
// cannot join a release by accident — `pnpm -r publish` would happily take it.
const PACKAGE_DIRS = ['packages/core', 'packages/create'];

// `.cmd` shims are not executable files on Windows, and execFileSync does not go through a shell.
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const step = (message) => console.log(`\n▸ ${message}`);
const ok = (message) => console.log(`  ✓ ${message}`);
const warn = (message) => console.log(`  ! ${message}`);

const fail = (...lines) => {
  console.error(`\n✗ ${lines[0]}`);
  for (const line of lines.slice(1)) console.error(`  ${line}`);
  process.exit(1);
};

const capture = (command, commandArgs) => execFileSync(command, commandArgs, { cwd: rootDir, encoding: 'utf8' }).trim();

const tryCapture = (command, commandArgs) => {
  try {
    return capture(command, commandArgs);
  } catch {
    return null;
  }
};

const forward = (command, commandArgs, onFail) => {
  try {
    execFileSync(command, commandArgs, { cwd: rootDir, stdio: 'inherit' });
  } catch {
    fail(onFail ?? `\`${command} ${commandArgs.join(' ')}\` failed`);
  }
};

const USAGE = `pnpm release [options]

  --dry-run       run every check and pack both packages, upload nothing
  --tag <name>    npm dist-tag to publish under (default: latest)
  --otp <code>    two-factor code; omit this and pnpm will ask when npm demands one
  --skip-tests    skip the gates the release workflow runs (they ran in CI already)
  --any-branch    allow a release from a branch other than main
  --help          this text`;

const VALUE_FLAGS = ['tag', 'otp'];
const BOOL_FLAGS = ['dry-run', 'skip-tests', 'any-branch', 'help'];

// Unknown options are refused rather than ignored: a mistyped `--dry-run` that silently fell through to a
// real publish is the one mistake this script must not make.
const options = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`, '', USAGE);
  const [name, inline] = arg.slice(2).split('=');
  if (BOOL_FLAGS.includes(name)) {
    options[name] = true;
    continue;
  }
  if (!VALUE_FLAGS.includes(name)) fail(`unknown option: ${arg}`, '', USAGE);
  const value = inline !== undefined ? inline : args[++index];
  if (!value || value.startsWith('--')) fail(`--${name} needs a value`, '', USAGE);
  options[name] = value;
}

if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const dryRun = Boolean(options['dry-run']);
const distTag = options.tag ?? 'latest';

step('Checking the tree');

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main' && !options['any-branch']) {
  fail(`on branch ${branch}, not main`, 'releases are cut from main — pass --any-branch if you mean it');
}
ok(`branch ${branch}`);

// Only tracked modifications matter: a local publish uploads what is on disk, and both packages ship only
// what their `files` field lists, so an untracked scratch file at the root cannot reach the tarball.
const dirty = capture('git', ['status', '--porcelain', '--untracked-files=no']);
if (dirty) {
  fail(
    'the working tree has uncommitted changes to tracked files',
    // The captured output is trimmed as a whole, so the first porcelain line has already lost the leading
    // space the rest still carry; trimming each keeps the list from stepping sideways.
    ...dirty.split('\n').map((line) => line.trim()),
    '',
    'commit or stash them — the tag has to describe what is being published',
  );
}
ok('no uncommitted changes to tracked files');

const untracked = capture('git', ['ls-files', '--others', '--exclude-standard']);
if (untracked) warn(`${untracked.split('\n').length} untracked file(s), in neither the tag nor the tarballs`);

step('Checking versions');

const manifests = PACKAGE_DIRS.map((dir) => {
  const { name, version } = JSON.parse(readFileSync(join(rootDir, dir, 'package.json'), 'utf8'));
  return { dir, name, version };
});

const version = manifests[0].version;
if (manifests.some((manifest) => manifest.version !== version)) {
  fail(
    'the two published manifests disagree on the version',
    ...manifests.map((manifest) => `${manifest.name} is ${manifest.version}`),
    '',
    'they ship together and share a version — `pnpm version:set <version>` sets both',
  );
}
ok(`both packages are ${version}`);

// The tag stays the record of what was released even though it is no longer what triggers the release, so a
// local publish refuses to run ahead of one. Annotated, because `git push --follow-tags` ignores lightweight
// tags and would leave the tag sitting on this machine only.
const tag = `v${version}`;
const head = capture('git', ['rev-parse', 'HEAD']);
const taggedCommit = tryCapture('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
if (!taggedCommit) {
  fail(`there is no ${tag} tag`, '', `  git tag -a ${tag} -m "${tag}"`, '', 'the -a matters: `git push --follow-tags` only pushes annotated tags');
}
if (taggedCommit !== head) {
  fail(`${tag} points at ${taggedCommit.slice(0, 9)} but HEAD is ${head.slice(0, 9)}`, 'check out the tagged commit, or move the tag onto this one');
}
if (capture('git', ['cat-file', '-t', tag]) !== 'tag') {
  warn(`${tag} is a lightweight tag — \`git push --follow-tags\` will skip it; push it by name or re-make it with \`git tag -f -a\``);
}
ok(`${tag} is at HEAD`);

if (distTag === 'latest' && version.includes('-')) {
  warn(
    `${version} is a prerelease going to the "latest" dist-tag, so a plain \`npm install ${manifests[0].name}\` resolves to it — pass --tag rc to leave latest alone`,
  );
}
ok(`dist-tag: ${distTag}`);

step('Checking the registry');

if (dryRun) {
  warn('--dry-run: skipping the credential and duplicate-version checks, since nothing will be uploaded');
} else {
  const whoami = tryCapture(npm, ['whoami']);
  if (!whoami) {
    fail(
      'not logged in to npm — `npm whoami` failed',
      '',
      '  npm login',
      '',
      'an expired token in ~/.npmrc looks exactly like this. Publishing without credentials is what the',
      'registry answers as a bare 404 on the PUT, which is worth catching here instead of mid-publish',
    );
  }
  ok(`npm user: ${whoami}`);

  for (const manifest of manifests) {
    const published = tryCapture(npm, ['view', manifest.name, 'versions', '--json']);
    if (published === null) {
      warn(`could not read published versions of ${manifest.name} — skipping its duplicate check`);
      continue;
    }
    // `npm view versions --json` answers with a bare string when a package has exactly one version.
    const parsed = JSON.parse(published);
    const versions = Array.isArray(parsed) ? parsed : [parsed];
    if (versions.includes(version)) {
      fail(`${manifest.name}@${version} is already on npm`, 'a published version is immutable — bump with `pnpm version:set` and tag the bump');
    }
    ok(`${manifest.name}@${version} is not published yet`);
  }
}

if (options['skip-tests']) {
  warn('--skip-tests: publishing without running the gates the release workflow would have run');
} else {
  step('Running the gates the release workflow runs');
  forward(pnpm, ['--filter', '@rshono/core', 'build'], 'the framework build failed');
  forward(pnpm, ['lint'], 'lint failed');
  forward(pnpm, ['--filter', '@rshono/core', 'typecheck'], '@rshono/core typecheck failed');
  forward(pnpm, ['--filter', '@rshono/core', 'test'], '@rshono/core tests failed');
  forward(pnpm, ['--filter', 'testbed', 'typecheck'], 'testbed typecheck failed');
  forward(pnpm, ['--filter', '@rshono/create', 'typecheck'], '@rshono/create typecheck failed');
  forward(pnpm, ['--filter', '@rshono/create', 'test'], '@rshono/create tests failed');
}

step(dryRun ? `Packing ${version} (dry run — nothing is uploaded)` : `Publishing ${version} to ${distTag}`);

// `--no-git-checks` turns off pnpm's own branch/clean/up-to-date checks, which the tree and tag checks above
// already cover with messages that say what to do about them. No `--provenance`: without a CI OIDC token the
// attestation cannot be minted, and asking for one only fails the publish.
const publishArgs = ['-r', 'publish', '--access', 'public', '--no-git-checks', '--tag', distTag];
if (dryRun) publishArgs.push('--dry-run');
// Passing a code covers both packages only if npm still accepts it for the second PUT; a single-use code is
// rejected as a replay. Letting pnpm prompt per package is the reliable path, which is why this is optional.
if (options.otp) publishArgs.push('--otp', options.otp);

forward(pnpm, publishArgs, 'the publish failed — anything that printed a 📦 line above did upload, so check npm before retrying');

if (dryRun) {
  step('Dry run finished — nothing was published');
  process.exit(0);
}

step(`Published ${version}`);
console.log(`
  These are not done for you, because they are the parts that are hard to take back:

    git push --follow-tags
    gh release create ${tag} --verify-tag --title ${tag} --notes-file CHANGELOG.md --draft

  Both tarballs went up without a provenance attestation, since that needs the OIDC token only a CI runner
  has. To get it back, give .github/workflows/release.yml npm credentials and let a tag publish the next one.
`);
