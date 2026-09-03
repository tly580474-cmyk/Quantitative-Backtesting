import { useCallback, useEffect, useState } from 'react';

export function useFullscreen() {
  const supported = typeof document !== 'undefined'
    && typeof document.documentElement.requestFullscreen === 'function'
    && typeof document.exitFullscreen === 'function';
  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== 'undefined' && Boolean(document.fullscreenElement),
  );

  useEffect(() => {
    if (!supported) return undefined;
    const syncState = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', syncState);
    syncState();
    return () => document.removeEventListener('fullscreenchange', syncState);
  }, [supported]);

  const toggleFullscreen = useCallback(async () => {
    if (!supported) throw new Error('当前浏览器不支持全屏模式');
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  }, [supported]);

  return { isFullscreen, supported, toggleFullscreen };
}
