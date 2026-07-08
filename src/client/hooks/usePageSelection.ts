import { useState, useCallback } from 'react';

export function usePageSelection() {
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);

  const toggleSelection = useCallback((pageId: string) => {
    setSelectedPageIds(new Set([pageId]));
    setLastClickedId(pageId);
  }, []);

  const rangeSelect = useCallback(
    (pageId: string, allPageIds: string[]) => {
      if (!lastClickedId) {
        setSelectedPageIds(new Set([pageId]));
        setLastClickedId(pageId);
        return;
      }

      const startIdx = allPageIds.indexOf(lastClickedId);
      const endIdx = allPageIds.indexOf(pageId);

      if (startIdx === -1 || endIdx === -1) {
        setSelectedPageIds(new Set([pageId]));
        setLastClickedId(pageId);
        return;
      }

      const low = Math.min(startIdx, endIdx);
      const high = Math.max(startIdx, endIdx);
      setSelectedPageIds(new Set(allPageIds.slice(low, high + 1)));
      setLastClickedId(pageId);
    },
    [lastClickedId],
  );

  const multiToggle = useCallback((pageId: string) => {
    setSelectedPageIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) {
        next.delete(pageId);
      } else {
        next.add(pageId);
      }
      return next;
    });
    setLastClickedId(pageId);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPageIds(new Set());
    setLastClickedId(null);
  }, []);

  const isSelected = useCallback(
    (pageId: string) => selectedPageIds.has(pageId),
    [selectedPageIds],
  );

  return {
    selectedPageIds,
    toggleSelection,
    multiToggle,
    rangeSelect,
    clearSelection,
    isSelected,
    selectedCount: selectedPageIds.size,
  };
}
