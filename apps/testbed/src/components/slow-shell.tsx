import type { PageProps } from '@rshono/core';
import { Layout } from './layout';

/**
 * The destination of the cancelled-navigation tests. The five-second delay that keeps its payload unapplied
 * lives in the testbed's server middleware — see src/server.ts — not here: React flushes a page's root row as
 * soon as the render starts, so a delay in this component would still hand the streaming client a payload to
 * read. See navigation-transition.spec.mjs.
 */
export default function SlowShell(_props: PageProps) {
  return (
    <Layout title="Slow shell — rshono">
      <div className="page">
        <p data-slow-shell>slow shell loaded</p>
      </div>
    </Layout>
  );
}
