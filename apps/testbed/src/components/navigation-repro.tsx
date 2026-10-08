'use client';

import { Suspense, use } from 'react';
import { useNavigation } from '@rshono/core/client';

let resource: Promise<void> | undefined;
let resolveResource: (() => void) | undefined;

function Content() {
  const { url } = useNavigation();

  if (url.searchParams.get('tab') === 'activity' && resource) {
    use(resource);
    return <p>Activity content</p>;
  }

  return <p>Initial content</p>;
}

export function NavigationRepro() {
  const { router } = useNavigation();

  function navigate() {
    resource = new Promise<void>((resolve) => {
      resolveResource = resolve;
    });

    router.push('?tab=activity');
  }

  return (
    <div>
      <button onClick={navigate}>Navigate</button>
      <button onClick={() => resolveResource?.()}>Resolve</button>

      <p>pending: {String(router.pending)}</p>

      <Suspense fallback={<p>Loading...</p>}>
        <Content />
      </Suspense>
    </div>
  );
}
