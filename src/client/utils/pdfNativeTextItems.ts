import type { OverlayBoxGeometry } from '../hooks/overlayGeometry';

export interface NativePdfTextItem {
  id: string;
  text: string;
  geometry: OverlayBoxGeometry;
  fontSize: number;
  rotation: number;
  /** Sampled page cover color injected when creating a replacement overlay. */
  backgroundColor?: string | null;
}

export interface PdfTextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

interface PdfTextStyleLike {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
}

interface PdfViewportLike {
  width: number;
  height: number;
  scale: number;
  transform: number[];
}

interface RawEmBox {
  id: string;
  text: string;
  fontSize: number;
  rotation: number;
  left: number;
  top: number;
  width: number;
  emHeight: number;
  fontHeight: number;
}

function multiplyTransforms(left: number[], right: number[]): number[] {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function normalizeRotation(degrees: number): number {
  let normalized = Math.round(degrees);
  while (normalized > 180) normalized -= 360;
  while (normalized < -180) normalized += 360;
  return normalized;
}

/**
 * Matches PDF.js TextLayer.#getAscent fallback when canvas metrics are unavailable:
 * prefer style.ascent, else 1 + style.descent, else 0.8.
 */
function ascentRatio(style: PdfTextStyleLike | undefined): number {
  if (
    typeof style?.ascent === 'number' &&
    style.ascent > 0 &&
    style.ascent <= 1.5
  ) {
    return style.ascent;
  }
  if (typeof style?.descent === 'number') {
    const ratio = 1 + style.descent;
    if (ratio > 0.5 && ratio <= 1.5) return ratio;
  }
  return 0.8;
}

function rangesOverlap(
  a0: number,
  a1: number,
  b0: number,
  b1: number
): boolean {
  return a0 < b1 && b0 < a1;
}

/** Side pad so anti-aliased glyph edges do not leak. */
const COVER_PAD_X_PX = 1.5;
/** Tight top pad — invoices often have little leading above. */
const COVER_PAD_TOP_PX = 0.75;
/** Soft bottom pad target; clamped by the gap to the next line. */
const COVER_PAD_BOTTOM_MIN_PX = 1.5;
const COVER_PAD_BOTTOM_RATIO = 0.18;
/** Leave at least this much of the inter-line gap uncovered. */
const NEIGHBOR_GAP_KEEP_RATIO = 0.55;

function buildRawEmBox(
  item: PdfTextItemLike,
  index: number,
  styles: Record<string, PdfTextStyleLike>,
  viewport: PdfViewportLike
): RawEmBox | null {
  if (!item.str.trim() || item.transform.length < 6) return null;

  const style = styles[item.fontName];
  const tx = multiplyTransforms(viewport.transform, item.transform);
  let angle = Math.atan2(tx[1], tx[0]);
  if (style?.vertical) {
    angle += Math.PI / 2;
  }

  const fontHeight = Math.hypot(tx[2], tx[3]);
  if (fontHeight < 0.5) return null;

  const fontAscent = fontHeight * ascentRatio(style);
  const width = Math.max(
    0.5,
    Math.abs((style?.vertical ? item.height : item.width) * viewport.scale)
  );

  let left: number;
  let top: number;
  if (Math.abs(angle) < 1e-6) {
    left = tx[4];
    top = tx[5] - fontAscent;
  } else {
    left = tx[4] + fontAscent * Math.sin(angle);
    top = tx[5] - fontAscent * Math.cos(angle);
  }

  return {
    id: `text-item-${index}`,
    text: item.str,
    fontSize: Math.max(8, Math.min(72, Math.round(fontHeight))),
    rotation: normalizeRotation((angle * 180) / Math.PI),
    left,
    top,
    width,
    emHeight: fontHeight,
    fontHeight,
  };
}

function padForNeighbors(
  box: RawEmBox,
  all: RawEmBox[],
  viewport: PdfViewportLike
): OverlayBoxGeometry {
  const right = box.left + box.width;
  const emBottom = box.top + box.emHeight;

  let previousBottom = -Infinity;
  let nextTop = Infinity;
  for (const other of all) {
    if (other.id === box.id) continue;
    if (
      !rangesOverlap(box.left, right, other.left, other.left + other.width)
    ) {
      continue;
    }
    const otherBottom = other.top + other.emHeight;
    if (otherBottom <= box.top + 0.5 && otherBottom > previousBottom) {
      previousBottom = otherBottom;
    }
    if (other.top >= emBottom - 0.5 && other.top < nextTop) {
      nextTop = other.top;
    }
  }

  const gapAbove =
    previousBottom > -Infinity ? box.top - previousBottom : Infinity;
  const gapBelow = nextTop < Infinity ? nextTop - emBottom : Infinity;

  const desiredTopPad = COVER_PAD_TOP_PX;
  const desiredBottomPad = Math.max(
    COVER_PAD_BOTTOM_MIN_PX,
    box.fontHeight * COVER_PAD_BOTTOM_RATIO
  );

  const maxTopPad =
    gapAbove < Infinity
      ? Math.max(0, gapAbove * (1 - NEIGHBOR_GAP_KEEP_RATIO))
      : desiredTopPad;
  const maxBottomPad =
    gapBelow < Infinity
      ? Math.max(0, gapBelow * (1 - NEIGHBOR_GAP_KEEP_RATIO))
      : desiredBottomPad;

  const padTop = Math.min(desiredTopPad, maxTopPad);
  const padBottom = Math.min(desiredBottomPad, maxBottomPad);
  const padX = COVER_PAD_X_PX;

  const coverLeft = box.left - padX;
  const coverTop = box.top - padTop;
  const coverWidth = box.width + padX * 2;
  const coverHeight = box.emHeight + padTop + padBottom;

  const widthPct = (coverWidth / viewport.width) * 100;
  const heightPct = (coverHeight / viewport.height) * 100;
  const xPct = (coverLeft / viewport.width) * 100;
  const yPct = (coverTop / viewport.height) * 100;

  const clampedWidth = Math.min(100, Math.max(0.25, widthPct));
  const clampedHeight = Math.min(100, Math.max(0.25, heightPct));
  return {
    x: Math.min(100 - clampedWidth, Math.max(0, xPct)),
    y: Math.min(100 - clampedHeight, Math.max(0, yPct)),
    width: clampedWidth,
    height: clampedHeight,
  };
}

/**
 * Converts each PDF.js TextItem independently. Geometry mirrors PDF.js TextLayer
 * em-box placement, then applies neighbor-clamped cover padding so opaque
 * covers hide the current glyphs without swallowing the line below.
 */
export function convertPdfTextItems(
  items: PdfTextItemLike[],
  styles: Record<string, PdfTextStyleLike>,
  viewport: PdfViewportLike
): NativePdfTextItem[] {
  if (viewport.width <= 0 || viewport.height <= 0) return [];

  const rawBoxes: RawEmBox[] = [];
  items.forEach((item, index) => {
    const box = buildRawEmBox(item, index, styles, viewport);
    if (box) rawBoxes.push(box);
  });

  return rawBoxes.map((box) => ({
    id: box.id,
    text: box.text,
    geometry: padForNeighbors(box, rawBoxes, viewport),
    fontSize: box.fontSize,
    rotation: box.rotation,
  }));
}
