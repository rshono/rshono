import type { ErrorPageProps } from '@rshono/core';
import { notFound, redirect } from '@rshono/core/server';
import { Layout } from './layout';

export default function ErrorPage({ error, url }: ErrorPageProps) {
  // The `notFound` page's `?boom=` twin, and the same two shapes: `?boom=redirect` sends the visitor
  // somewhere else — "that record is gone, go to the list" — and `?boom=notfound` throws the other signal.
  // The first is honoured, because nothing is committed when it arrives and answering a redirect cannot
  // fail. The second is not: it would render the `notFound` page from inside the error path, which can fail
  // in its turn with nowhere left to escalate to, so it stays a reported 500.
  const boom = url.searchParams.get('boom');
  if (boom === 'redirect') redirect('/users');
  if (boom === 'notfound') notFound();

  return (
    <Layout title="Something went wrong — rshono">
      <div className="page">
        <h1>Something went wrong</h1>
        <p className="description">{error.message}</p>
        {error.stack && (
          <pre className="feature-card" style={{ overflowX: 'auto', textAlign: 'left', fontSize: '0.8rem' }}>
            {error.stack}
          </pre>
        )}
        <p>
          <a href="/">Back to the start</a>
        </p>
      </div>
    </Layout>
  );
}
