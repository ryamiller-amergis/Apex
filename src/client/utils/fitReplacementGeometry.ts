import type { OverlayTextBox } from '../../shared/types/pdf';
import { OVERLAY_FONT_STACKS } from '../hooks/overlayFormatting';
import type { OverlayBoxGeometry } from '../hooks/overlayGeometry';

/** Horizontal padding kept inside the cover so typed text never sits on the edge. */
const TEXT_PAD_PX = 6;
/** CSS pt → CSS px (96/72). */
const PT_TO_PX = 96 / 72;
/** Approximate average glyph width as a fraction of em when canvas measure is unavailable. */
const FALLBACK_CHAR_EM = 0.55;

function toSingleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trimEnd();
}

function measureLinePx(
  text: string,
  overlay: Pick<
    OverlayTextBox,
    'fontFamily' | 'fontSize' | 'bold' | 'italic'
  >
): number | null {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const weight = overlay.bold ? '700' : '400';
    const style = overlay.italic ? 'italic' : 'normal';
    ctx.font = `${style} ${weight} ${overlay.fontSize}px ${OVERLAY_FONT_STACKS[overlay.fontFamily]}`;
    return ctx.measureText(text.length === 0 ? ' ' : text).width;
  } catch {
    return null;
  }
}

/**
 * Grows a replacement overlay horizontally so typed text stays on the opaque
 * cover. Height is always locked to the original single-line cover so edits
 * never spill onto the row below.
 */
export function fitReplacementGeometry(
  overlay: Pick<
    OverlayTextBox,
    | 'x'
    | 'y'
    | 'width'
    | 'height'
    | 'fontFamily'
    | 'fontSize'
    | 'bold'
    | 'italic'
  >,
  text: string,
  pageWidthPx: number,
  _pageHeightPx?: number
): OverlayBoxGeometry {
  const current: OverlayBoxGeometry = {
    x: overlay.x,
    y: overlay.y,
    width: overlay.width,
    height: overlay.height,
  };
  if (pageWidthPx <= 0) return current;

  const singleLine = toSingleLine(text);
  const measuredPx = measureLinePx(singleLine, overlay);
  const emPx = overlay.fontSize * PT_TO_PX;
  const maxLinePx =
    measuredPx ??
    Math.max(1, singleLine.length || 1) * emPx * FALLBACK_CHAR_EM;

  const neededWidthPct =
    ((maxLinePx + TEXT_PAD_PX * 2) / pageWidthPx) * 100;

  const width = Math.min(
    100 - overlay.x,
    Math.max(overlay.width, neededWidthPct)
  );

  return {
    x: overlay.x,
    y: overlay.y,
    width,
    height: overlay.height,
  };
}
