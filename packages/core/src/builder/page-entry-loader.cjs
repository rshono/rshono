'use strict';

/** Whitespace and comments — what may sit before or between directives without ending the prologue. */
const TRIVIA = '(?:\\s|//[^\\n]*(?:\\n|$)|/\\*[\\s\\S]*?\\*/)*';
/**
 * A directive that is *not* one of the three the RSC compilers act on. `'use strict'` above all, which is
 * what a transpiler and many a published component library put at the top of a module; `'use cache'` and
 * whatever else React adds later fall here too, which is the point of writing this as "not those three"
 * rather than as a list.
 */
const OTHER_DIRECTIVE = '([\'"])use (?!(?:client|server|server-entry)\\1)[a-z -]+\\1\\s*;?';
/** One of the three. `\\2`, because {@link OTHER_DIRECTIVE} ahead of it owns group 1. */
const RSC_DIRECTIVE = '([\'"])use (?:client|server|server-entry)\\2\\s*;?';

/**
 * Whether the module already declares one of the three RSC directives — anywhere in its directive prologue,
 * which is the fix: this used to match only a directive that came *first*.
 *
 * A page opening `'use strict';` ahead of its `'use client';` therefore had `'use server-entry';` prepended,
 * and the injected directive is the one the compiler then acts on. Measured against a real build: a page
 * whose first line is `'use client'` fails with `assertPageModule`'s message, and the same page with
 * `'use strict'` above it exits 0 and ships — so the one directive the framework relies on to refuse a client
 * page was silently neutered, and the page failed inside React at request time instead.
 *
 * Structural rather than a substring test, so a comment that *mentions* `'use client'` — plausible at the top
 * of a page that used to be one — is consumed as trivia rather than read as a directive. And the same shape
 * as `env-shadow-loader.cjs`'s prologue match, which was widened for this exact class of module.
 */
const OPENS_WITH_DIRECTIVE = new RegExp(`^${TRIVIA}(?:${OTHER_DIRECTIVE}${TRIVIA})*${RSC_DIRECTIVE}`);

module.exports = function pageEntryLoader(source) {
  if (OPENS_WITH_DIRECTIVE.test(source)) return source;
  return "'use server-entry';" + source;
};
