/**
 * FEAT-002 / PBI-003 — Crop dialog after file select.
 *
 * Shows the full photo (contained) with a draggable square outline. The user
 * moves the square to choose what to capture; zoom changes the square size.
 * Crop is a square in pixel space (may be unequal in normalized fractions).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AVATAR_MAX_BYTES,
  parseNormalizedAvatarCrop,
  type NormalizedAvatarCrop,
} from '../../shared/types/profile';
import styles from './AvatarEditor.module.css';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const NUDGE_PX = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundCrop(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

interface ImageBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Image pixels per stage pixel. */
  scale: number;
}

function containImage(stageSize: number, naturalW: number, naturalH: number): ImageBox | null {
  if (stageSize <= 0 || naturalW <= 0 || naturalH <= 0) return null;
  const scale = Math.min(stageSize / naturalW, stageSize / naturalH);
  const width = naturalW * scale;
  const height = naturalH * scale;
  return {
    left: (stageSize - width) / 2,
    top: (stageSize - height) / 2,
    width,
    height,
    scale,
  };
}

interface AvatarCropDialogProps {
  file: File;
  isSubmitting: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onConfirm: (file: File, crop: NormalizedAvatarCrop) => void;
}

export const AvatarCropDialog: React.FC<AvatarCropDialogProps> = ({
  file,
  isSubmitting,
  errorMessage = null,
  onCancel,
  onConfirm,
}) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState(0);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  /** Frame top-left in stage coordinates. */
  const [framePos, setFramePos] = useState({ x: 0, y: 0 });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [activeFile, setActiveFile] = useState(file);
  const [hasPositioned, setHasPositioned] = useState(false);

  const cancelRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const framePosRef = useRef(framePos);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startFrameX: number;
    startFrameY: number;
  } | null>(null);

  useEffect(() => {
    framePosRef.current = framePos;
  }, [framePos]);

  // Reset crop UI when a different file is selected (render-time adjust).
  if (file !== activeFile) {
    setActiveFile(file);
    setNaturalSize(null);
    setZoom(MIN_ZOOM);
    setFramePos({ x: 0, y: 0 });
    setObjectUrl(null);
    setHasPositioned(false);
  }

  const imageBox = useMemo(
    () =>
      naturalSize && stageSize > 0
        ? containImage(stageSize, naturalSize.w, naturalSize.h)
        : null,
    [naturalSize, stageSize]
  );

  const maxFrameSide = imageBox ? Math.min(imageBox.width, imageBox.height) : 0;
  const frameSize = maxFrameSide > 0 ? maxFrameSide / zoom : 0;

  const frameBounds = useMemo(() => {
    if (!imageBox || frameSize <= 0) return null;
    return {
      minX: imageBox.left,
      minY: imageBox.top,
      maxX: imageBox.left + imageBox.width - frameSize,
      maxY: imageBox.top + imageBox.height - frameSize,
    };
  }, [imageBox, frameSize]);

  const crop = useMemo<NormalizedAvatarCrop | null>(() => {
    if (!imageBox || !naturalSize || frameSize <= 0) return null;
    const leftPx = (framePos.x - imageBox.left) / imageBox.scale;
    const topPx = (framePos.y - imageBox.top) / imageBox.scale;
    const sizePx = frameSize / imageBox.scale;
    return {
      x: roundCrop(clamp(leftPx / naturalSize.w, 0, 1)),
      y: roundCrop(clamp(topPx / naturalSize.h, 0, 1)),
      width: roundCrop(clamp(sizePx / naturalSize.w, 0, 1)),
      height: roundCrop(clamp(sizePx / naturalSize.h, 0, 1)),
    };
  }, [imageBox, naturalSize, framePos.x, framePos.y, frameSize]);

  // Create/revoke object URL for the selected file (external resource lifecycle).
  useEffect(() => {
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync object URL after createObjectURL
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const size = el.getBoundingClientRect().width;
      if (size > 0) setStageSize(size);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Center the frame on first layout; clamp when zoom/size changes (render-time adjust).
  if (frameBounds && imageBox && frameSize > 0) {
    if (!hasPositioned) {
      setHasPositioned(true);
      setFramePos({
        x: imageBox.left + (imageBox.width - frameSize) / 2,
        y: imageBox.top + (imageBox.height - frameSize) / 2,
      });
    } else {
      const clamped = {
        x: clamp(framePos.x, frameBounds.minX, frameBounds.maxX),
        y: clamp(framePos.y, frameBounds.minY, frameBounds.maxY),
      };
      if (clamped.x !== framePos.x || clamped.y !== framePos.y) {
        setFramePos(clamped);
      }
    }
  }

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previouslyFocused.current?.focus();
    };
  }, [onCancel]);

  const applyZoomKeepingCenter = useCallback(
    (nextZoom: number) => {
      if (!imageBox || !frameBounds) {
        setZoom(clamp(nextZoom, MIN_ZOOM, MAX_ZOOM));
        return;
      }
      const prevZoom = zoom;
      const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      if (clampedZoom === prevZoom) return;

      const prevSize = maxFrameSide / prevZoom;
      const nextSize = maxFrameSide / clampedZoom;
      const centerX = framePosRef.current.x + prevSize / 2;
      const centerY = framePosRef.current.y + prevSize / 2;
      const nextMinX = imageBox.left;
      const nextMinY = imageBox.top;
      const nextMaxX = imageBox.left + imageBox.width - nextSize;
      const nextMaxY = imageBox.top + imageBox.height - nextSize;

      setZoom(clampedZoom);
      setFramePos({
        x: clamp(centerX - nextSize / 2, nextMinX, nextMaxX),
        y: clamp(centerY - nextSize / 2, nextMinY, nextMaxY),
      });
    },
    [imageBox, frameBounds, maxFrameSide, zoom]
  );

  function handleFramePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (isSubmitting || !frameBounds) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    e.stopPropagation();

    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startFrameX: framePos.x,
      startFrameY: framePos.y,
    };
    setIsDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom
    }
  }

  function handleFramePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || !frameBounds) return;
    if (typeof e.pointerId === 'number' && drag.pointerId !== e.pointerId) return;

    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    setFramePos({
      x: clamp(drag.startFrameX + dx, frameBounds.minX, frameBounds.maxX),
      y: clamp(drag.startFrameY + dy, frameBounds.minY, frameBounds.maxY),
    });
  }

  function endFrameDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (typeof e.pointerId === 'number' && drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
  }

  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (isSubmitting) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    applyZoomKeepingCenter(zoom + delta);
  }

  function handleFrameKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (isSubmitting || !frameBounds) return;
    const step = e.shiftKey ? NUDGE_PX * 2 : NUDGE_PX;
    let nextX = framePos.x;
    let nextY = framePos.y;
    switch (e.key) {
      case 'ArrowLeft':
        nextX = clamp(framePos.x - step, frameBounds.minX, frameBounds.maxX);
        break;
      case 'ArrowRight':
        nextX = clamp(framePos.x + step, frameBounds.minX, frameBounds.maxX);
        break;
      case 'ArrowUp':
        nextY = clamp(framePos.y - step, frameBounds.minY, frameBounds.maxY);
        break;
      case 'ArrowDown':
        nextY = clamp(framePos.y + step, frameBounds.minY, frameBounds.maxY);
        break;
      default:
        return;
    }
    e.preventDefault();
    setFramePos({ x: nextX, y: nextY });
  }

  function handleImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setHasPositioned(false);
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      const el = stageRef.current;
      if (el) {
        const size = el.getBoundingClientRect().width;
        if (size > 0) setStageSize(size);
      }
    }
  }

  function handleSubmit() {
    setValidationError(null);

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setValidationError('File must be a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size <= 0 || file.size > AVATAR_MAX_BYTES) {
      setValidationError('File must be greater than 0 bytes and no more than 5 MB.');
      return;
    }

    const nextCrop = crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const parsed = parseNormalizedAvatarCrop(nextCrop);
    if (parsed.ok === false) {
      setValidationError(parsed.error);
      return;
    }

    onConfirm(file, parsed.value);
  }

  const canDragFrame = Boolean(frameBounds && !isSubmitting);

  return (
    <div className={styles.overlay}>
      <div
        className={styles.dialog}
        data-testid="avatar-crop-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-crop-dialog-title"
      >
        <h2 id="avatar-crop-dialog-title" className={styles.dialogTitle}>
          Crop your avatar
        </h2>
        <p className={styles.cropHint} id="avatar-crop-hint">
          Drag the square to choose what to capture · scroll or use the slider to zoom
        </p>

        <div
          ref={stageRef}
          data-testid="avatar-crop-preview"
          className={styles.cropStage}
          onWheel={handleWheel}
        >
          {objectUrl && (
            <img
              data-testid="avatar-crop-image"
              className={styles.cropImageContained}
              src={objectUrl}
              alt=""
              draggable={false}
              onLoad={handleImageLoad}
              style={
                imageBox
                  ? {
                      width: imageBox.width,
                      height: imageBox.height,
                      transform: `translate(${imageBox.left}px, ${imageBox.top}px)`,
                    }
                  : undefined
              }
            />
          )}

          {/* Dim the photo outside the selection square */}
          {frameSize > 0 && (
            <div
              className={styles.cropDim}
              aria-hidden="true"
              style={{
                clipPath: `polygon(
                  0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
                  ${framePos.x}px ${framePos.y}px,
                  ${framePos.x}px ${framePos.y + frameSize}px,
                  ${framePos.x + frameSize}px ${framePos.y + frameSize}px,
                  ${framePos.x + frameSize}px ${framePos.y}px,
                  ${framePos.x}px ${framePos.y}px
                )`,
              }}
            />
          )}

          {frameSize > 0 && (
            <div
              data-testid="avatar-crop-frame"
              className={`${styles.cropFrameDraggable} ${canDragFrame ? styles.cropPreviewPan : ''} ${
                isDragging ? styles.cropPreviewDragging : ''
              }`}
              style={{
                width: frameSize,
                height: frameSize,
                transform: `translate(${framePos.x}px, ${framePos.y}px)`,
              }}
              role="slider"
              aria-label="Crop selection. Drag to reposition over the photo."
              aria-describedby="avatar-crop-hint"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100)}
              tabIndex={canDragFrame ? 0 : -1}
              onPointerDown={handleFramePointerDown}
              onPointerMove={handleFramePointerMove}
              onPointerUp={endFrameDrag}
              onPointerCancel={endFrameDrag}
              onKeyDown={handleFrameKeyDown}
            />
          )}
        </div>

        <label htmlFor="avatar-crop-zoom" className={styles.cropSizeLabel}>
          Zoom
        </label>
        <input
          id="avatar-crop-zoom"
          data-testid="avatar-crop-zoom"
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          disabled={isSubmitting || !naturalSize}
          onChange={(e) => applyZoomKeepingCenter(Number(e.target.value))}
          className={styles.cropSizeInput}
        />

        {(validationError || errorMessage) && (
          <p className={styles.dialogError} role="alert">
            {validationError ?? errorMessage}
          </p>
        )}

        <div className={styles.dialogActions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.btnCancel}
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="avatar-upload-submit"
            className={styles.btnConfirm}
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Uploading…' : 'Upload avatar'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AvatarCropDialog;
