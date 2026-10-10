import type { PageProps } from '@rshono/core';
import { HydrationProbe } from './hydration-probe';
import { Layout } from './layout';

/**
 * The starting page for the cancelled-navigation test: a link to the slow-shell page, and a same-page anchor
 * to cancel that navigation with once its fetch is on the wire. See navigation-transition.spec.mjs.
 */
export default function SlowShellSource(_props: PageProps) {
  return (
    <Layout title="Slow shell source — rshono">
      <HydrationProbe name="slowShellSourceHydrated" />
      <div className="page">
        <p data-slow-shell-source>source</p>
        <a href="/slow-shell">slow</a>
        <a href="/slow-shell?again">again</a>
        <a href="#anchor">anchor</a>
        <div id="anchor">anchor target</div>
      </div>
    </Layout>
  );
}
