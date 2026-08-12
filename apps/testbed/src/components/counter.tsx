'use client';

import { useState, useSyncExternalStore } from 'react';
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
    </div>
  );
}
