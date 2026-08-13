'use strict';

/** Whitespace and comments — what may sit before or between directives without ending the prologue. */
const TRIVIA = '(?:\\s|//[^\\n]*(?:\\n|$)|/\\*[\\s\\S]*?\\*/)*';
/** One directive: `'use strict'`, `"use client"`, `'use server'`. The backreference keeps the quotes matched. */
const DIRECTIVE = "(['\"])use [a-z -]+\\1\\s*;?";

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
 * Shadows `process.env` with the PUBLIC_-only view inside SSR-layer modules, so a secret read from a
 * `'use client'` component renders empty on the server rather than leaking into the HTML stream — and SSR
 * keeps agreeing with hydration, which sees the same view via DefinePlugin.
 *
 * A security control, so it fails the build rather than passing source through when it cannot confirm a
 * module's layer: `_module` is a private Rspack field, and a silent no-op if it were renamed would drop the
 * guarantee with nothing to notice.
 */
module.exports = function envShadowLoader(source) {
  if (!source.includes('process.env')) return source;
  const { prelude, layer } = this.getOptions();
  if (!this._module) {
    throw new Error(
      "[rshono] env-shadow-loader could not read the module's layer (Rspack's `this._module` is unavailable). " +
        'That check is what keeps server secrets out of SSR-rendered client components, so the build is failed ' +
        'instead of shipping without it. This is a framework/Rspack incompatibility — please report it.',
    );
  }
  if (this._module.layer !== layer) return source;
  const prologue = source.match(DIRECTIVE_PROLOGUE)[0];
  return prologue + prelude + source.slice(prologue.length);
};
