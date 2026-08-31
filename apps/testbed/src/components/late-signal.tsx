import { Suspense } from 'react';
import type { PageProps } from '@rshono/core';
import { notFound, redirect } from '@rshono/core/server';
import { Layout } from './layout';

/**
 * A control signal raised from a boundary that resolves well *after* the shell — the case `/suspense-redirect`
 * deliberately wins the race on.
 *
 * There is no 3xx to be had here: the status line and the shell bytes are already on the wire by the time
 * this runs. What the framework has to do instead is let React write the digest that carries the signal to
 * the client, and then stop rendering the page nobody will read — which is what {@link SlowSection} is here
 * to catch it doing.
 */
async function LateSection({ signal }: { signal: string | null }) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (signal === 'notfound') notFound();
  redirect('/login');
  return null;
}

/** Still rendering when the late signal arrives, and slow enough that the response cannot have waited for it. */
async function SlowSection() {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return <p data-section="slow">the slow section rendered anyway</p>;
}

export default function LateSignal({ url }: PageProps) {
  return (
    <Layout title="Late control signal — rshono">
      <div className="page">
        <h1>Late control signal</h1>
        <Suspense fallback={<p data-section="loading">Loading…</p>}>
          <LateSection signal={url.searchParams.get('signal')} />
        </Suspense>
        <Suspense fallback={<p data-section="slow-loading">Still loading…</p>}>
          <SlowSection />
        </Suspense>
      </div>
    </Layout>
  );
}
