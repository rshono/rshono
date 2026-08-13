'use client';

import { useState, useSyncExternalStore } from 'react';
// A third-party `'use client'` component, imported from `node_modules` rather than written here. The env
// shadow has to reach it too: it is SSR'd in the same layer as this file, where the real `process.env` is in
// scope, while the browser bundle only ever sees the `PUBLIC_`-only view.
import { ExternalEnvProbe } from 'rshono-test-external-client-dep';
import { readSecretFromHelper } from '../leak-helper';

// Never fires: hydration happens once, and the value it reports cannot change afterwards. Module scope so
// the reference is stable — a new function each render would resubscribe on every pass.
const neverChanges = () => () => {};

export function Counter() {
  const [count, setCount] = useState(0);
  // The server snapshot is `false` and the client's is `true`, so this reads as hydrated exactly when it
  // is — without the extra render an effect-then-setState pass costs.
  const hydrated = useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  );

  return (
    <div className="feature-card" style={{ margin: '1.5rem auto', maxWidth: '28rem' }}>
      <h3>Client Island {hydrated ? '(hydrated ✓)' : '(hydrating…)'}</h3>
      <p>
        <button
          className="btn"
          onClick={() => {
            setCount((n) => n + 1);
          }}
        >
          Clicked {count} time{count === 1 ? '' : 's'}
        </button>
      </p>
      <p className="meta">
        PUBLIC_API_ENDPOINT: <code>{process.env.PUBLIC_API_ENDPOINT ?? '(not set)'}</code>
        <br />
        DATABASE_URL: <code>{process.env.DATABASE_URL ?? '(stripped from the client bundle ✓)'}</code>
        <br />
        Using leak helper: {readSecretFromHelper()}
      </p>
      <ExternalEnvProbe />
    </div>
  );
}
