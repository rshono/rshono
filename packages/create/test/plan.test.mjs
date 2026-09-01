// The generator, over the whole matrix of answers, in memory. `plan()` does no I/O beyond reading the
// templates, so every combination the CLI can produce is asserted here in milliseconds — which is the
// point of the plan/write split. What a real install and build make of the result is `e2e.test.mjs`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  DEPLOY_TARGET_NAMES,
  ESLINT_TYPESCRIPT,
  FRAMEWORK_DEPS,
  QUALITY_PRESETS,
  RSHONO_RANGE,
  detectPackageManager,
  isValidPackageName,
  packageManager,
  plan,
  selectFeatures,
  toPackageName,
} from '../dist/api.mjs';

const PACKAGE_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const TEMPLATES_DIR = join(PACKAGE_DIR, 'templates');
const pm = packageManager('pnpm', '11.9.0');

/** The answers a `--yes` run produces, with whatever the case under test overrides. */
function answers(overrides = {}) {
  return { packageName: 'my-app', deploy: 'node', styling: 'css', formatter: 'prettier', linter: 'oxlint', ...overrides };
}

/** Every combination the prompts can produce: each deploy target × 2 stylings × every quality preset. */
function* matrix() {
  for (const deploy of DEPLOY_TARGET_NAMES) {
    for (const styling of ['css', 'tailwind']) {
      for (const preset of QUALITY_PRESETS) {
        yield { deploy, styling, formatter: preset.formatter, linter: preset.linter, preset: preset.id };
      }
    }
  }
}

const REQUIRED = [
  'package.json',
  'tsconfig.json',
  'rshono.config.ts',
  '.gitignore',
  '.env',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'src/routes.ts',
  'src/components/home.tsx',
];

test('every combination produces a complete, parseable project', () => {
  for (const combination of matrix()) {
    const label = `${combination.deploy}/${combination.styling}/${combination.preset}`;
    const result = plan(answers(combination), pm);

    for (const path of REQUIRED) {
      assert.ok(result.files.has(path), `${label} is missing ${path}`);
    }

    const manifest = JSON.parse(result.files.get('package.json'));
    assert.equal(manifest.name, 'my-app', label);
    assert.equal(manifest.private, true, label);
    assert.equal(manifest.type, 'module', label);
    assert.equal(manifest.dependencies['@rshono/core'], RSHONO_RANGE, label);
    assert.ok(manifest.scripts.dev && manifest.scripts.build && manifest.scripts.typecheck, `${label} is missing a base script`);

    // A stray `{{TOKEN}}` in any file means a template referenced something `tokensFor` does not supply.
    for (const [path, contents] of result.files) {
      assert.doesNotMatch(contents, /\{\{[A-Z][A-Z\d_]*\}\}/, `${label}: unsubstituted token in ${path}`);
    }
  }
});

/*
 * The failure this exists for: a token that no longer *looks* like one. The tokens used to be `__NAME__`,
 * which in markdown is strong emphasis — so the repo's own `prettier --write .` rewrote the scaffolded
 * README's title to `**PROJECT_NAME**`, and every app created after that got a literal bold
 * "PROJECT_NAME" as its heading. Nothing above catches it: there is no token left to find unsubstituted.
 *
 * So this asserts on the substituted *values* instead, which is the only check a mangled delimiter cannot
 * pass. The delimiter is `{{…}}` now, which no formatter of any of these file types reinterprets.
 */
test('the scaffolded README is about the app, not about the template', () => {
  for (const deploy of DEPLOY_TARGET_NAMES) {
    const readme = plan(answers({ packageName: 'my-app', deploy }), pm).files.get('README.md');
    assert.match(readme, /^# my-app$/m, 'the title should be the project name');
    assert.match(readme, new RegExp(`^This app is built for \`${deploy}\`\\. .+\\.$`, 'm'), `${deploy}: the deploy step should be a sentence`);
    // The names of the tokens themselves, in any wrapping — `**PROJECT_NAME**` is how this last broke.
    assert.doesNotMatch(
      readme,
      /PROJECT_NAME|DEPLOY_TARGET|DEPLOY_HINT|PM_RUN|SCRIPT_TABLE|DEPLOY_STEP|PLATFORM_SETUP/,
      `${deploy}: a token name survived into the README`,
    );
  }
});

/*
 * The two agent files are only worth anything as a pair: CLAUDE.md carries no instructions of its own, so an
 * `@AGENTS.md` line that stopped being an import — moved inline, or renamed — would leave a Claude session
 * with a stub and nothing else. The URL is the other half: it is the only thing either file is really for.
 */
test('the agent files point at the framework docs, and CLAUDE.md at AGENTS.md', () => {
  const files = plan(answers({ packageName: 'my-app' }), pm).files;

  assert.match(files.get('AGENTS.md'), /^# my-app$/m, 'the title should be the project name');
  assert.match(files.get('AGENTS.md'), /https:\/\/www\.rshono\.com\/llms\.txt/, 'an agent has to be able to find the docs');
  assert.match(files.get('CLAUDE.md'), /^@AGENTS\.md$/m, 'Claude Code imports by `@path`, on a line of its own');
});

test('the plan is deterministic — same answers, byte-identical files', () => {
  const first = plan(answers({ deploy: 'cloudflare', styling: 'tailwind' }), pm);
  const second = plan(answers({ deploy: 'cloudflare', styling: 'tailwind' }), pm);
  assert.deepEqual([...first.files.entries()], [...second.files.entries()]);
});

test('the deploy target reaches the config, the scripts and the README', () => {
  for (const deploy of DEPLOY_TARGET_NAMES) {
    const result = plan(answers({ deploy }), pm);
    assert.match(result.files.get('rshono.config.ts'), new RegExp(`deploy: '${deploy}'`), deploy);
    assert.match(result.files.get('README.md'), new RegExp(`built for \`${deploy}\``), deploy);
  }
});

/** The scripts a target's app ends up with, rendered. */
function scriptsFor(deploy, manager = pm) {
  return JSON.parse(plan(answers({ deploy }), manager).files.get('package.json')).scripts;
}

/*
 * The three per-platform script names and what each one promises — the contract `scripts.ts` states and
 * every target has to keep, because the README describes them in words written once for all four.
 */
test('every deploy target keeps the start / preview / deploy contract', () => {
  // `start` runs a build that already exists, so only the target whose build *is* a server has one:
  // `rshono start` refuses a bundle made for anywhere else, and a script that always failed would be
  // worse than no script. (Bun and Deno had a target each and so a `start`; they run the `node` build now.)
  assert.equal(scriptsFor('node').start, 'rshono start');
  for (const deploy of ['cloudflare', 'vercel', 'aws-lambda']) {
    assert.equal(scriptsFor(deploy).start, undefined, `${deploy} cannot run its own build`);
  }

  // `preview` builds and then runs the result here, for the targets whose build is not a server on this
  // machine. `node` needs none: `build` then `start` is the same two steps under names it already has.
  assert.equal(scriptsFor('node').preview, undefined, 'build then start is already the preview');
  for (const deploy of ['cloudflare', 'vercel', 'aws-lambda']) {
    const { preview } = scriptsFor(deploy);
    assert.ok(preview?.startsWith('rshono build'), `${deploy}: preview should build first — got ${preview}`);
    // A target with no local runtime of its own previews the Node build, and has to ask for it explicitly:
    // `rshono start` refuses the platform bundle, so without the flag the script would never have worked.
    if (preview.includes('rshono start')) {
      assert.match(preview, /^rshono build --deploy node &&/, `${deploy}: previewing with rshono start needs the Node build`);
    }
  }

  // `deploy` where the platform has one command that ships a build, and only there. The Vercel CLI is not
  // a dependency, so its script names the runner that fetches it — one per package manager.
  assert.equal(scriptsFor('cloudflare').deploy, 'rshono build && wrangler deploy', 'wrangler is installed, so it is called directly');
  assert.equal(scriptsFor('aws-lambda').deploy, undefined, 'nothing there is one command this could guess at');
  for (const [name, dlx] of [
    ['npm', 'npx'],
    ['pnpm', 'pnpm dlx'],
    ['yarn', 'yarn dlx'],
    ['bun', 'bunx'],
  ]) {
    const script = scriptsFor('vercel', packageManager(name)).deploy;
    assert.equal(script, `rshono build && ${dlx} vercel deploy --prebuilt --prod`, `${name}: the deploy script has to be runnable`);
  }
});

/*
 * What the platform asks for is not what the scripts are. A host has a build field and a start or deploy
 * field of its own, and pasting the app's `deploy` script into the second one would build twice — so every
 * target spells those commands out separately, in the package manager the app got.
 *
 * Two things are asserted, for all four targets. That the block names *this* app's build command — and that
 * the four managers produce four different blocks, which is the check a hardcoded command cannot pass.
 */
test('every deploy target says what to type into the platform, in this app’s package manager', () => {
  /** The Deploying section down to the paragraph that is the same for every app. */
  const sectionFor = (deploy, manager) =>
    plan(answers({ deploy }), manager).files.get('README.md').split('## Deploying')[1]?.split('Change `deploy`')[0];

  for (const deploy of DEPLOY_TARGET_NAMES) {
    const sections = new Map();
    for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
      const section = sectionFor(deploy, packageManager(name));
      const build = name === 'npm' ? 'npm run build' : `${name} build`;
      assert.ok(section, `${name}/${deploy}: the README lost its Deploying section`);
      assert.ok(section.includes(build), `${name}/${deploy}: the platform's build command should be \`${build}\``);
      sections.set(name, section);
    }
    assert.equal(new Set(sections.values()).size, 4, `${deploy}: a hardcoded command would leave two managers identical`);
  }

  // The field each platform actually labels, so the block answers the question it exists for.
  const pnpmSection = (deploy) => sectionFor(deploy, pm);
  assert.match(pnpmSection('node'), /\*\*Start\*\* — `pnpm start`/, 'a host asks for a start command');
  assert.match(pnpmSection('cloudflare'), /\*\*Build command\*\* to `pnpm build`/, 'Workers Builds asks for that one');
  // Not a default worth omitting: Vercel detects `hono` in the dependencies and would apply the Hono preset.
  assert.match(pnpmSection('vercel'), /\*\*Framework Preset\*\* to\s+Other/, 'Vercel would otherwise detect Hono');
  assert.match(pnpmSection('aws-lambda'), /no settings page/, 'and AWS has none at all — say so rather than invent one');
});

/*
 * The README's command table is generated from the same scripts the manifest gets, and it is the part a
 * reader copies — so every line has to name a script that exists and be typeable exactly as printed.
 *
 * `pnpm deploy` is the trap this pins down: pnpm has a `deploy` command of its own and never looks at the
 * manifest, so a bare `pnpm deploy` would be a printed command that quietly does something else.
 */
test('the README’s command table is typeable, and lists exactly the scripts for running the app', () => {
  for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
    const manager = packageManager(name);
    for (const deploy of DEPLOY_TARGET_NAMES) {
      const label = `${name}/${deploy}`;
      const result = plan(answers({ deploy }), manager);
      const scripts = scriptsFor(deploy, manager);
      const table = result.files
        .get('README.md')
        .split('\n')
        .filter((line) => line.includes('  # '))
        .map((line) => line.split('  # ')[0].trimEnd());

      const documented = [];
      for (const command of table) {
        const script = command.split(' ').at(-1);
        documented.push(script);
        assert.ok(scripts[script], `${label}: the table documents "${script}", which the manifest has no script for`);
        const prefix = script === 'deploy' ? `${name} run` : manager.run;
        assert.equal(command, `${prefix} ${script}`, `${label}: as printed, this line does not run the script`);
      }

      // Running the app, and nothing else: the formatter and linter scripts are the README's "the rest".
      const expected = ['dev', 'build', 'typecheck', ...['start', 'preview', 'deploy'].filter((script) => scripts[script])];
      assert.deepEqual(documented, expected, `${label}: the table and the manifest disagree`);
    }
  }
});

test('Tailwind brings its own PostCSS pass — the framework has none', () => {
  const plain = plan(answers({ styling: 'css' }), pm);
  const tailwind = plan(answers({ styling: 'tailwind' }), pm);

  assert.ok(!plain.files.has('postcss.config.mjs'));
  assert.ok(tailwind.files.has('postcss.config.mjs'));
  assert.match(tailwind.files.get('src/styles.css'), /@import 'tailwindcss'/);

  // The rule in the `rspack` hook is what puts postcss-loader in front of Rspack's native CSS parser.
  assert.doesNotMatch(plain.files.get('rshono.config.ts'), /postcss-loader/);
  assert.match(tailwind.files.get('rshono.config.ts'), /rules!\.push\(\{ test: \/\\\.css\$\/i, use: \['postcss-loader'\], type: 'css\/auto' \}\)/);

  // Including the loader itself: rshono does not depend on postcss, so the app has to.
  const dev = JSON.parse(tailwind.files.get('package.json')).devDependencies;
  for (const name of ['tailwindcss', '@tailwindcss/postcss', 'postcss', 'postcss-loader']) {
    assert.ok(dev[name], `Tailwind needs ${name}`);
  }
  assert.ok(!JSON.parse(plain.files.get('package.json')).devDependencies.postcss, 'a plain-CSS app should install none of it');
});

test('the Tailwind rshono.config.ts is the base config plus the PostCSS hook', () => {
  // The Tailwind variant is a copy of the base config with an `rspack` hook added, so what can drift is a
  // setting written into one of them and not the other.
  const base = plan(answers({ styling: 'css' }), pm).files.get('rshono.config.ts');
  const tailwind = plan(answers({ styling: 'tailwind' }), pm).files.get('rshono.config.ts');

  const lines = base.split('\n').filter((line) => line.trim() && line.trim() !== '});');
  assert.ok(lines.length >= 3, 'the base config should still be an import and a `defineConfig` call');
  for (const line of lines) {
    assert.ok(tailwind.includes(line), `the Tailwind config has drifted — it is missing ${line.trim()}`);
  }
});

test('Biome answers both slots once, and steps around Tailwind CSS when both are chosen', () => {
  const biome = plan(answers({ formatter: 'biome', linter: 'biome' }), pm);
  const manifest = JSON.parse(biome.files.get('package.json'));
  assert.equal(Object.keys(manifest.devDependencies).filter((name) => name.includes('biome')).length, 1);
  assert.ok(manifest.scripts.format && manifest.scripts.lint, 'Biome should contribute both');
  assert.ok(!biome.files.has('.prettierrc.json'));

  // Biome's CSS parser rejects `@apply`, so the two together need stylesheets left out.
  assert.doesNotMatch(biome.files.get('biome.json'), /\*\.css/);
  const withTailwind = plan(answers({ formatter: 'biome', linter: 'biome', styling: 'tailwind' }), pm);
  assert.match(withTailwind.files.get('biome.json'), /!\*\*\/\*\.css/);
});

test('each quality preset brings its own config files and no other tool', () => {
  const configs = {
    'prettier-oxlint': ['.prettierrc.json', '.oxlintrc.json'],
    'prettier-eslint': ['.prettierrc.json', 'eslint.config.mjs'],
    biome: ['biome.json'],
    oxc: ['.oxfmtrc.json', '.oxlintrc.json'],
    none: [],
  };
  const all = new Set(Object.values(configs).flat());

  for (const preset of QUALITY_PRESETS) {
    const result = plan(answers({ formatter: preset.formatter, linter: preset.linter }), pm);
    for (const path of all) {
      const expected = configs[preset.id].includes(path);
      assert.equal(result.files.has(path), expected, `${preset.id} ${expected ? 'is missing' : 'should not ship'} ${path}`);
    }
  }
});

test('ESLint brings the TypeScript its parser accepts, and is the only preset that touches TypeScript', () => {
  const manifest = (overrides) => JSON.parse(plan(answers(overrides), pm).files.get('package.json'));
  const eslint = manifest({ formatter: 'prettier', linter: 'eslint' });

  for (const name of ['eslint', 'typescript-eslint', '@eslint/js', 'eslint-plugin-react-hooks']) {
    assert.ok(eslint.devDependencies[name], `the ESLint preset needs ${name}`);
  }
  assert.equal(eslint.scripts.lint, 'eslint .');

  // typescript-eslint reads the compiler API directly, and its peer range stops below 6.1 — a pin that
  // drifts above that is an app npm refuses to install, so the ceiling is the assertion.
  assert.equal(eslint.devDependencies.typescript, ESLINT_TYPESCRIPT);
  assert.match(ESLINT_TYPESCRIPT, /^~6\.0\.\d+$/, 'the pin has to stay inside >=4.8.4 <6.1.0');
  assert.notEqual(eslint.devDependencies.typescript, FRAMEWORK_DEPS.typescript, 'otherwise the pin is pointless');

  for (const preset of QUALITY_PRESETS.filter((entry) => entry.linter !== 'eslint')) {
    const other = manifest({ formatter: preset.formatter, linter: preset.linter });
    assert.equal(other.devDependencies.typescript, FRAMEWORK_DEPS.typescript, `${preset.id} should leave TypeScript alone`);
    assert.ok(!other.devDependencies.eslint, `${preset.id} should not ship ESLint`);
  }
});

test('"none" leaves the app without a formatter, a linter, or scripts for either', () => {
  const manifest = JSON.parse(plan(answers({ formatter: 'none', linter: 'none' }), pm).files.get('package.json'));
  assert.deepEqual(Object.keys(manifest.scripts), ['dev', 'build', 'typecheck', 'start']);
  assert.deepEqual(Object.keys(manifest.devDependencies), ['@types/node', '@types/react', 'typescript']);
});

/*
 * The half-answer the two axes make possible: `--formatter none --linter biome` has no formatter and a
 * `format` script all the same, because Biome is one tool and brings both halves whichever slot selected
 * it. So the scripts an app ends up with are the plan's answer, never the `formatter` answer read alone.
 */
test('a linter that also formats still contributes its format script', () => {
  const result = plan(answers({ formatter: 'none', linter: 'biome' }), pm);
  assert.ok(JSON.parse(result.files.get('package.json')).scripts.format, 'Biome brings a format script through the linter slot');
  assert.ok(
    result.features.some((feature) => feature.scripts?.format),
    'and the plan says so, not just the rendered manifest',
  );

  const neither = plan(answers({ formatter: 'none', linter: 'oxlint' }), pm);
  assert.ok(!neither.features.some((feature) => feature.scripts?.format), 'a linter that only lints contributes none');
});

test('the Node floor is the framework’s, not a copy of it', () => {
  const framework = JSON.parse(readFileSync(join(PACKAGE_DIR, '..', 'core', 'package.json'), 'utf8'));
  const manifest = JSON.parse(plan(answers(), pm).files.get('package.json'));
  assert.equal(manifest.engines.node, framework.engines.node, 'run `pnpm --filter @rshono/create codegen`');
});

test('a feature contributing gitignore lines gets them, under a heading naming it', () => {
  const gitignore = plan(answers({ deploy: 'cloudflare' }), pm).files.get('.gitignore');
  assert.match(gitignore, /# deploy-cloudflare\n\.wrangler\//);
  assert.doesNotMatch(plan(answers({ deploy: 'node' }), pm).files.get('.gitignore'), /wrangler/);
});

test('every overlay a feature names exists on disk', () => {
  for (const combination of matrix()) {
    for (const feature of selectFeatures(answers(combination), pm)) {
      for (const overlay of feature.overlays ?? []) {
        assert.ok(existsSync(join(TEMPLATES_DIR, overlay)), `${feature.id} names a missing overlay: templates/${overlay}`);
      }
    }
  }
});

test('the React pins are the ones the framework is tested against, not a copy that can drift', () => {
  const framework = JSON.parse(readFileSync(join(PACKAGE_DIR, '..', 'core', 'package.json'), 'utf8'));
  for (const [name, range] of Object.entries(FRAMEWORK_DEPS)) {
    assert.equal(range, framework.devDependencies[name], `${name} has drifted from packages/core — run \`pnpm --filter @rshono/create codegen\``);
  }
  // Exact, not caret: rshono's RSC internals are coupled across builds, and a generated app has no
  // workspace overrides to keep a single copy of React.
  assert.match(FRAMEWORK_DEPS.react, /^\d+\.\d+\.\d+$/);
  assert.match(FRAMEWORK_DEPS['react-dom'], /^\d+\.\d+\.\d+$/);
});

test('a pnpm app answers for the install scripts its deploy target brings, and says nothing otherwise', () => {
  // Unanswered, they fail `pnpm install` and every `pnpm dev` after it — a scaffold that cannot start.
  // wrangler is the only dependency a scaffold can pick up that has any: esbuild and workerd, both of
  // which merely unpack a binary an optional dependency already carries. Nothing rshono itself installs
  // has one, so an app that never chose Cloudflare has no question to answer and gets no file for it.
  const settings = (combination) => plan(answers(combination), packageManager('pnpm', '11.9.0')).files.get('pnpm-workspace.yaml');

  assert.equal(settings({ deploy: 'node' }), undefined, 'a target with no install scripts should not carry a file about them');

  const cloudflare = settings({ deploy: 'cloudflare' });
  assert.ok(cloudflare, 'a Cloudflare scaffold needs pnpm-workspace.yaml — pnpm 11 does not read these from package.json');
  assert.match(cloudflare, /^allowBuilds:\n {2}esbuild: false\n {2}workerd: false$/m, 'the deploy feature should contribute both of wrangler’s');

  for (const name of ['npm', 'yarn', 'bun']) {
    assert.ok(
      !plan(answers({ deploy: 'cloudflare' }), packageManager(name)).files.has('pnpm-workspace.yaml'),
      `${name} has no use for pnpm's settings file`,
    );
  }
});

test('packageManager is written only when the environment gave an exact version', () => {
  const withVersion = JSON.parse(plan(answers(), packageManager('pnpm', '11.9.0')).files.get('package.json'));
  assert.equal(withVersion.packageManager, 'pnpm@11.9.0');
  const without = JSON.parse(plan(answers(), packageManager('npm')).files.get('package.json'));
  assert.ok(!('packageManager' in without), 'a guessed version is worse than no field');
});

test('the package manager is read off npm_config_user_agent', () => {
  assert.deepEqual(detectPackageManager('pnpm/11.9.0 npm/? node/v22.14.0 darwin arm64'), {
    name: 'pnpm',
    version: '11.9.0',
    install: ['install'],
    run: 'pnpm',
    dlx: 'pnpm dlx',
  });
  assert.equal(detectPackageManager('bun/1.2.0 npm/? node/v22.0.0').name, 'bun');
  assert.equal(detectPackageManager('yarn/4.1.0').run, 'yarn');
  // Empty, not `undefined`: omitting the argument is what reads the real environment, so passing
  // `undefined` here would assert against whichever package manager happens to be running the tests.
  assert.equal(detectPackageManager('').name, 'npm', 'a bare `node bin/create-rshono.mjs` is an npm project');
  assert.equal(detectPackageManager('some-other-tool/1.0.0').name, 'npm', 'an unknown agent is not a package manager we can drive');
  assert.equal(detectPackageManager('pnpm/latest').version, undefined, 'a non-version is not a version');
});

test('a directory name becomes a package name npm will accept', () => {
  assert.equal(toPackageName('My App'), 'my-app');
  assert.equal(toPackageName('./nested/my-app'), 'my-app');
  assert.equal(toPackageName('my-app/'), 'my-app');
  assert.equal(toPackageName('@scope/pkg'), '@scope/pkg');
  assert.equal(toPackageName('  Spaced Out  '), 'spaced-out');
  assert.equal(toPackageName(''), null);
  assert.equal(toPackageName('///'), null);

  assert.ok(isValidPackageName('my-app'));
  assert.ok(isValidPackageName('@scope/pkg'));
  assert.ok(!isValidPackageName('My-App'));
  assert.ok(!isValidPackageName('.hidden'));
});

/*
 * The contract, held rather than restated: `toPackageName` says it returns a name npm will accept, and its
 * result now goes through `isValidPackageName` on the way out. It used to spell npm's rule again as a
 * character check per class, which left `_leading` coming back as itself — npm refuses a leading underscore
 * as it refuses a leading dot. Only the exported function was affected; the CLI called both and refused
 * correctly, which is why this is a contract test and not a bug report.
 */
test('every name toPackageName returns is one npm accepts', () => {
  const inputs = [
    'My App',
    './nested/my-app',
    'my-app/',
    '@scope/pkg',
    '@scope/_pkg',
    '  Spaced Out  ',
    '_leading',
    '__x__',
    'My_App',
    '.hidden',
    '.',
    './',
    '_',
    '@',
    '',
    '///',
    '~tilde',
    'ü'.repeat(300),
  ];
  for (const input of inputs) {
    const name = toPackageName(input);
    if (name === null) continue;
    assert.ok(isValidPackageName(name), `toPackageName(${JSON.stringify(input)}) returned ${JSON.stringify(name)}, which npm refuses`);
  }
  // And the ordinary underscore case still produces something usable rather than nothing.
  assert.equal(toPackageName('_leading'), 'leading');
});

/*
 * `dist/` is what `rshono build` writes and `.rshono/` is what `rshono dev` writes, and both hold generated
 * bundles: a linter that reads them reports on code nobody wrote, and `format` rewrites it. Prettier, oxfmt
 * and oxlint all honour `.gitignore`, which every scaffold carries — Biome does not, unless `vcs.enabled` and
 * `vcs.useIgnoreFile` are both set, and neither is. So its own config has to list them, and `.rshono` was
 * missing from it: after anyone ran `pnpm dev`, that app's `format:check` and `lint` failed.
 */
test('the generated output directories are out of every quality preset’s reach', () => {
  for (const combination of matrix()) {
    const label = `${combination.deploy}/${combination.styling}/${combination.preset}`;
    const result = plan(answers(combination), pm);

    // The one every tool but Biome reads. Split on either line ending and trimmed, because what this
    // asserts is which paths are ignored, not which bytes separate them: a Windows checkout applies git's
    // `core.autocrlf` on the way in, and splitting on '\n' alone left every entry as `dist/\r`.
    const ignored = new Set(
      result.files
        .get('.gitignore')
        .split(/\r?\n/)
        .map((line) => line.trim()),
    );
    for (const dir of ['dist/', '.rshono/']) {
      assert.ok(ignored.has(dir), `${label}: .gitignore should list ${dir}`);
    }

    const biome = result.files.get('biome.json');
    if (!biome) continue;
    const { includes } = JSON.parse(biome).files;
    for (const dir of ['dist', '.rshono']) {
      assert.ok(includes.includes(`!${dir}`), `${label}: biome.json does not read .gitignore, so it must exclude ${dir} itself`);
    }
  }
});
