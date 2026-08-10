import * as prompts from '@clack/prompts';
import { deployHint, type Answers } from './options.js';
import type { Plan } from './plan.js';
import type { PackageManager } from './pm.js';
import { invoke, shipCommand } from './scripts.js';

/**
 * The command that produces something shippable: `preview` where the target has one — it builds and runs
 * the result — and plain `build` for the target whose `start` already does the running.
 */
function checkStep(plan: Plan, pm: PackageManager): string {
  const hasPreview = plan.features.some((feature) => feature.scripts?.preview);
  return hasPreview ? `${invoke(pm, 'preview')} to run the production build` : `${pm.run} build`;
}

/**
 * And where it goes from there, in the words of the app's own scripts — falling back to the framework's
 * hint for the target that has no command to give, since that one is a sentence about the platform.
 */
function shipStep(answers: Answers, plan: Plan, pm: PackageManager): string {
  const ship = shipCommand(plan.features, pm);
  if (ship?.script === 'deploy') return `${ship.command} to ship it`;
  if (ship) return `${ship.command} on the host that runs it`;
  return deployHint(answers.deploy);
}

/**
 * What to do next, in the order to do it — the last thing the user reads, and for most people the only
 * documentation they will read today. `installed` decides whether the install step is still theirs.
 */
export function nextSteps(answers: Answers, plan: Plan, pm: PackageManager, options: { directory: string; installed: boolean }): string {
  const steps: string[] = [];
  if (options.directory !== '.') steps.push(`cd ${options.directory}`);
  if (!options.installed) steps.push(`${pm.name}${pm.install.length > 0 ? ` ${pm.install.join(' ')}` : ''}`);
  steps.push(`${pm.run} dev`);

  const lines = [steps.join('\n')];
  lines.push(`\nThen ${checkStep(plan, pm)}, and ${shipStep(answers, plan, pm)}.`);
  if (plan.notes.length > 0) lines.push(`\n${plan.notes.join('\n')}`);
  return lines.join('\n');
}

/** The one-line summary of what was chosen, for the run that answered everything from flags. */
export function summary(answers: Answers): string {
  const quality = [answers.formatter, answers.linter === answers.formatter ? null : answers.linter].filter((part) => part && part !== 'none');
  return [
    `deploy: ${answers.deploy}`,
    `styling: ${answers.styling === 'tailwind' ? 'Tailwind CSS' : 'plain CSS'}`,
    `quality: ${quality.length > 0 ? quality.join(' + ') : 'none'}`,
  ].join('  ·  ');
}

/** A cancelled prompt ends the run, rather than falling through to a default the user did not pick. */
export function unwrap<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) {
    prompts.cancel('Cancelled — nothing was written.');
    process.exit(130);
  }
  return value as T;
}
