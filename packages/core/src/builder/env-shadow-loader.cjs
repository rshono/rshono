'use strict';
const DIRECTIVE_PROLOGUE = /^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:(['"])use [a-z -]+\1\s*;?)?/;

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
