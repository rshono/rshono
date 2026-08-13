import { Suspense } from 'react';
import type { PageProps } from '@rshono/core';
import { redirect } from '@rshono/core/server';
import { Layout } from './layout';

/**
 * A `redirect()` from an async server component inside a **bare** `<Suspense>` — deliberately not an
 * `<AsyncBoundary>`, whose `CatchBoundary` re-throws a control signal and so takes the shell down with it.
 *
 * That difference is the whole point of this page. With nothing to re-throw it, React SSR renders the fallback
 * and the shell still resolves — so the RSC render records the control signal while the HTML response is
 * already live and being pumped. It is the one shape that reaches `renderComponent`'s post-shell
 * `controlSignal` branch, where the framework has to abandon a response it has already started building and
 * answer with the redirect instead.
 */
async function RedirectingSection() {
  await Promise.resolve();
  redirect('/login');
  return <p>unreachable</p>;
}

export default function SuspenseRedirect(_props: PageProps) {
  return (
    <Layout title="Suspense redirect — rshono">
      <div className="page">
        <h1>Suspense redirect</h1>
        <p className="description">
          The section below redirects from inside a bare <code>&lt;Suspense&gt;</code>, after the shell has resolved. A hard load answers 303; a soft
          navigation carries the signal in the payload.
        </p>
        <Suspense fallback={<p data-section="loading">Loading…</p>}>
          <RedirectingSection />
        </Suspense>
      </div>
    </Layout>
  );
}
