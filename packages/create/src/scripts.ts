// `features/types.js` rather than `features/index.js`: the deploy feature imports `invoke` from here, and
// going through the barrel would make that a cycle — types.ts imports nothing.
import type { Feature } from './features/types.js';
import type { Answers, DeployTargetName } from './options.js';
import type { PackageManager } from './pm.js';

/**
 * The scripts every app gets, whatever it targets.
 *
 * `start`, `preview` and `deploy` are deliberately not here: each one means something different per
 * platform, so the deploy target contributes its own. The three names are a contract the targets keep,
 * and the reason the README can describe an app it was not written for:
 *
 * - **`start`** runs a build that already exists and never makes one — what a host's own start command
 *   calls. Only the target whose build is a server has one.
 * - **`preview`** builds, then runs the result here — for the targets where that is not the same two
 *   commands, because otherwise the production build is unanswerable without deploying it.
 * - **`deploy`** builds, then ships it — where the platform has one command that does the shipping.
 */
export const BASE_SCRIPTS: Record<string, string> = {
  dev: 'rshono dev',
  build: 'rshono build',
  typecheck: 'tsc --noEmit',
};

/**
 * Every script the app gets, in the order they are written: the base ones, then each feature's, in the order
 * the features were selected. The manifest and the README's command table are both this, so neither can
 * document a script the other does not have.
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
 * Script names a package manager has a command of its own for. `pnpm deploy` runs pnpm's workspace-deploy
 * command and never looks at the manifest, so printing it would hand somebody a line that quietly does
 * something else. The explicit `run` form is what all four managers accept, so those names get it.
 */
const SHADOWED = new Set(['deploy']);

/** How to type one of the app's scripts with this package manager — `pnpm dev`, but `npm run dev`. */
export function invoke(pm: PackageManager, script: string): string {
  return `${SHADOWED.has(script) ? `${pm.name} run` : pm.run} ${script}`;
}

/**
 * The README's command table: one line per script, with the command to type and a one-line gloss.
 *
 * A script whose feature supplies no `scriptHelp` is left out and covered by the "package.json has the
 * rest" line — that is how a formatter's `format:check` stays out of a table about running the app.
 */
export function scriptTable(answers: Answers, features: Feature[], pm: PackageManager): string {
  const help: Record<string, string> = baseScriptHelp(answers.deploy);
  for (const feature of features) Object.assign(help, feature.scriptHelp);

  const documented = Object.keys(buildScripts(features)).filter((name) => help[name]);
  const width = Math.max(...documented.map((name) => invoke(pm, name).length));
  return documented.map((name) => `${invoke(pm, name).padEnd(width)}  # ${help[name]}`).join('\n');
}

/**
 * The command that gets this app into production, as a sentence — the README's deploy step, and the same
 * choice the closing summary makes, so the two cannot name different commands.
 *
 * Read off the scripts rather than the target, so a target that gains a `deploy` gains the sentence with it.
 * `start` is the answer where there is no `deploy`: it ships nothing itself, but it is what the host runs.
 */
export function deployStep(features: Feature[], pm: PackageManager): string {
  const scripts = buildScripts(features);
  if (scripts.deploy) return `\`${invoke(pm, 'deploy')}\` does the build and the upload in one step.`;
  if (scripts.start) return `\`${invoke(pm, 'start')}\` runs that build wherever you host it, and never makes one.`;
  // Every branch names a script the app has, so a target that contributes none of the three still reads true.
  if (scripts.preview) return `\`${invoke(pm, 'preview')}\` runs the build here, so you can check it first.`;
  return `\`${invoke(pm, 'build')}\` produces it; getting it there is yours to script.`;
}
