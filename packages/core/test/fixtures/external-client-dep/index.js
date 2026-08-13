'use strict';
'use client';

// Two directives, in the order a bundler's CommonJS-to-ESM output usually emits them, and deliberately so:
// the loader that rewrites `process.env` for the SSR layer inserts its prelude after the directive prologue,
// and inserting it after only the *first* directive would leave `'use client'` preceded by a statement — an
// ordinary expression rather than a directive. This file is the real-build half of that check; the regex
// itself is covered in test/unit.test.mjs.
//
// No JSX, because this is `node_modules` as far as the compiler is concerned and a published package ships
// compiled output. `createElement` is what JSX would have produced anyway.
import { createElement } from 'react';

/**
 * Reports what `process.env` looks like from a third-party client component.
 *
 * The point is where it is read from, not what it renders. A `'use client'` module is SSR'd on the server,
 * where the real environment is in scope — so without the env shadow covering `node_modules`, the secret
 * below is rendered into the HTML stream, and hydration then disagrees with it because the browser bundle
 * saw the `PUBLIC_`-only view.
 */
export function ExternalEnvProbe() {
  // `process.env` and nothing else off `process`. A client component runs in the browser too, where there is no
  // `process` at all and only this exact expression is substituted — `process.platform` here would compile to a
  // live reference and throw `ReferenceError: process is not defined` on hydration. (It did: that is what
  // `no unguarded reference to process survives into the client bundle` in prod.test.mjs now pins.) The
  // prelude's other half — that everything except `env` stays reachable through the prototype chain — is a
  // server-side property, and is tested against the prelude itself in unit.test.mjs.
  const secret = process.env.DATABASE_URL ?? '(no secret)';
  const publicValue = process.env.PUBLIC_API_ENDPOINT ?? '(no public value)';
  return createElement('p', { 'data-external-env': '' }, `external secret: ${secret} | external public: ${publicValue}`);
}
