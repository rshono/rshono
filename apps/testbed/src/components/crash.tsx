import type { PageProps } from '@rshono/core';
import { CrashForm } from './crash-form';
import { Layout } from './layout';

export default function Crash({ url }: PageProps) {
  // ?render=1 throws during the render itself rather than from an action. That fails SSR before any of
  // the shell has been sent, so nothing is committed and the failure reaches `app.onError` — which
  // answers with this app's `error` page, from a fresh render of its own. It used to be the one path
  // that page could not be reached from; the e2e suite pins it in both representations.
  if (url.searchParams.get('render') === '1') {
    throw new Error('Intentional render failure (SSR-failure demo).');
  }

  return (
    <Layout title="Error handling — rshono">
      <div className="page">
        <h1>Progressive-enhancement error handling</h1>
        <p className="description">
          This form calls a <code>'use server'</code> action that throws. Even with JavaScript disabled, the framework routes the failure to the{' '}
          <code>error</code> page instead of returning a blank 500.
        </p>
        <CrashForm />
        <p className="description">
          <a href="/crash?render=1">Throw during render instead</a> — SSR fails before the shell is sent, and the <code>error</code> page answers that
          too.
        </p>
      </div>
    </Layout>
  );
}
