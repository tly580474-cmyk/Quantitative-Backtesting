import { useSyncExternalStore } from 'react';

// Keep touch devices in the same layout when rotated. Narrow desktop windows
// also get a usable compact interface, without changing normal desktop widths.
// Range syntax also includes fractional CSS pixels produced by display scaling.
export const MOBILE_LAYOUT_QUERY = '(width < 768px), (width < 1200px) and (pointer: coarse)';

function subscribe(onChange: () => void) {
  const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function useMobileLayout(): boolean {
  return useSyncExternalStore(subscribe,
    () => window.matchMedia(MOBILE_LAYOUT_QUERY).matches,
    () => false);
}
