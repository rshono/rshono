import type { ReactNode } from 'react';
import { AsyncBoundary } from '@rshono/core/client';
import type { PageProps } from '@rshono/core';
import { HydrationProbe } from './hydration-probe';
import { Layout } from './layout';

// Resolves only after the page shell has been flushed: that is the shape whose soft navigation suspends the
// client on a streamed flight chunk. A buffered test fetch would never suspend, so the page is deliberately
// slow rather than merely async. See navigation-transition.spec.mjs.
export async function SlowSection({ label }: { label: string }): Promise<ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return <p data-streamed-content={label}>{label} content loaded</p>;
}

export function StreamedBoundaryPage({ label, other }: { label: string; other: string }) {
  return (
    <Layout title={`Streamed boundary — ${label}`}>
      <HydrationProbe name="streamedBoundaryHydrated" />
      <div className="page">
        <p data-streamed-shell={label}>{label} shell</p>
        <AsyncBoundary loading={<p data-streamed-loading={label}>{label} loading…</p>} error={<p data-streamed-error={label}>failed</p>}>
          <SlowSection label={label} />
        </AsyncBoundary>
        <a href={other}>next</a>
      </div>
    </Layout>
  );
}

export function StreamedBoundaryA(_props: PageProps) {
  return <StreamedBoundaryPage label="a" other="/streamed-boundary-b" />;
}

export function StreamedBoundaryB(_props: PageProps) {
  return <StreamedBoundaryPage label="b" other="/streamed-boundary-a" />;
}
