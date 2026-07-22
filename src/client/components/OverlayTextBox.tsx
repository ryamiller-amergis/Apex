import React, { useEffect, useRef } from 'react';
import type { OverlayTextBox as OverlayTextBoxModel } from '../../shared/types/pdf';
import {
  clientDeltaToPagePercent,
  moveOverlayBox,
  resizeOverlayFromHandle,
  type OverlayBoxGeometry,
  type OverlayResizeHandle,
} from '../hooks/overlayGeometry';
import {
  formatOverlayDisplayText,
  OVERLAY_FONT_STACKS,
} from '../hooks/overlayFormatting';
import styles from './OverlayTextBox.module.css';

interface OverlayTextBoxProps {
  overlay: OverlayTextBoxModel;
  selected: boolean;
  editing?: boolean;
  onSelect: (overlayId: string) => void;
  onEdit?: (overlayId: string) => void;
  onFocus?: (overlayId: string) => void;
  onKeyDown?: (
    overlayId: string,
    event: React.KeyboardEvent<HTMLElement>
  ) => void;
  onTextChange?: (text: string) => void;
  onExitEdit?: () => void;
  onDelete?: () => void;
  onBeginGeometryEdit?: (overlayId: string) => boolean;
  onUpdateGeometry?: (geometry: OverlayBoxGeometry) => void;
  onCommitGeometryEdit?: (kind: 'move' | 'resize') => void;
  displayOnly?: boolean;
}

const RESIZE_HANDLES: OverlayResizeHandle[] = [
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
  'nw',
];

/** Replacements stay single-line; only horizontal resize is offered. */
const REPLACE_RESIZE_HANDLES: OverlayResizeHandle[] = ['e', 'w'];

interface PointerGesture {
  kind: 'move' | 'resize';
  handle?: OverlayResizeHandle;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  pageWidth: number;
  pageHeight: number;
  startGeometry: OverlayBoxGeometry;
}

export const OverlayTextBox: React.FC<OverlayTextBoxProps> = ({
  overlay,
  selected,
  editing = false,
  onSelect,
  onEdit,
  onFocus,
  onKeyDown,
  onTextChange,
  onExitEdit,
  onDelete,
  onBeginGeometryEdit,
  onUpdateGeometry,
  onCommitGeometryEdit,
  displayOnly = false,
}) => {
  const displayText = formatOverlayDisplayText(
    overlay.text,
    overlay.listStyle,
    overlay.linkDisplayText
  );
  const hasLink = Boolean(overlay.linkUrl);
  const gestureRef = useRef<PointerGesture | null>(null);
  const didDragRef = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(
        editorRef.current.value.length,
        editorRef.current.value.length
      );
    }
  }, [editing]);

  // Keep replacement glyph size locked to the cover box so zoom/fit scale
  // cannot leave original PDF text peeking under a mis-sized overlay.
  useEffect(() => {
    if (overlay.kind !== 'replace') return;
    const el = boxRef.current;
    if (!el) return;

    const syncFontToCover = () => {
      const heightPx = el.clientHeight;
      if (heightPx <= 0) return;
      // Cover includes small neighbor-clamped padding; em-box is most of height.
      el.style.fontSize = `${Math.max(6, heightPx * 0.85)}px`;
    };

    syncFontToCover();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncFontToCover);
    observer.observe(el);
    return () => observer.disconnect();
  }, [overlay.kind, overlay.height, overlay.fontSize]);

  const startGesture = (
    event: React.PointerEvent<HTMLElement>,
    kind: 'move' | 'resize',
    handle?: OverlayResizeHandle
  ) => {
    if (
      event.button !== 0 ||
      !selected ||
      editing ||
      (kind === 'move' &&
        (event.target as HTMLElement).closest('textarea, input, button'))
    ) {
      return;
    }
    const boxElement = event.currentTarget.closest<HTMLElement>(
      '[data-testid="pdf-tools-overlay-box"]'
    );
    const pageRect = boxElement?.parentElement?.getBoundingClientRect();
    if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0) return;
    if (!onBeginGeometryEdit?.(overlay.id)) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    didDragRef.current = false;
    gestureRef.current = {
      kind,
      handle,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      pageWidth: pageRect.width,
      pageHeight: pageRect.height,
      startGeometry: {
        x: overlay.x,
        y: overlay.y,
        width: overlay.width,
        height: overlay.height,
      },
    };
  };

  const continueGesture = (event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (
      Math.abs(event.clientX - gesture.startClientX) >= 3 ||
      Math.abs(event.clientY - gesture.startClientY) >= 3
    ) {
      didDragRef.current = true;
    }
    const delta = clientDeltaToPagePercent(
      event.clientX - gesture.startClientX,
      event.clientY - gesture.startClientY,
      { width: gesture.pageWidth, height: gesture.pageHeight }
    );
    const geometry =
      gesture.kind === 'move'
        ? moveOverlayBox(gesture.startGeometry, delta.xPct, delta.yPct)
        : resizeOverlayFromHandle(
            gesture.startGeometry,
            gesture.handle!,
            delta.xPct,
            delta.yPct
          );
    // Replacement covers are single-line: never allow vertical resize drift.
    if (overlay.kind === 'replace') {
      onUpdateGeometry?.({
        ...geometry,
        height: gesture.startGeometry.height,
      });
      return;
    }
    onUpdateGeometry?.(geometry);
  };

  const finishGesture = (event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    continueGesture(event);
    gestureRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onCommitGeometryEdit?.(gesture.kind);
  };

  return (
    <div
      ref={boxRef}
      className={`${styles.box} ${
        overlay.kind === 'replace' ? styles.replace : ''
      } ${
        displayOnly
          ? styles.displayOnly
          : selected
            ? styles.selected
            : styles.unselected
      }`}
      style={{
        left: `${overlay.x}%`,
        top: `${overlay.y}%`,
        width: `${overlay.width}%`,
        height: `${overlay.height}%`,
        zIndex: overlay.zIndex,
        transform: overlay.rotation
          ? `rotate(${overlay.rotation}deg)`
          : undefined,
        color: overlay.color,
        fontFamily: OVERLAY_FONT_STACKS[overlay.fontFamily],
        // Replacements sync px size to the cover via ResizeObserver. Additive
        // overlays keep pt for the existing authoring model / burn-in.
        fontSize:
          overlay.kind === 'replace' ? undefined : `${overlay.fontSize}pt`,
        fontWeight: overlay.bold ? 700 : 400,
        fontStyle: overlay.italic ? 'italic' : 'normal',
        textAlign: overlay.horizontalAlign,
        justifyContent:
          overlay.verticalAlign === 'middle'
            ? 'center'
            : overlay.verticalAlign === 'bottom'
              ? 'flex-end'
              : 'flex-start',
        textDecoration: hasLink ? 'underline' : undefined,
      }}
      data-testid="pdf-tools-overlay-box"
      data-overlay-id={overlay.id}
      data-overlay-kind={overlay.kind ?? 'add'}
      role={displayOnly ? undefined : 'button'}
      tabIndex={displayOnly ? -1 : 0}
      aria-label={`Text box: ${overlay.text.slice(0, 40) || 'empty'}`}
      title={
        displayOnly
          ? undefined
          : 'Click selected text, double-click the box, or press Enter to edit'
      }
      aria-pressed={selected}
      aria-selected={selected}
      onFocus={() => {
        if (!editing) onFocus?.(overlay.id);
      }}
      onPointerDown={(event) => startGesture(event, 'move')}
      onPointerMove={continueGesture}
      onPointerUp={finishGesture}
      onPointerCancel={finishGesture}
      onClick={(event) => {
        if (displayOnly) return;
        event.stopPropagation();
        if (didDragRef.current) {
          didDragRef.current = false;
          return;
        }
        if (
          selected &&
          (event.target as HTMLElement).closest(
            '[data-testid="pdf-tools-overlay-drag-surface"]'
          )
        ) {
          onEdit?.(overlay.id);
          return;
        }
        onSelect(overlay.id);
      }}
      onDoubleClick={(event) => {
        if (displayOnly) return;
        event.preventDefault();
        event.stopPropagation();
        onEdit?.(overlay.id);
      }}
      onKeyDown={(event) => {
        if (displayOnly) return;
        onKeyDown?.(overlay.id, event);
      }}
    >
      {overlay.kind === 'replace' && overlay.backgroundColor && (
        <span
          className={styles.replacementCover}
          style={{ backgroundColor: overlay.backgroundColor }}
          aria-hidden="true"
        />
      )}
      {editing ? (
        <textarea
          ref={editorRef}
          className={styles.textEditor}
          value={overlay.text}
          maxLength={2000}
          rows={1}
          wrap={overlay.kind === 'replace' ? 'off' : undefined}
          aria-label="Edit text box content"
          data-testid="pdf-tools-overlay-editing"
          style={{ opacity: overlay.opacity / 100 }}
          onChange={(event) => {
            const next =
              overlay.kind === 'replace'
                ? event.target.value.replace(/\r?\n/g, ' ')
                : event.target.value;
            onTextChange?.(next);
          }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (overlay.kind === 'replace' && event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onExitEdit?.();
            window.requestAnimationFrame(() => boxRef.current?.focus());
          }}
          onBlur={() => onExitEdit?.()}
        />
      ) : (
        <span
          className={styles.text}
          data-testid="pdf-tools-overlay-drag-surface"
          style={{ opacity: overlay.opacity / 100 }}
        >
          {displayText}
        </span>
      )}
      {selected &&
        !editing &&
        (overlay.kind === 'replace'
          ? REPLACE_RESIZE_HANDLES
          : RESIZE_HANDLES
        ).map((handle) => (
          <button
            key={handle}
            type="button"
            className={styles.resizeHandle}
            data-testid="pdf-tools-overlay-resize-handle"
            data-handle={handle}
            aria-label={
              overlay.kind === 'replace'
                ? `Resize replacement width ${handle}; ${overlay.width.toFixed(1)}% wide`
                : `Resize text box ${handle}; ${overlay.width.toFixed(1)}% wide by ${overlay.height.toFixed(1)}% high`
            }
            onPointerDown={(event) => startGesture(event, 'resize', handle)}
            onPointerMove={continueGesture}
            onPointerUp={finishGesture}
            onPointerCancel={finishGesture}
            onClick={(event) => event.stopPropagation()}
          />
        ))}
      {selected && !editing && onDelete && (
        <button
          type="button"
          className={styles.deleteButton}
          data-testid="overlay-delete"
          aria-label="Delete text box"
          title="Delete text box"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
};
