/**
 * SignaturePad — a freehand drawing surface for creating electronic signatures.
 *
 * Uses pointer events so it works with mouse, touch, and stylus input without
 * separate event handlers for each input type.
 * The canvas is transparent; the drawn strokes become the signature image.
 */
import React, { useRef, useCallback, useState, useEffect } from 'react';
import styles from './SignaturePad.module.css';

interface SignaturePadProps {
  /** Width of the drawing area in CSS pixels. */
  width?: number;
  /** Height of the drawing area in CSS pixels. */
  height?: number;
  /** Stroke colour — defaults to near-black. */
  strokeColor?: string;
  /** Stroke width in px. */
  strokeWidth?: number;
  onUse: (blob: Blob) => void;
  onCancel: () => void;
}

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 160;
const DEFAULT_STROKE_COLOR = '#1a1a2e';
const DEFAULT_STROKE_WIDTH = 2.5;

export const SignaturePad: React.FC<SignaturePadProps> = ({
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  strokeColor = DEFAULT_STROKE_COLOR,
  strokeWidth = DEFAULT_STROKE_WIDTH,
  onUse,
  onCancel,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [hasStrokes, setHasStrokes] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Set DPR-aware canvas size so strokes are crisp on HiDPI screens.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, [width, height, strokeColor, strokeWidth]);

  const getPoint = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },
    []
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      isDrawingRef.current = true;
      lastPointRef.current = getPoint(e);
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;
      ctx.beginPath();
      ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
      setHasStrokes(true);
    },
    [getPoint]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      const point = getPoint(e);
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx || !lastPointRef.current) return;
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      lastPointRef.current = point;
    },
    [getPoint]
  );

  const handlePointerUp = useCallback(() => {
    isDrawingRef.current = false;
    lastPointRef.current = null;
  }, []);

  const handleClear = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, width, height);
    setHasStrokes(false);
  }, [width, height]);

  const handleUse = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasStrokes) return;
    setIsExporting(true);
    canvas.toBlob(
      (blob) => {
        setIsExporting(false);
        if (blob) onUse(blob);
      },
      'image/png'
    );
  }, [hasStrokes, onUse]);

  return (
    <div className={styles.container}>
      <p className={styles.hint}>Draw your signature below</p>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        aria-label="Signature drawing area"
        role="img"
        data-testid="signature-pad-canvas"
      />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.clearButton}
          onClick={handleClear}
          disabled={!hasStrokes}
          aria-label="Clear signature"
        >
          Clear
        </button>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.useButton}
          onClick={handleUse}
          disabled={!hasStrokes || isExporting}
          data-testid="signature-pad-use"
        >
          {isExporting ? 'Processing…' : 'Use signature'}
        </button>
      </div>
    </div>
  );
};
