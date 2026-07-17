import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 长按拖拽卡片重排序 hook。
 *
 * 交互流程：
 * 1. pointerdown 启动 400ms 长按计时器
 * 2. 长按到达后进入拖拽态（draggingKey 被设置）
 * 3. pointermove 时通过 elementFromPoint 检测当前悬停的卡片
 * 4. pointerup 时如有有效目标则交换位置，并清空状态
 * 5. 若未到达长按就松手，视为普通点击，不进入拖拽
 *
 * @param keys      当前有序的 key 列表
 * @param onReorder 交换后的回调，传入新的 key 列表
 */
export function useCardDragReorder(
  keys: string[],
  onReorder: (next: string[]) => void,
) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);

  const longPressTimer = useRef<number | null>(null);
  const dragMoved = useRef(false);
  // 用 ref 保存所有最新值，供全局事件监听器同步读取
  const draggingKeyRef = useRef<string | null>(null);
  const dropTargetKeyRef = useRef<string | null>(null);
  const keysRef = useRef(keys);
  const onReorderRef = useRef(onReorder);
  keysRef.current = keys;
  onReorderRef.current = onReorder;

  const setDragging = useCallback((key: string | null) => {
    draggingKeyRef.current = key;
    setDraggingKey(key);
  }, []);

  const setDropTarget = useCallback((key: string | null) => {
    dropTargetKeyRef.current = key;
    setDropTargetKey(key);
  }, []);

  /** 卡片 pointerdown：启动长按计时 */
  const handlePointerDown = useCallback((key: string, e: React.PointerEvent) => {
    // 只响应主键（左键 / 触摸）
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragMoved.current = false;
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      setDragging(key);
    }, 400);
  }, [setDragging]);

  /** 全局 pointermove + pointerup：仅在拖拽态激活 */
  useEffect(() => {
    if (!draggingKey) return;

    const handleMove = (e: PointerEvent) => {
      dragMoved.current = true;
      // elementFromPoint 可能命中被拖拽卡片自身（即使半透明仍在 DOM 中），
      // 因此临时给被拖卡片设置 pointer-events:none，确保穿透
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const card = el?.closest<HTMLElement>('[data-index-key]');
      const targetKey = card?.dataset.indexKey ?? null;
      if (targetKey && targetKey !== draggingKeyRef.current) {
        setDropTarget(targetKey);
      } else if (dropTargetKeyRef.current !== null) {
        setDropTarget(null);
      }
    };

    const handleUp = () => {
      if (longPressTimer.current) {
        window.clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
      // 直接从 ref 读取最新值，避免嵌套 setState
      const fromKey = draggingKeyRef.current;
      const toKey = dropTargetKeyRef.current;
      if (fromKey && toKey && fromKey !== toKey) {
        const arr = [...keysRef.current];
        const from = arr.indexOf(fromKey);
        const to = arr.indexOf(toKey);
        if (from !== -1 && to !== -1) {
          [arr[from], arr[to]] = [arr[to], arr[from]];
          onReorderRef.current(arr);
        }
      }
      setDragging(null);
      setDropTarget(null);
    };

    document.addEventListener('pointermove', handleMove, { passive: true });
    document.addEventListener('pointerup', handleUp);
    document.addEventListener('pointercancel', handleUp);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      document.removeEventListener('pointercancel', handleUp);
    };
  }, [draggingKey, setDragging, setDropTarget]);

  /** 清理长按计时器（组件卸载或 pointerleave 时） */
  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  /** 判断某次 click 是否应该被抑制（因为发生了拖拽） */
  const shouldSuppressClick = useCallback(() => {
    if (dragMoved.current) {
      dragMoved.current = false;
      return true;
    }
    return false;
  }, []);

  return {
    draggingKey,
    dropTargetKey,
    isReordering: draggingKey !== null,
    handlePointerDown,
    cancelLongPress,
    shouldSuppressClick,
  };
}
