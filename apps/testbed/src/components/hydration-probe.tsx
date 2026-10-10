'use client';

import { useEffect } from 'react';

/**
 * Marks the document once this page's client code is live, so a test's click cannot race hydration and
 * accidentally exercise a full browser load instead of a soft navigation.
 */
export function HydrationProbe({ name }: { name: string }) {
  useEffect(() => {
    document.documentElement.dataset[name] = 'true';
  }, [name]);
  return null;
}
