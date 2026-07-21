import { useCallback, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { OverlayTextBox } from '../../shared/types/pdf';

interface UseOverlayKeyboardOptions {
  overlays: OverlayTextBox[];
  selectedOverlayId: string | null;
  disabled?: boolean;
  onSelect: (overlayId: string | null) => void;
  onBeginTextEdit: (overlayId: string) => boolean;
  onCommitTextEdit: () => boolean;
  onDeleteSelected: () => void;
  onNudgeSelected: (deltaXPct: number, deltaYPct: number) => void;
}

const ARROW_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const;

export function useOverlayKeyboard({
  overlays,
  selectedOverlayId,
  disabled = false,
  onSelect,
  onBeginTextEdit,
  onCommitTextEdit,
  onDeleteSelected,
  onNudgeSelected,
}: UseOverlayKeyboardOptions) {
  const [editingOverlayId, setEditingOverlayId] = useState<string | null>(null);

  const orderedOverlays = useMemo(
    () =>
      [...overlays].sort(
        (a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id)
      ),
    [overlays]
  );
  const activeEditingOverlayId =
    !disabled &&
    editingOverlayId &&
    overlays.some((overlay) => overlay.id === editingOverlayId)
      ? editingOverlayId
      : null;

  const finishEditing = useCallback(() => {
    if (!activeEditingOverlayId) return;
    onCommitTextEdit();
    setEditingOverlayId(null);
  }, [activeEditingOverlayId, onCommitTextEdit]);

  const beginEditing = useCallback(
    (overlayId: string) => {
      if (disabled || activeEditingOverlayId) return false;
      onSelect(overlayId);
      if (!onBeginTextEdit(overlayId)) return false;
      setEditingOverlayId(overlayId);
      return true;
    },
    [activeEditingOverlayId, disabled, onBeginTextEdit, onSelect]
  );

  const handleBoxFocus = useCallback(
    (overlayId: string) => {
      if (!disabled && overlayId !== selectedOverlayId) {
        onSelect(overlayId);
      }
    },
    [disabled, onSelect, selectedOverlayId]
  );

  const handleBoxKeyDown = useCallback(
    (overlayId: string, event: KeyboardEvent<HTMLElement>) => {
      if (disabled || activeEditingOverlayId) return;

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        beginEditing(overlayId);
        return;
      }

      if (event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        onSelect(overlayId);
        return;
      }

      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        overlayId === selectedOverlayId
      ) {
        event.preventDefault();
        event.stopPropagation();
        onDeleteSelected();
        return;
      }

      if (
        overlayId === selectedOverlayId &&
        ARROW_KEYS.includes(event.key as (typeof ARROW_KEYS)[number])
      ) {
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 5 : 1;
        onNudgeSelected(
          event.key === 'ArrowLeft'
            ? -step
            : event.key === 'ArrowRight'
              ? step
              : 0,
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
        );
      }
    },
    [
      disabled,
      activeEditingOverlayId,
      beginEditing,
      onDeleteSelected,
      onNudgeSelected,
      onSelect,
      selectedOverlayId,
    ]
  );

  return {
    orderedOverlays,
    editingOverlayId: activeEditingOverlayId,
    beginEditing,
    finishEditing,
    handleBoxFocus,
    handleBoxKeyDown,
  };
}
