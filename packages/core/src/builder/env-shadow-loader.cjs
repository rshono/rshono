'use strict';

/** Whitespace and comments — what may sit before or between directives without ending the prologue. */
const TRIVIA = '(?:\\s|//[^\\n]*(?:\\n|$)|/\\*[\\s\\S]*?\\*/)*';
/** One directive: `'use strict'`, `"use client"`, `'use server'`. The backreference keeps the quotes matched. */
const DIRECTIVE = '([\'"])use [a-z -]+\\1\\s*;?';

/**
 * The whole directive prologue, so the prelude below is inserted *after* every directive rather than after the
 * first one.
 *
 * The repetition is load-bearing. A module with two directives — `"use strict"` beside `'use client'`, which is
 * ordinary output from a published component library, in either order — would otherwise take the prelude
 * *between* them, and a directive preceded by a statement is just an expression: whichever came second would
 * silently stop being a directive. That was survivable while this loader only saw the app's own hand-written
 * source, where `'use client'` comes first and alone; it stopped being survivable when the rule widened to
 * cover `node_modules` (see the SSR-layer rule in `rspack-config.ts`).
 *
 * Each repetition has to consume a whole directive, so the nested quantifiers cannot loop on an empty match.
 */
const DIRECTIVE_PROLOGUE = new RegExp(`^${TRIVIA}(?:${DIRECTIVE}${TRIVIA})*`);

/**
 * The gate: a standalone `process` identifier anywhere in the module, not the literal text `process.env`.
 *
 * The prelude replaces the whole `process` *binding*, so every way of reaching the env through that binding is
 * covered once it is emitted — but a gate on `process.env` only ever saw one of them:
 *
 * | source shape                            | `process.env` | this |
 * | --------------------------------------- | ------------- | ---- |
 * | `process.env.DATABASE_URL`              | yes           | yes  |
 * | `const { DATABASE_URL } = process.env`  | yes           | yes  |
 * | `process?.env.DATABASE_URL`             | **no**        | yes  |
 * | `process['env'].DATABASE_URL`           | **no**        | yes  |
 * | `const { env } = process`               | **no**        | yes  |
 * | `const p = process; p.env.DATABASE_URL` | **no**        | yes  |
 *
 * `process?.env` is not a contrived shape — it is how env access is written in code meant to run in a browser
 * and on a server, which is exactly what a `'use client'` component is. Every "no" above rendered a secret into
 * the SSR'd HTML while the browser bundle saw the `PUBLIC_`-only view.
 *
 * `\b` on both sides, so `preprocess`, `processEnv` and `child_process` do not drag the prelude in. The cost of
 * being wrong either way is only bytes: a module that mentions `process` in a comment gets a prelude it does
 * not need.
 *
 * The one shape this cannot cover is a module that declares its own module-scope `process` binding — the
 * prelude would be a redeclaration, and the build fails on it rather than shipping. Naming a module-scope
 * binding after a well-known global is what has to give.
 */
const MENTIONS_PROCESS = /\bprocess\b/;

/**
 * A read of `process` through the global object rather than through the binding — `globalThis.process.env`,
 * `globalThis?.process`, `global['process']`, and the `self` spelling Workers use.
 *
 * A prelude declares a module-scoped binding, so it cannot reach any of these: `globalThis.process` is the real
 * `process` however the module names it. `typeof globalThis.process !== 'undefined' && …` is a real isomorphic
 * idiom, so this is worth saying out loud rather than leaving to be discovered in a rendered page — but only
 * for the app's own source, since a library feature-detecting `globalThis.process?.env?.NODE_ENV` is doing
 * nothing wrong and has no app secret to read.
 */
const GLOBAL_PROCESS = /\b(?:globalThis|global|self)\s*(?:\?\.|\.)?\s*(?:process\b|\[\s*(['"`])process\1\s*\])/;

/**
 * Shadows `process.env` with the PUBLIC_-only view inside SSR-layer modules, so a secret read from a
 * `'use client'` component renders empty on the server rather than leaking into the HTML stream — and SSR
 * keeps agreeing with hydration, which sees the same view via DefinePlugin.
 *
 * A security control, so it fails the build rather than passing source through when it cannot confirm a
 * module's layer: `_module` is a private Rspack field, and a silent no-op if it were renamed would drop the
 * guarantee with nothing to notice.
 */
module.exports = function envShadowLoader(source) {
  // Two steps rather than the regex alone: this loader sees every module in the bundle, and most of them do
  // not contain the substring at all, which `includes` settles far more cheaply than a scan for word breaks.
  if (!source.includes('process') || !MENTIONS_PROCESS.test(source)) return source;
  const { prelude, layer, appSrcPrefix } = this.getOptions();
  if (!this._module) {
    throw new Error(
      "[rshono] env-shadow-loader could not read the module's layer (Rspack's `this._module` is unavailable). " +
        'That check is what keeps server secrets out of SSR-rendered client components, so the build is failed ' +
        'instead of shipping without it. This is a framework/Rspack incompatibility — please report it.',
    );
  }
  if (this._module.layer !== layer) return source;

  if (appSrcPrefix && this.resourcePath?.startsWith(appSrcPrefix) && GLOBAL_PROCESS.test(source)) {
    // Rspack prints the module path ahead of this, so the message is only the part it does not know.
    this.emitWarning(
      new Error(
        '[rshono] This module reads `process` through the global object. It is rendered on the server as part ' +
          'of a client component, where `process.env` is shadowed with the `PUBLIC_`-only view — and that ' +
          'shadow is a binding, so it cannot cover `globalThis.process`. A variable read that way is the real ' +
          'one, and it ends up in the HTML. Read `process.env` directly instead.',
      ),
    );
  }

  const prologue = source.match(DIRECTIVE_PROLOGUE)[0];
  return prologue + prelude + source.slice(prologue.length);
};
