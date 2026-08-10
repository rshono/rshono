import type { Feature } from './features/index.js';
import type { Answers } from './options.js';
import type { PackageManager } from './pm.js';
import { deployStep, scriptTable } from './scripts.js';

/**
 * The substitutions applied to every template file. Deliberately a handful of scalars: anything that
 * needs a *branch* is a separate file in an overlay, so template files stay valid TypeScript, CSS and
 * JSON that an editor can check and a formatter can format.
 */
export type Tokens = Record<string, string>;

/**
 * `{{NAME}}`, deliberately not `__NAME__`: templates are real files that real tools run over, and in
 * markdown `__NAME__` *is* strong emphasis — Prettier rewrites it to `**NAME**` and the token stops
 * matching. `{{…}}` means nothing to any format these templates are written in.
 */
const TOKEN_PATTERN = /\{\{[A-Z][A-Z\d_]*\}\}/g;

export function tokensFor(answers: Answers, features: Feature[], pm: PackageManager): Tokens {
  return {
    '{{PROJECT_NAME}}': answers.packageName,
    '{{DEPLOY_TARGET}}': answers.deploy,
    // Derived from the features rather than the answers, because all three are about the scripts the app
    // actually got: its command table, the one command that ships it, and what its platform asks for.
    '{{SCRIPT_TABLE}}': scriptTable(answers, features, pm),
    '{{DEPLOY_STEP}}': deployStep(features, pm),
    '{{PLATFORM_SETUP}}': features.map((feature) => feature.platformSetup ?? '').join(''),
  };
}

/**
 * Substitutes tokens, and throws on one it doesn't know — a typo in a template would otherwise ship a
 * literal `{{PORJECT_NAME}}` into somebody's new app, which no test of the generator's logic would
 * catch.
 */
export function render(contents: string, tokens: Tokens, source: string): string {
  return contents.replace(TOKEN_PATTERN, (token) => {
    const value = tokens[token];
    if (value === undefined) throw new Error(`[create-rshono] ${source} uses unknown template token ${token}`);
    return value;
  });
}
