/**
 * SignatureOverlayLayer — renders placed signature images over the PDF canvas.
 *
 * Each overlay is positioned using percentage geometry so it remains
 * resolution-independent at any zoom level. Selected overlays expose:
 *  - Drag-to-move (grab anywhere on the selected overlay)
 *  - Bottom-right corner resize handle
 *  - Delete button (× in top-right corner)
 *
 * This component renders in the same CSS stacking context as PdfFormFieldLayer
 * and OverlayTextLayer, sitting above both via z-index on its .layer class.
 */
import React, { useCallback, useRef } from 'react';
import type { PdfSignatureOverlay } from '../../shared/types/pdf';
import styles from './SignatureOverlayLayer.module.css';

interface SignatureOverlayLayerProps {
  /** Page ID of the currently displayed page — used to filter relevant overlays. */
  pageId: string;
  /** Session ID for building the preview URL. */
  sessionId: string;
  overlays: PdfSignatureOverlay[];
  selectedOverlayId: string | null;
  readOnly?: boolean;
  onSelect: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<PdfSignatureOverlay>) => void;
  onDelete: (id: string) => void;
}

export const SignatureOverlayLayer: React.FC<SignatureOverlayLayerProps> = ({
  pageId,
  sessionId,
  overlays,
  selectedOverlayId,
  readOnly = false,
  onSelect,
  onUpdate,
  onDelete,
}) => {
  const layerRef = useRef<HTMLDivElement>(null);

  const pageOverlays = overlays
    .filter((o) => o.pageId === pageId)
    .sort((a, b) => a.zIndex - b.zIndex);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onSelect(null);
    },
    [onSelect]
  );

  if (pageOverlays.length === 0) return null;

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      aria-label="Signature overlays"
      onClick={handleBackdropClick}
    >
      {pageOverlays.map((overlay) => (
        <SignatureOverlayItem
          key={overlay.id}
          overlay={overlay}
          sessionId={sessionId}
          layerRef={layerRef}
          isSelected={overlay.id === selectedOverlayId}
          readOnly={readOnly}
          onSelect={onSelect}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
};

// ── Per-overlay item with drag-to-move and corner-resize ───────────────────────

interface SignatureOverlayItemProps {
  overlay: PdfSignatureOverlay;
  sessionId: string;
  layerRef: React.RefObject<HTMLDivElement | null>;
  isSelected: boolean;
  readOnly: boolean;
  onSelect: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<PdfSignatureOverlay>) => void;
  onDelete: (id: string) => void;
}

type DragMode = 'move' | 'resize';

interface DragState {
  mode: DragMode;
  startClientX: number;
  startClientY: number;
  origX: number;
  origY: number;
  origWidth: number;
  origHeight: number;
}

const SignatureOverlayItem: React.FC<SignatureOverlayItemProps> = ({
  overlay,
  sessionId,
  layerRef,
  isSelected,
  readOnly,
  onSelect,
  onUpdate,
  onDelete,
}) => {
  const dragRef = useRef<DragState | null>(null);

  const previewUrl = `/api/pdf/sessions/${sessionId}/signature-assets/${overlay.assetId}`;

  const startDrag = useCallback(
    (e: React.PointerEvent, mode: DragMode) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        mode,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origX: overlay.x,
        origY: overlay.y,
        origWidth: overlay.width,
        origHeight: overlay.height,
      };
    },
    [overlay.x, overlay.y, overlay.width, overlay.height]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      const layer = layerRef.current;
      if (!layer) return;
      const rect = layer.getBoundingClientRect();
      const dxPct = ((e.clientX - dragRef.current.startClientX) / rect.width) * 100;
      const dyPct = ((e.clientY - dragRef.current.startClientY) / rect.height) * 100;

      if (dragRef.current.mode === 'move') {
        onUpdate(overlay.id, {
          x: Math.max(0, Math.min(100 - overlay.width, dragRef.current.origX + dxPct)),
          y: Math.max(0, Math.min(100 - overlay.height, dragRef.current.origY + dyPct)),
        });
      } else {
        // resize: bottom-right corner changes width + height
        const newW = Math.max(5, dragRef.current.origWidth + dxPct);
        const newH = Math.max(3, dragRef.current.origHeight + dyPct);
        onUpdate(overlay.id, {
          width: Math.min(newW, 100 - overlay.x),
          height: Math.min(newH, 100 - overlay.y),
        });
      }
    },
    [layerRef, overlay.id, overlay.x, overlay.y, overlay.width, overlay.height, onUpdate]
  );

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onDelete(overlay.id);
      }
    },
    [onDelete, overlay.id]
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect(overlay.id);
    },
    [onSelect, overlay.id]
  );

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      startDrag(e, 'resize');
    },
    [startDrag]
  );

  return (
    <div
      className={`${styles.overlay} ${isSelected ? styles.overlaySelected : ''}`}
      style={{
        left: `${overlay.x}%`,
        top: `${overlay.y}%`,
        width: `${overlay.width}%`,
        height: `${overlay.height}%`,
        opacity: overlay.opacity / 100,
        zIndex: overlay.zIndex,
        transform: overlay.rotation ? `rotate(${overlay.rotation}deg)` : undefined,
      }}
      tabIndex={readOnly ? -1 : 0}
      role="img"
      aria-label="Placed signature"
      onClick={handleOverlayClick}
      onPointerDown={isSelected && !readOnly ? (e) => startDrag(e, 'move') : undefined}
      onPointerMove={isSelected && !readOnly ? handlePointerMove : undefined}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      data-testid={`signature-overlay-${overlay.id}`}
    >
      <img
        src={previewUrl}
        alt="Signature"
        className={styles.image}
        draggable={false}
      />
      {isSelected && !readOnly && (
        <>
          <button
            type="button"
            className={styles.deleteBtn}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(overlay.id); }}
            aria-label="Delete signature"
            data-testid={`signature-delete-${overlay.id}`}
          >
            ✕
          </button>
          <div
            className={styles.resizeHandle}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            aria-hidden="true"
            title="Drag to resize"
          />
        </>
      )}
    </div>
  );
};
