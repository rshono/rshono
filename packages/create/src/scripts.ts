// `features/types.js` rather than `features/index.js`: the deploy feature imports `invoke` from here, and
// going through the barrel would make that a cycle — types.ts imports nothing.
import type { Feature } from './features/types.js';
import type { Answers, DeployTargetName } from './options.js';
import type { PackageManager } from './pm.js';

/**
 * The scripts every app gets, whatever it targets.
 *
 * `start`, `preview` and `deploy` are not here: each means something different per platform, so the deploy
 * target contributes its own. The three names are a contract the targets keep, which is what lets the README
 * describe an app it was not written for:
 *
 * - **`start`** runs a build that already exists and never makes one — what a host's own start command calls.
 * - **`preview`** builds, then runs the result here, so the production build is answerable without deploying.
 * - **`deploy`** builds, then ships it — where the platform has one command that does the shipping.
 */
export const BASE_SCRIPTS: Record<string, string> = {
  dev: 'rshono dev',
  build: 'rshono build',
  typecheck: 'tsc --noEmit',
};

/**
 * Every script the app gets, in the order they are written: the base ones, then each feature's. The manifest and
 * the README's command table are both this, so neither can document a script the other lacks.
 */
export function buildScripts(features: Feature[]): Record<string, string> {
  const scripts: Record<string, string> = { ...BASE_SCRIPTS };
  for (const feature of features) Object.assign(scripts, feature.scripts);
  return scripts;
}

/** The gloss for each base script, in the README's command table. `build` names the target it is for. */
function baseScriptHelp(deploy: DeployTargetName): Record<string, string> {
  return {
    dev: 'dev server with HMR, http://localhost:3000',
    build: `production build for ${deploy}`,
    typecheck: 'tsc --noEmit',
  };
}

/**
 * Script names a package manager has a command of its own for: `pnpm deploy` runs pnpm's workspace-deploy and
 * never looks at the manifest. These get the explicit `run` form, which all four managers accept.
 */
const SHADOWED = new Set(['deploy']);

/** How to type one of the app's scripts with this package manager — `pnpm dev`, but `npm run dev`. */
export function invoke(pm: PackageManager, script: string): string {
  return `${SHADOWED.has(script) ? `${pm.name} run` : pm.run} ${script}`;
}

/**
 * The README's command table: one line per script, with the command to type and a one-line gloss. A script whose
 * feature supplies no `scriptHelp` is left out — that is how `format:check` stays out of a table about running
 * the app — and covered by the line pointing at `package.json`.
 */
export function scriptTable(answers: Answers, features: Feature[], pm: PackageManager): string {
  const help: Record<string, string> = baseScriptHelp(answers.deploy);
  for (const feature of features) Object.assign(help, feature.scriptHelp);

  const documented = Object.keys(buildScripts(features)).filter((name) => help[name]);
  const width = Math.max(...documented.map((name) => invoke(pm, name).length));
  return documented.map((name) => `${invoke(pm, name).padEnd(width)}  # ${help[name]}`).join('\n');
}

/**
 * The command that gets this app into production, as a sentence — the README's deploy step and the closing
 * summary's, so the two cannot name different commands.
 *
 * Read off the scripts rather than the target, so a target that gains a `deploy` gains the sentence with it.
 */
export function deployStep(features: Feature[], pm: PackageManager): string {
  const scripts = buildScripts(features);
  if (scripts.deploy) return `\`${invoke(pm, 'deploy')}\` does the build and the upload in one step.`;
  if (scripts.start) return `\`${invoke(pm, 'start')}\` runs that build wherever you host it, and never makes one.`;
  if (scripts.preview) return `\`${invoke(pm, 'preview')}\` runs the build here, so you can check it first.`;
  return `\`${invoke(pm, 'build')}\` produces it; getting it there is yours to script.`;
}
