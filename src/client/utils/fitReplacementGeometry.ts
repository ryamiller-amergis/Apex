import type { OverlayTextBox } from '../../shared/types/pdf';
import { OVERLAY_FONT_STACKS } from '../hooks/overlayFormatting';
import type { OverlayBoxGeometry } from '../hooks/overlayGeometry';

export const REPLACEMENT_LINE_HEIGHT_MULTIPLIER = 1.2;
const TEXT_PAD_X_PX = 6;
/**
 * Extra horizontal room (fraction of em) added to the fitted width so a
 * same-length replacement never sits flush against the content edge. Without
 * it, sub-pixel differences between canvas.measureText and CSS rendering push
 * the last word onto a second line that the single-line box then clips.
 */
const WIDTH_SAFETY_MARGIN_EM = 0.2;
/** CSS pt → CSS px (96/72). Used only as fallback when no displayScale provided. */
const PT_TO_PX = 96 / 72;
/** Approximate average glyph width as a fraction of em when canvas measure is unavailable. */
const FALLBACK_CHAR_EM = 0.55;

function measureLinePx(
  text: string,
  overlay: Pick<OverlayTextBox, 'fontFamily' | 'fontSize' | 'bold' | 'italic'>,
  emPx: number
): number | null {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const weight = overlay.bold ? '700' : '400';
    const style = overlay.italic ? 'italic' : 'normal';
    ctx.font = `${style} ${weight} ${emPx}px ${OVERLAY_FONT_STACKS[overlay.fontFamily]}`;
    return ctx.measureText(text.length === 0 ? ' ' : text).width;
  } catch {
    return null;
  }
}

/**
 * Fits multiline replacement text using explicit line widths and line count.
 * Geometry only grows right/down, never auto-shrinks below current manual size,
 * and clamps at page right/bottom boundaries.
 *
 * @param displayScale PDF.js render scale (fitScale × zoom). When provided,
 *   font is measured at `fontSize * displayScale` px. Falls back to pt→px
 *   conversion when omitted (backward compat).
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
  pageHeightPx: number,
  displayScale?: number
): OverlayBoxGeometry {
  const current: OverlayBoxGeometry = {
    x: overlay.x,
    y: overlay.y,
    width: overlay.width,
    height: overlay.height,
  };
  if (pageWidthPx <= 0 || pageHeightPx <= 0) return current;

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const emPx =
    displayScale != null
      ? overlay.fontSize * displayScale
      : overlay.fontSize * PT_TO_PX;
  const longestPx = Math.max(
    0,
    ...lines.map((line) => {
      const measured = measureLinePx(line, overlay, emPx);
      if (measured !== null) return measured;
      return Math.max(1, line.length) * emPx * FALLBACK_CHAR_EM;
    })
  );

  const requiredWidthPct =
    ((longestPx + TEXT_PAD_X_PX * 2 + emPx * WIDTH_SAFETY_MARGIN_EM) /
      pageWidthPx) *
    100;

  const lineCount = lines.length;
  const requiredHeightPct =
    lineCount <= 1
      ? 0
      : ((lineCount * emPx * REPLACEMENT_LINE_HEIGHT_MULTIPLIER) /
          pageHeightPx) *
        100;

  const width = Math.min(
    100 - overlay.x,
    Math.max(overlay.width, requiredWidthPct)
  );
  const height = Math.min(
    100 - overlay.y,
    Math.max(overlay.height, requiredHeightPct)
  );

  return {
    x: overlay.x,
    y: overlay.y,
    width,
    height,
  };
}
