import { Suspense } from 'react';
import type { PageProps } from '@rshono/core';
import { Layout } from './layout';

/**
 * A streamed section that stays open long enough for a server rebuild to land while the response is still
 * streaming — the shape `rshono dev` has to drain rather than terminate between worker restarts. The shell is
 * flushed immediately (the delay is inside the suspended child, not ahead of the render), so a test can read
 * it and only then trigger the rebuild. See the drain test in dev.test.mjs.
 */
async function SlowContent() {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return <p data-slow-stream-content>streamed content arrived</p>;
}

export default function SlowStream(_props: PageProps) {
  return (
    <Layout title="Slow stream — rshono">
      <div className="page">
        <p data-slow-stream-shell>shell</p>
        <Suspense fallback={<p data-slow-stream-loading>waiting…</p>}>
          <SlowContent />
        </Suspense>
      </div>
    </Layout>
  );
}
