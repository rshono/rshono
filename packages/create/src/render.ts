import type { Feature } from './features/index.js';
import type { Answers } from './options.js';
import type { PackageManager } from './pm.js';
import { deployStep, scriptTable } from './scripts.js';

/**
 * The substitutions applied to every template file. A handful of scalars on purpose: anything needing a *branch*
 * is a separate file in an overlay, so templates stay valid TypeScript, CSS and JSON that tools can check.
 */
export type Tokens = Record<string, string>;

/**
 * `{{NAME}}`, not `__NAME__`: in markdown the latter is strong emphasis, so Prettier rewrites it to `**NAME**`
 * and the token stops matching. `{{…}}` means nothing to any format these templates are written in.
 */
const TOKEN_PATTERN = /\{\{[A-Z][A-Z\d_]*\}\}/g;

export function tokensFor(answers: Answers, features: Feature[], pm: PackageManager): Tokens {
  return {
    '{{PROJECT_NAME}}': answers.packageName,
    '{{DEPLOY_TARGET}}': answers.deploy,
    // From the features rather than the answers, because all three are about the scripts the app actually got.
    '{{SCRIPT_TABLE}}': scriptTable(answers, features, pm),
    '{{DEPLOY_STEP}}': deployStep(features, pm),
    '{{PLATFORM_SETUP}}': features.map((feature) => feature.platformSetup ?? '').join(''),
  };
}

/**
 * Substitutes tokens, and throws on one it does not know — a typo in a template would otherwise ship a literal
 * `{{PORJECT_NAME}}` into somebody's new app, which no test of the generator's logic would catch.
 */
export function render(contents: string, tokens: Tokens, source: string): string {
  return contents.replace(TOKEN_PATTERN, (token) => {
    const value = tokens[token];
    if (value === undefined) throw new Error(`[create-rshono] ${source} uses unknown template token ${token}`);
    return value;
  });
}
