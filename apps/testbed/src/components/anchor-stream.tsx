import { Suspense } from 'react';
import type { PageProps } from '@rshono/core';
import { Layout } from './layout';

/**
 * A fragment target that only exists after the shell streams: the case a soft `#hash` navigation has to wait
 * for. The filler sits *below* the heading so `scrollIntoView()` has room to align it with the viewport top;
 * the header and shell above it keep "landed at the top" and "landed on the target" different positions, so a
 * test cannot pass because the page happened to be too short to scroll. See the streamed-anchor test in
 * client-runtime.spec.mjs.
 */
async function SlowTarget() {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return (
    <>
      <h2 id="depth-target">Deep target</h2>
      <div style={{ height: '1600px' }} aria-hidden="true" />
    </>
  );
}

export default function AnchorStream(_props: PageProps) {
  return (
    <Layout title="Anchor stream — rshono">
      <div className="page">
        <p data-anchor-shell>shell</p>
        <Suspense fallback={<p data-anchor-loading>waiting…</p>}>
          <SlowTarget />
        </Suspense>
      </div>
    </Layout>
  );
}
