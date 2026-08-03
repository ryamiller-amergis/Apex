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

export interface ReplacementFitResult extends OverlayBoxGeometry {
  replacementOverflow: boolean;
}

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
 * Simulates the server's wrapParagraph word-wrap using canvas measurements so
 * the client-side box height preview matches what the exported PDF will render.
 * Mirrors the token-by-token logic in pdfOverlayBurnIn.ts wrapParagraph.
 */
function countWrappedLines(
  text: string,
  overlay: Pick<OverlayTextBox, 'fontFamily' | 'fontSize' | 'bold' | 'italic'>,
  emPx: number,
  maxWidthPx: number
): number {
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  let total = 0;

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0 || maxWidthPx <= 0) {
      total += 1;
      continue;
    }

    const paragraphPx =
      measureLinePx(paragraph, overlay, emPx) ??
      paragraph.length * emPx * FALLBACK_CHAR_EM;

    if (paragraphPx <= maxWidthPx) {
      total += 1;
      continue;
    }

    // Token-by-token wrap matching server wrapParagraph
    const tokens = paragraph.split(/(\s+)/).filter(Boolean);
    let current = '';

    for (const token of tokens) {
      const candidate = current + token;
      const candidatePx =
        measureLinePx(candidate, overlay, emPx) ??
        candidate.length * emPx * FALLBACK_CHAR_EM;

      if (current && candidatePx > maxWidthPx) {
        total += 1;
        current = token.trimStart();
      } else {
        current = candidate;
      }

      // Hard-break a single token that exceeds the box width on its own
      let currentPx =
        measureLinePx(current, overlay, emPx) ??
        current.length * emPx * FALLBACK_CHAR_EM;
      while (current && currentPx > maxWidthPx) {
        if (current.length <= 1) break;
        let splitAt = current.length - 1;
        while (
          splitAt > 1 &&
          (measureLinePx(current.slice(0, splitAt), overlay, emPx) ??
            Infinity) > maxWidthPx
        ) {
          splitAt--;
        }
        total += 1;
        current = current.slice(splitAt);
        currentPx =
          measureLinePx(current, overlay, emPx) ??
          current.length * emPx * FALLBACK_CHAR_EM;
      }
    }
    total += 1; // last partial line of this paragraph
  }

  return Math.max(1, total);
}

/**
 * Fits replacement text geometry using word-wrap simulation for accurate
 * height prediction and canvas-measured line widths for width.
 *
 * - Width grows rightward first, then leftward when the page edge is reached.
 *   It never shrinks below the current overlay width.
 * - Height is recalculated from the word-wrap line count on every text edit.
 *   This repairs stale oversized geometry produced by an earlier fit.
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
    | 'replacementBounds'
    | 'replacementOverflow'
  >,
  text: string,
  pageWidthPx: number,
  pageHeightPx: number,
  displayScale?: number
): ReplacementFitResult {
  const current: ReplacementFitResult = {
    x: overlay.x,
    y: overlay.y,
    width: overlay.width,
    height: overlay.height,
    replacementOverflow: overlay.replacementOverflow ?? false,
  };
  if (pageWidthPx <= 0 || pageHeightPx <= 0) return current;

  const emPx =
    displayScale != null
      ? overlay.fontSize * displayScale
      : overlay.fontSize * PT_TO_PX;

  // Width: grow to fit the longest explicit line. Use space to the right first,
  // then expand leftward so text near the page's right edge gets the full page
  // width before wrapping.
  const explicitLines = text.replace(/\r\n?/g, '\n').split('\n');
  const longestPx = Math.max(
    0,
    ...explicitLines.map((line) => {
      const measured = measureLinePx(line, overlay, emPx);
      if (measured !== null) return measured;
      return Math.max(1, line.length) * emPx * FALLBACK_CHAR_EM;
    })
  );
  const requiredWidthPct =
    ((longestPx + TEXT_PAD_X_PX * 2 + emPx * WIDTH_SAFETY_MARGIN_EM) /
      pageWidthPx) *
    100;
  const bounds = overlay.replacementBounds;
  const xMin = bounds?.xMin ?? 0;
  const xMax = bounds?.xMax ?? 100;
  const yMax = bounds?.yMax ?? 100;
  const availableWidth = xMax - xMin;
  const baseWidth = Math.min(overlay.width, availableWidth);
  const baseX = Math.min(Math.max(overlay.x, xMin), xMax - baseWidth);
  const targetWidth = Math.min(
    availableWidth,
    Math.max(baseWidth, requiredWidthPct)
  );
  const growth = targetWidth - baseWidth;
  const availableRight = Math.max(0, xMax - baseX - baseWidth);
  const growRight = Math.min(growth, availableRight);
  const growLeft = Math.min(growth - growRight, baseX - xMin);
  const x = baseX - growLeft;
  const width = baseWidth + growRight + growLeft;

  // Height: wrap prediction uses the *resolved* width so that text which
  // auto-grew the box wide enough to fit on one line is counted as 1 line,
  // not as many short lines based on the original narrow overlay.width.
  const maxBoxWidthPx = (width / 100) * pageWidthPx;
  const wrappedLineCount = countWrappedLines(
    text,
    overlay,
    emPx,
    maxBoxWidthPx
  );
  const requiredHeightPct =
    ((wrappedLineCount * emPx * REPLACEMENT_LINE_HEIGHT_MULTIPLIER) /
      pageHeightPx) *
    100;
  const availableHeight = yMax - overlay.y;
  const height = Math.min(availableHeight, requiredHeightPct);
  const replacementOverflow = requiredHeightPct > availableHeight + 0.01;

  return {
    x,
    y: overlay.y,
    width,
    height,
    replacementOverflow,
  };
}
