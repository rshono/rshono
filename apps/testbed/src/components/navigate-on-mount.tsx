'use client';

import { useEffect, useRef } from 'react';
import { useNavigation } from '@rshono/core/client';

export function NavigateOnMount({ method = 'replace' }: { method?: 'push' | 'replace' }) {
  const { router } = useNavigation();
  const navigated = useRef(false);

  useEffect(() => {
    // router changes when pending changes; this redirect should only start once per mount.
    if (navigated.current) return;
    navigated.current = true;
    router[method]('/users');
  }, [method, router]);

  return <p>pending: {String(router.pending)}</p>;
}
