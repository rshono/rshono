import type { Feature } from './features/index.js';
import type { Answers, DeployTargetName } from './options.js';
import type { PackageManager } from './pm.js';

/**
 * The scripts every app gets, whatever it targets.
 *
 * `start`, `preview` and `deploy` are deliberately not here: each one means something different per
 * platform, so the deploy target contributes its own. The three names are a contract the targets keep,
 * and the reason the README can describe an app it was not written for:
 *
 * - **`start`** runs a build that already exists and never makes one — what a Dockerfile's `CMD`, a
 *   systemd unit or a PaaS start command calls. Only the target that runs its own build has one.
 * - **`preview`** builds, then runs the result on this machine. For the targets whose build is not a
 *   server here, because "is the production build alright" is otherwise unanswerable without deploying.
 * - **`deploy`** builds, then ships it — for the platforms that have one command that does the shipping.
 */
export const BASE_SCRIPTS: Record<string, string> = {
  dev: 'rshono dev',
  build: 'rshono build',
  typecheck: 'tsc --noEmit',
};

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
 * Generated from the same two sources the manifest is assembled from — {@link BASE_SCRIPTS} and the
 * features — so the file cannot document a script the app does not have, or miss one it does. A script
 * whose feature supplies no `scriptHelp` is left out and covered by the "package.json has the rest"
 * line: that is how a formatter's `format:check` stays out of a table about running the app.
 */
export function scriptTable(answers: Answers, features: Feature[], pm: PackageManager): string {
  const scripts: Record<string, string> = { ...BASE_SCRIPTS };
  const help: Record<string, string> = baseScriptHelp(answers.deploy);
  for (const feature of features) {
    Object.assign(scripts, feature.scripts);
    Object.assign(help, feature.scriptHelp);
  }

  const documented = Object.keys(scripts).filter((name) => help[name]);
  const width = Math.max(...documented.map((name) => invoke(pm, name).length));
  return documented.map((name) => `${invoke(pm, name).padEnd(width)}  # ${help[name]}`).join('\n');
}

/**
 * The one command that gets this app into production, or `null` for the target whose upload is the user's
 * own to wire up. Decided once here because both the README and the closing summary name it, and they must
 * not name different things — each phrases it for where it appears.
 *
 * Read off the features rather than the target, so a target that gains a `deploy` gains the command with
 * it. `start` is the answer where there is no `deploy`: it does not ship anything itself, but it is what
 * the host will run, so it is the command the app hands over.
 */
export function shipCommand(features: Feature[], pm: PackageManager): { script: 'deploy' | 'start'; command: string } | null {
  const scripts = new Set(features.flatMap((feature) => Object.keys(feature.scripts ?? {})));
  for (const script of ['deploy', 'start'] as const) {
    if (scripts.has(script)) return { script, command: invoke(pm, script) };
  }
  return null;
}

/**
 * The deploy step as a sentence, for the README. The platform's own command is never repeated here — the
 * framework's hint on the line above is where it gets named, and saying it twice is how the two drift.
 */
export function deployStep(features: Feature[], pm: PackageManager): string {
  const ship = shipCommand(features, pm);
  if (ship?.script === 'deploy') return `\`${ship.command}\` does the build and the upload in one step.`;
  if (ship) return `\`${ship.command}\` runs that build wherever you host it, and never makes one.`;
  return `\`${invoke(pm, 'preview')}\` runs the same bundle on Node, so you can check it before you upload.`;
}
