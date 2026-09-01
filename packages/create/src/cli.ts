import * as prompts from '@clack/prompts';
import { basename, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hasGit, initRepo, isInsideRepo } from './git.js';
import {
  DEPLOY_TARGET_NAMES,
  FORMATTER_NAMES,
  LINTER_NAMES,
  PACKAGE_MANAGERS,
  QUALITY_PRESETS,
  toPackageName,
  type Answers,
  type DeployTargetName,
  type Formatter,
  type Linter,
  type QualityPreset,
  type Styling,
} from './options.js';
import { plan as buildPlan } from './plan.js';
import { detectPackageManager, packageManager, runInstall } from './pm.js';
import { nextSteps, summary, unwrap } from './ui.js';
import { RSHONO_VERSION } from './versions.js';
import { conflictingEntries, writePlan } from './write.js';

const DEFAULT_DIRECTORY = 'my-rshono-app';

/** Every accepted name comes from `options.ts`, so the help cannot promise one the validation refuses. */
const HELP = `create-rshono — scaffold a new rshono app

Usage:
  npx @rshono/create@latest [directory] [options]

Options:
  -y, --yes                accept the default for every question not given as a flag
  -d, --deploy <target>    ${DEPLOY_TARGET_NAMES.join(' | ')}
      --tailwind           Tailwind CSS (--no-tailwind for plain CSS)
      --quality <preset>   ${QUALITY_PRESETS.map((preset) => preset.id).join(' | ')}
      --formatter <name>   ${FORMATTER_NAMES.join(' | ')}      (overrides --quality)
      --linter <name>      ${LINTER_NAMES.join(' | ')}       (overrides --quality; eslint pins TypeScript 6)
      --pm <name>          ${PACKAGE_MANAGERS.join(' | ')}              (default: whatever ran this)
      --no-install         write the files and stop
      --no-git             do not initialize a repository
      --force              scaffold into a directory that is not empty
      --dry-run            list the files that would be written, and write nothing
  -h, --help               show this help
  -v, --version            print the version

Every question can be answered by a flag, and a non-interactive terminal implies --yes — so one command
scaffolds without prompting:

  npx @rshono/create@latest my-app -y --deploy cloudflare --tailwind --quality biome
`;

function fail(message: string): never {
  prompts.log.error(message);
  process.exit(1);
}

/** A flag's value, checked against what the option accepts — a typo should not become a silent default. */
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) fail(`--${flag} must be one of: ${allowed.join(', ')} (got "${value}")`);
  return value as T;
}

/** `--x` / `--no-x` pairs, since `parseArgs` has no notion of a negatable boolean. */
function tristate(on: boolean | undefined, off: boolean | undefined, flag: string): boolean | undefined {
  if (on && off) fail(`--${flag} and --no-${flag} contradict each other.`);
  if (on) return true;
  if (off) return false;
  return undefined;
}

/** `parseArgs` names an unknown flag but says nothing about what to do next; this points at `--help`. */
function parse() {
  try {
    return parseArgs({
      options: {
        yes: { type: 'boolean', short: 'y' },
        deploy: { type: 'string', short: 'd' },
        tailwind: { type: 'boolean' },
        'no-tailwind': { type: 'boolean' },
        quality: { type: 'string' },
        formatter: { type: 'string' },
        linter: { type: 'string' },
        pm: { type: 'string' },
        install: { type: 'boolean' },
        'no-install': { type: 'boolean' },
        git: { type: 'boolean' },
        'no-git': { type: 'boolean' },
        force: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\nRun with --help to see the options.`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parse();

  if (values.help) return console.log(HELP);
  if (values.version) return console.log(__CREATE_RSHONO_VERSION__);

  // A pipe, a CI job or an agent gets the defaults rather than a prompt nothing can answer. Both streams have to
  // be a terminal: the prompts draw on stdout but read from stdin.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !values.yes;

  const pmFlag = oneOf(values.pm, PACKAGE_MANAGERS, 'pm');
  const pm = pmFlag ? packageManager(pmFlag) : detectPackageManager();

  const deployFlag = oneOf(values.deploy, DEPLOY_TARGET_NAMES, 'deploy');
  const formatterFlag = oneOf(values.formatter, FORMATTER_NAMES, 'formatter');
  const linterFlag = oneOf(values.linter, LINTER_NAMES, 'linter');
  const qualityFlag = oneOf(
    values.quality,
    QUALITY_PRESETS.map((preset) => preset.id),
    'quality',
  );
  const tailwindFlag = tristate(values.tailwind, values['no-tailwind'], 'tailwind');
  const installFlag = tristate(values.install, values['no-install'], 'install');
  const gitFlag = tristate(values.git, values['no-git'], 'git');

  // The framework version, not this package's: it is the one the app gets pinned to. `--version` reports ours.
  prompts.intro(`create-rshono  ·  rshono ${RSHONO_VERSION}`);

  // ── Where ───────────────────────────────────────────────────────────────────────────────────────
  let directory = positionals[0];
  if (!directory) {
    directory = interactive
      ? unwrap(
          await prompts.text({
            message: 'Where should the app go?',
            placeholder: DEFAULT_DIRECTORY,
            defaultValue: DEFAULT_DIRECTORY,
            validate: (value) => (toPackageName(value || DEFAULT_DIRECTORY) ? undefined : 'That leaves nothing usable as a package name.'),
          }),
        )
      : DEFAULT_DIRECTORY;
  }

  const targetDir = resolve(process.cwd(), directory);
  // Resolved rather than compared as text: `.`, `./`, `foo/..` and the cwd's own absolute path all name this
  // directory, and its own basename is the only thing left to call the package. Matching the literal `'.'`
  // covered one spelling and left `./` failing on "does not give a usable npm package name".
  const intoCwd = targetDir === process.cwd();
  const packageName = toPackageName(intoCwd ? basename(targetDir) : directory);
  if (!packageName) fail(`"${directory}" does not give a usable npm package name.`);

  // Not under --dry-run: nothing is written, so there is nothing to conflict with, and the advice it would
  // give (`--force`) describes an action the user did not ask for.
  const conflicts = values['dry-run'] ? [] : conflictingEntries(targetDir);
  if (conflicts.length > 0 && !values.force) {
    const where = intoCwd ? 'this directory' : `"${directory}"`;
    const listed = `${conflicts.slice(0, 3).join(', ')}${conflicts.length > 3 ? ', …' : ''}`;
    if (!interactive) fail(`${where} is not empty (${listed}) — pass --force to scaffold into it anyway.`);

    const proceed = unwrap(await prompts.confirm({ message: `${where} is not empty (${listed}). Write into it anyway?`, initialValue: false }));
    if (!proceed) {
      prompts.cancel('Nothing was written.');
      process.exit(0);
    }
  }

  // ── What ────────────────────────────────────────────────────────────────────────────────────────
  let deploy: DeployTargetName = deployFlag ?? 'node';
  if (!deployFlag && interactive) {
    deploy = unwrap(
      await prompts.select({
        message: 'Where will it be deployed?',
        initialValue: deploy,
        options: DEPLOY_TARGET_NAMES.map((name) => ({ value: name, label: name })),
      }),
    );
  }

  let styling: Styling = tailwindFlag ? 'tailwind' : 'css';
  if (tailwindFlag === undefined && interactive) {
    styling = unwrap(
      await prompts.select({
        message: 'Styling?',
        initialValue: styling,
        options: [
          { value: 'css' as Styling, label: 'Plain CSS', hint: 'compiled natively, no PostCSS' },
          { value: 'tailwind' as Styling, label: 'Tailwind CSS', hint: 'adds postcss.config.mjs' },
        ],
      }),
    );
  }

  // One question instead of two; the axes stay independent underneath, and a `--formatter` or `--linter` flag
  // addresses either on its own.
  let preset: QualityPreset | undefined = QUALITY_PRESETS.find((candidate) => candidate.id === qualityFlag);
  if (!preset && !formatterFlag && !linterFlag) {
    const fallback = QUALITY_PRESETS[0];
    if (interactive) {
      const id = unwrap(
        await prompts.select({
          message: 'Formatting and linting?',
          initialValue: fallback.id,
          options: QUALITY_PRESETS.map((option) => ({ value: option.id, label: option.label, hint: option.hint })),
        }),
      );
      preset = QUALITY_PRESETS.find((candidate) => candidate.id === id);
    } else {
      preset = fallback;
    }
  }

  const formatter: Formatter = formatterFlag ?? preset?.formatter ?? 'none';
  const linter: Linter = linterFlag ?? preset?.linter ?? 'none';

  // ── How ─────────────────────────────────────────────────────────────────────────────────────────
  let install = installFlag ?? true;
  if (installFlag === undefined && interactive) {
    install = unwrap(await prompts.confirm({ message: `Install dependencies with ${pm.name}?`, initialValue: true }));
  }

  // Asked once, not once per use: this shells out to `git rev-parse`.
  const nested = isInsideRepo(process.cwd());
  let git = gitFlag ?? !nested;
  if (gitFlag === undefined && interactive) {
    git = unwrap(
      await prompts.confirm({
        message: nested ? 'Initialize a git repository? (this is already inside one)' : 'Initialize a git repository?',
        initialValue: !nested,
      }),
    );
  }

  const answers: Answers = { packageName, deploy, styling, formatter, linter };

  // ── Plan, then write ────────────────────────────────────────────────────────────────────────────
  const plan = buildPlan(answers, pm);

  if (values['dry-run']) {
    prompts.note([...plan.files.keys()].join('\n'), `${plan.files.size} files — ${summary(answers)}`);
    prompts.outro('Dry run: nothing was written.');
    return;
  }

  writePlan(plan, targetDir);
  prompts.log.success(`Created ${plan.files.size} files in ${relative(process.cwd(), targetDir) || '.'}  ·  ${summary(answers)}`);

  let installed = false;
  if (install) {
    prompts.log.step(`Installing dependencies with ${pm.name}…`);
    installed = runInstall(pm, targetDir);
    if (!installed) prompts.log.warn(`${pm.name} install failed — the files are all written, so run it yourself in the project.`);
  }

  if (git) {
    if (!hasGit(targetDir)) {
      prompts.log.warn('git was not found on PATH — skipped.');
    } else {
      const result = initRepo(targetDir);
      if (result === 'initialized') prompts.log.warn('Repository initialized, but the first commit failed — set git user.name and user.email.');
      if (result === 'failed') prompts.log.warn('git init failed — skipped.');
    }
  }

  prompts.note(nextSteps(answers, plan, pm, { directory, installed }), 'Next');
  prompts.outro('Happy building.');
}

main().catch((error) => {
  prompts.log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
