'use client';

/**
 * Throws on the server and renders in the browser, which is the one failure `onShellError`'s name
 * describes: the RSC render is clean, its payload is fine, and the SSR pass is what blows up. Reached at
 * `/crash?ssr=1`.
 *
 * It exists to keep the framework's `source: 'ssr'` report reachable. Every other way to fail SSR is a
 * fault the RSC layer already reported, and the framework now declines to report those a second time — so
 * without this fixture that whole source could go dead and no test would notice.
 */
export function SsrCrash() {
  if (typeof window === 'undefined') throw new Error('Intentional SSR-only failure (client component).');
  return <p className="description">This one renders in the browser and throws on the server.</p>;
}
