import type { PageProps } from '@rshono/core';
import { NavigateOnMount } from './navigate-on-mount';

export default function MountNavigation({ url }: PageProps) {
  return <NavigateOnMount method={url.searchParams.get('method') === 'push' ? 'push' : 'replace'} />;
}
