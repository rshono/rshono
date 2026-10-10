import type { PageProps } from '@rshono/core';
import { Layout } from './layout';

/**
 * Delays the shell itself rather than a section below it, so the navigation's payload has not been handed to
 * React while the fetch is in flight — the state the cancelled-navigation test needs. Five seconds is far
 * longer than the test's click sequence, so the window cannot close underneath it. See
 * navigation-transition.spec.mjs.
 */
export default async function SlowShell(_props: PageProps) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return (
    <Layout title="Slow shell — rshono">
      <div className="page">
        <p data-slow-shell>slow shell loaded</p>
      </div>
    </Layout>
  );
}
