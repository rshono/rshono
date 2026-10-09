'use client';

import { Suspense, use, useEffect } from 'react';
import { useNavigation } from '@rshono/core/client';

let resource: Promise<void> | undefined;
let resolveResource: (() => void) | undefined;

function Content({ onActivityRender }: { onActivityRender?: () => void }) {
  const { url } = useNavigation();

  if (url.searchParams.get('tab') === 'activity' && resource) {
    onActivityRender?.();
    use(resource);
    return <p>Activity content</p>;
  }

  return <p>Initial content</p>;
}

export function NavigationRepro({ onActivityRender }: { onActivityRender?: () => void }) {
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
        <Content onActivityRender={onActivityRender} />
      </Suspense>
    </div>
  );
}

// Observe a render attempt before it suspends; a commit observer cannot see suspended work.
function observeActivityRender() {
  document.documentElement.dataset.activityRenderAttempted = 'true';
}

export function ObservedNavigationRepro() {
  useEffect(() => {
    document.documentElement.dataset.navigationReproHydrated = 'true';
  }, []);
  return <NavigationRepro onActivityRender={observeActivityRender} />;
}
