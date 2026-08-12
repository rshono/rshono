'use client';

import { useEffect, useState } from 'react';
import { useNavigation } from '@rshono/core/client';

/**
 * A top progress bar for soft navigations, so a slow page still feels answered.
 *
 * This used to be a `@rshono/core/client` export. It reads nothing but `router.pending`, so it was app
 * code with styling opinions that happened to ship inside the framework — it lives here now, where its
 * colour and height are this site's business rather than a framework option.
 */
export function NavigationProgress() {
  const { router } = useNavigation();
  const pending = router.pending;
  // The bar is a pure function of `pending` and how long that has been true, so only the *delayed* half of
  // the animation is state — both transitions below happen inside a timer rather than in the effect body,
  // which is what keeps a navigation from costing an extra render pass.
  const [crept, setCrept] = useState(false);

  useEffect(() => {
    if (pending) {
      const ramp = setTimeout(() => setCrept(true), 80);
      return () => clearTimeout(ramp);
    }
    const hide = setTimeout(() => setCrept(false), 220);
    return () => clearTimeout(hide);
  }, [pending]);

  // Jump in, creep toward — but never reach — the end while we wait, snap to full once the page arrives,
  // then fade out. A navigation that resolves before the creep starts never shows a bar at all.
  const bar = pending ? { width: crept ? 85 : 15, opacity: 1 } : crept ? { width: 100, opacity: 1 } : { width: 0, opacity: 0 };

  return (
    <div
      data-rshono-progress=""
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        height: 3,
        width: `${bar.width}%`,
        opacity: bar.opacity,
        background: '#3b82f6',
        zIndex: 2147483647,
        pointerEvents: 'none',
        transition: 'width 200ms ease-out, opacity 200ms ease-out',
      }}
    />
  );
}
