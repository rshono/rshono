import type { PageProps } from '@rshono/core';
import { subscribe } from '../actions';
import { Layout } from './layout';

/**
 * A form a *server* component renders, wired straight to a `'use server'` action. React posts it as a single
 * `$ACTION_ID_<id>` field, which is the shape the framework sees when a page has no `useActionState` — the
 * other three forms in this app all have one.
 */
export default function Subscribe({ ctx }: PageProps<'/subscribe'>) {
  const subscribed = ctx.cookies.get('subscribed');

  return (
    <Layout title="Subscribe — rshono">
      <div className="page">
        <h1>Subscribe</h1>
        {subscribed && <p className="notice">Subscribed as {subscribed}</p>}
        <form action={subscribe} className="form">
          <label>
            Email
            <input name="email" placeholder="ada@example.com" />
          </label>
          <button className="btn" type="submit">
            Subscribe
          </button>
        </form>
      </div>
    </Layout>
  );
}
