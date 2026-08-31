/**
 * A plain module with no directive of its own, pulled into the browser bundle by the `'use client'`
 * component that imports it — so it is SSR'd in the layer the env shadow covers.
 *
 * Three ways of reaching the same secret, none of them spelled the way the shadow used to be gated on: a
 * dotted read off the `process` binding. Each one used to render the real value into the HTML stream while
 * the browser bundle saw the `PUBLIC_`-only view — a leaked secret and a hydration mismatch at once. The
 * dotted spelling is covered by `counter.tsx` itself; this file deliberately never uses it.
 *
 * `typeof`-guarded because this module is in the browser bundle too, where there is no `process` at all and
 * these spellings compile to a live reference to it.
 */
export function readSecretFromHelper() {
  const onServer = typeof process !== 'undefined';
  const optional = onServer ? process?.env.DATABASE_URL : undefined;
  const computed = onServer ? process['env'].DATABASE_URL : undefined;
  const alias = onServer ? process : undefined;
  return optional ?? computed ?? alias?.env.DATABASE_URL ?? '(no secret)';
}
