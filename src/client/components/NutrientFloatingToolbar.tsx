import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GripVertical, Minus, Plus, House, RotateCw, RotateCcw } from 'lucide-react';
import type { WorkbenchTool } from '../hooks/useNutrientWorkbench';
import styles from './NutrientFloatingToolbar.module.css';

// ── Sub-option definitions ────────────────────────────────────────────────────

interface SubOption {
  id: string;
  label: string;
  action: () => void;
  active?: boolean;
  /** Render a colour swatch instead of text label. */
  colorSwatch?: string;
}

export interface FloatingToolbarSubOptions {
  activeTool: WorkbenchTool;
  isDirty: boolean;
  onSaveEdits: () => void;
  onDiscardEdits: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitPage: () => void;
  onSetHighlightColor: (hex: string) => void;
  onSetInkStrokeWidth: (width: number) => void;
  onRotateCw: () => void;
  onRotateCcw: () => void;
}

// ── Local-storage position persistence ───────────────────────────────────────

const LS_KEY = 'apex-nutrient-toolbar-position';

interface SavedPosition {
  x: number;
  y: number;
  minimized: boolean;
}

function loadSavedPosition(): SavedPosition | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as SavedPosition) : null;
  } catch {
    return null;
  }
}

function savePosition(pos: SavedPosition): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(0, Math.min(x, vw - width)),
    y: Math.max(0, Math.min(y, vh - height)),
  };
}

function defaultPosition(): { x: number; y: number } {
  return {
    x: Math.max(0, (window.innerWidth - 400) / 2),
    y: 80,
  };
}

// ── Highlight colour presets ──────────────────────────────────────────────────

const HIGHLIGHT_COLORS: Array<{ id: string; label: string; hex: string }> = [
  { id: 'yellow', label: 'Yellow', hex: '#FFE066' },
  { id: 'green', label: 'Green', hex: '#74E58A' },
  { id: 'pink', label: 'Pink', hex: '#FF7EB3' },
  { id: 'blue', label: 'Blue', hex: '#7EC8E3' },
  { id: 'orange', label: 'Orange', hex: '#FFB347' },
];

// ── Ink thickness presets ─────────────────────────────────────────────────────

const INK_WIDTHS: Array<{ id: string; label: string; width: number }> = [
  { id: 'thin', label: 'Thin', width: 1 },
  { id: 'medium', label: 'Medium', width: 3 },
  { id: 'thick', label: 'Thick', width: 6 },
];

// ── Component ─────────────────────────────────────────────────────────────────

export const NutrientFloatingToolbar: React.FC<FloatingToolbarSubOptions> = ({
  activeTool,
  isDirty,
  onSaveEdits,
  onDiscardEdits,
  onZoomIn,
  onZoomOut,
  onFitPage,
  onSetHighlightColor,
  onSetInkStrokeWidth,
  onRotateCw,
  onRotateCcw,
}) => {
  const saved = loadSavedPosition();
  const def = defaultPosition();

  const [position, setPosition] = useState<{ x: number; y: number }>({
    x: saved?.x ?? def.x,
    y: saved?.y ?? def.y,
  });
  const [minimized, setMinimized] = useState<boolean>(
    saved?.minimized ?? false
  );
  // Track the active highlight colour and ink width for visual feedback.
  const [activeHighlight, setActiveHighlight] = useState('yellow');
  const [activeInkWidth, setActiveInkWidth] = useState('medium');

  const dragging = useRef(false);
  const dragStart = useRef({ mouseX: 0, mouseY: 0, barX: 0, barY: 0 });
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => {
      setPosition((prev) => {
        const width = barRef.current?.offsetWidth ?? 400;
        const height = barRef.current?.offsetHeight ?? 56;
        return clampToViewport(prev.x, prev.y, width, height);
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    savePosition({ ...position, minimized });
  }, [position, minimized]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      dragging.current = true;
      dragStart.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        barX: position.x,
        barY: position.y,
      };

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const dx = ev.clientX - dragStart.current.mouseX;
        const dy = ev.clientY - dragStart.current.mouseY;
        const newX = dragStart.current.barX + dx;
        const newY = dragStart.current.barY + dy;
        const width = barRef.current?.offsetWidth ?? 400;
        const height = barRef.current?.offsetHeight ?? 56;
        setPosition(clampToViewport(newX, newY, width, height));
      };

      const onUp = () => {
        dragging.current = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [position]
  );

  const handleKeyboardMove = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const step = e.shiftKey ? 20 : 5;
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      setPosition((prev) => {
        const width = barRef.current?.offsetWidth ?? 400;
        const height = barRef.current?.offsetHeight ?? 56;
        return clampToViewport(prev.x + dx, prev.y + dy, width, height);
      });
    },
    []
  );

  const resetPosition = useCallback(() => {
    const pos = defaultPosition();
    setPosition(pos);
    setMinimized(false);
  }, []);

  // Sub-options per tool.
  const subOptions: SubOption[] = React.useMemo(() => {
    switch (activeTool) {
      case 'text-edit':
        return [
          {
            id: 'save',
            label: 'Save edits',
            action: onSaveEdits,
            active: isDirty,
          },
          { id: 'discard', label: 'Discard', action: onDiscardEdits },
        ];

      case 'highlight':
        return HIGHLIGHT_COLORS.map(({ id, label, hex }) => ({
          id,
          label,
          colorSwatch: hex,
          active: activeHighlight === id,
          action: () => {
            onSetHighlightColor(hex);
            setActiveHighlight(id);
          },
        }));

      case 'draw':
        return INK_WIDTHS.map(({ id, label, width }) => ({
          id,
          label,
          active: activeInkWidth === id,
          action: () => {
            onSetInkStrokeWidth(width);
            setActiveInkWidth(id);
          },
        }));

      case 'add-text':
        return [
          { id: 'hint', label: 'Click page to place text', action: () => {} },
        ];

      case 'comment':
        return [
          { id: 'hint', label: 'Click page to add a note', action: () => {} },
        ];

      case 'fill-form':
        return [
          {
            id: 'hint',
            label: 'Click a field to fill it',
            action: () => {},
          },
        ];

      case 'sign':
        return [
          { id: 'hint', label: 'Choose a signature type', action: () => {} },
        ];

      case 'pages':
        return [
          { id: 'rotate-cw',  label: 'Rotate CW',  action: onRotateCw },
          { id: 'rotate-ccw', label: 'Rotate CCW', action: onRotateCcw },
        ];

      default:
        return [
          { id: 'zoom-in', label: '+', action: onZoomIn },
          { id: 'zoom-out', label: '−', action: onZoomOut },
          { id: 'fit', label: 'Fit', action: onFitPage },
        ];
    }
  }, [
    activeTool, activeHighlight, activeInkWidth, isDirty,
    onSaveEdits, onDiscardEdits,
    onZoomIn, onZoomOut, onFitPage,
    onSetHighlightColor, onSetInkStrokeWidth,
    onRotateCw, onRotateCcw,
  ]);

  const toolLabel = activeTool
    ? activeTool
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
    : 'View';

  const [narrowScreen, setNarrowScreen] = useState(window.innerWidth < 600);
  useEffect(() => {
    const check = () => setNarrowScreen(window.innerWidth < 600);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const barStyle: React.CSSProperties = narrowScreen
    ? {}
    : { position: 'fixed', left: position.x, top: position.y };

  return (
    <div
      ref={barRef}
      className={`${styles.bar} ${narrowScreen ? styles.docked : styles.floating} ${minimized ? styles.minimized : ''}`}
      style={barStyle}
      data-testid="nutrient-floating-toolbar"
    >
      {/* Drag handle */}
      {!narrowScreen && (
        <button
          type="button"
          className={styles.dragHandle}
          onMouseDown={handleMouseDown}
          onKeyDown={handleKeyboardMove}
          aria-label="Drag toolbar to reposition. Arrow keys move it."
          data-testid="floating-toolbar-drag-handle"
        >
          <GripVertical size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}

      {/* Active tool pill */}
      <span
        className={styles.toolPill}
        data-testid="floating-toolbar-tool-label"
      >
        {toolLabel}
      </span>

      {/* Sub-options (hidden when minimized) */}
      {!minimized && (
        <div
          className={styles.subOptions}
          role="toolbar"
          aria-label={`${toolLabel} sub-options`}
        >
          {subOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`${styles.subBtn} ${opt.active ? styles.subBtnActive : ''}`}
              onClick={opt.action}
              data-testid={`sub-option-${opt.id}`}
              aria-label={opt.label}
              title={opt.label}
            >
              {opt.colorSwatch ? (
                <>
                  <span
                    className={styles.colorSwatch}
                    style={{ background: opt.colorSwatch }}
                    aria-hidden="true"
                  />
                  <span className={styles.swatchLabel}>{opt.label}</span>
                </>
              ) : opt.id === 'rotate-cw' ? (
                <RotateCw size={14} strokeWidth={2} aria-hidden="true" />
              ) : opt.id === 'rotate-ccw' ? (
                <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
              ) : (
                opt.label
              )}
            </button>
          ))}
        </div>
      )}

      {/* Minimize / Restore */}
      <button
        type="button"
        className={styles.iconBtn}
        onClick={() => setMinimized((m) => !m)}
        aria-label={minimized ? 'Restore toolbar' : 'Minimize toolbar'}
        data-testid="floating-toolbar-minimize"
      >
        {minimized ? (
          <Plus size={13} strokeWidth={2.5} aria-hidden="true" />
        ) : (
          <Minus size={13} strokeWidth={2.5} aria-hidden="true" />
        )}
      </button>

      {/* Reset position */}
      {!narrowScreen && (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={resetPosition}
          aria-label="Reset toolbar position"
          data-testid="floating-toolbar-reset"
        >
          <House size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
