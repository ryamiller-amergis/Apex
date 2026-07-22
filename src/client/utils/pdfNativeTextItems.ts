import type { OverlayBoxGeometry } from '../hooks/overlayGeometry';
import type { OverlayFontFamily } from '../../shared/types/pdf';

export interface NativePdfTextItem {
  id: string;
  text: string;
  geometry: OverlayBoxGeometry;
  fontSize: number;
  rotation: number;
  fontFamily: OverlayFontFamily;
  bold: boolean;
  italic: boolean;
  /** Sampled foreground color injected when creating a replacement overlay. */
  color?: string | null;
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
  fontFamily?: string;
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
  fontFamily: OverlayFontFamily;
  bold: boolean;
  italic: boolean;
  left: number;
  top: number;
  width: number;
  emHeight: number;
  fontHeight: number;
  baselineX: number;
  baselineY: number;
}

const MONOSPACE_HINTS = ['courier', 'mono', 'consolas', 'menlo', 'typewriter'];
const SERIF_HINTS = [
  'times',
  'serif',
  'roman',
  'georgia',
  'garamond',
  'cambria',
];
const SANS_HINTS = [
  'helvetica',
  'arial',
  'sans',
  'calibri',
  'verdana',
  'tahoma',
];
const BOLD_HINTS = ['bold', 'black', 'heavy', 'demi', 'semibold'];
const ITALIC_HINTS = ['italic', 'oblique', 'slanted'];

interface InferredFontStyle {
  fontFamily: OverlayFontFamily;
  bold: boolean;
  italic: boolean;
}

function inferFontStyle(
  fontName: string,
  style: PdfTextStyleLike | undefined
): InferredFontStyle {
  const hint = `${style?.fontFamily ?? ''} ${fontName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const contains = (values: readonly string[]) =>
    values.some((value) => hint.includes(value));

  const fontFamily: OverlayFontFamily = contains(MONOSPACE_HINTS)
    ? 'Courier'
    : contains(SERIF_HINTS)
      ? 'Times-Roman'
      : contains(SANS_HINTS)
        ? 'Helvetica'
        : 'Helvetica';

  return {
    fontFamily,
    bold: contains(BOLD_HINTS),
    italic: contains(ITALIC_HINTS),
  };
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
  if (!Number.isFinite(fontHeight) || fontHeight < 0.5) return null;

  const fontAscent = fontHeight * ascentRatio(style);
  const inferredStyle = inferFontStyle(item.fontName, style);
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
    fontFamily: inferredStyle.fontFamily,
    bold: inferredStyle.bold,
    italic: inferredStyle.italic,
    left,
    top,
    width,
    emHeight: fontHeight,
    fontHeight,
    baselineX: tx[4],
    baselineY: tx[5],
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
    if (!rangesOverlap(box.left, right, other.left, other.left + other.width)) {
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

const MERGE_BASELINE_TOLERANCE_EM = 0.35;
const MERGE_GAP_MAX_EM = 0.6;
const MERGE_GAP_OVERLAP_TOLERANCE_EM = 0.3;
const MERGE_FONT_SIZE_RATIO_MAX = 1.2;
const MERGE_ROTATION_EPSILON_DEG = 2;
const MERGE_SPACE_THRESHOLD_EM = 0.1;

function advancePosition(
  baselineX: number,
  baselineY: number,
  rotationDeg: number
): number {
  const rad = (rotationDeg * Math.PI) / 180;
  return baselineX * Math.cos(rad) + baselineY * Math.sin(rad);
}

function perpPosition(
  baselineX: number,
  baselineY: number,
  rotationDeg: number
): number {
  const rad = (rotationDeg * Math.PI) / 180;
  return -baselineX * Math.sin(rad) + baselineY * Math.cos(rad);
}

function canMerge(prev: RawEmBox, next: RawEmBox): boolean {
  if (Math.abs(prev.rotation - next.rotation) > MERGE_ROTATION_EPSILON_DEG) {
    return false;
  }

  if (prev.fontFamily !== next.fontFamily) return false;

  const sizeRatio =
    prev.fontHeight > next.fontHeight
      ? prev.fontHeight / next.fontHeight
      : next.fontHeight / prev.fontHeight;
  if (sizeRatio > MERGE_FONT_SIZE_RATIO_MAX) return false;

  const avgEm = (prev.fontHeight + next.fontHeight) / 2;
  const rot = prev.rotation;

  const prevPerp = perpPosition(prev.baselineX, prev.baselineY, rot);
  const nextPerp = perpPosition(next.baselineX, next.baselineY, rot);
  if (Math.abs(prevPerp - nextPerp) > MERGE_BASELINE_TOLERANCE_EM * avgEm) {
    return false;
  }

  const prevAdvEnd =
    advancePosition(prev.baselineX, prev.baselineY, rot) + prev.width;
  const nextAdvStart = advancePosition(next.baselineX, next.baselineY, rot);
  const gap = nextAdvStart - prevAdvEnd;

  if (gap > MERGE_GAP_MAX_EM * avgEm) return false;
  if (gap < -MERGE_GAP_OVERLAP_TOLERANCE_EM * avgEm) return false;

  return true;
}

function mergeGroup(group: RawEmBox[]): RawEmBox {
  if (group.length === 1) return group[0];

  const first = group[0];
  const rot = first.rotation;
  const rad = (rot * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  const textParts: string[] = [];
  let maxFontHeight = 0;

  for (let i = 0; i < group.length; i++) {
    const box = group[i];
    if (box.fontHeight > maxFontHeight) maxFontHeight = box.fontHeight;

    if (i === 0) {
      textParts.push(box.text);
    } else {
      const prev = group[i - 1];
      const prevAdvEnd =
        advancePosition(prev.baselineX, prev.baselineY, rot) + prev.width;
      const curAdvStart = advancePosition(box.baselineX, box.baselineY, rot);
      const gap = curAdvStart - prevAdvEnd;
      const avgEm = (prev.fontHeight + box.fontHeight) / 2;
      if (gap > MERGE_SPACE_THRESHOLD_EM * avgEm) {
        textParts.push(' ');
      }
      textParts.push(box.text);
    }
  }

  let vMinX = Infinity;
  let vMinY = Infinity;
  let vMaxX = -Infinity;
  let vMaxY = -Infinity;

  for (const box of group) {
    const cx = box.left + box.width / 2;
    const cy = box.top + box.emHeight / 2;
    const hw = box.width / 2;
    const hh = box.emHeight / 2;
    const offsets: [number, number][] = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    for (const [lx, ly] of offsets) {
      const vx = cx + lx * cosR - ly * sinR;
      const vy = cy + lx * sinR + ly * cosR;
      if (vx < vMinX) vMinX = vx;
      if (vy < vMinY) vMinY = vy;
      if (vx > vMaxX) vMaxX = vx;
      if (vy > vMaxY) vMaxY = vy;
    }
  }

  const vcx = (vMinX + vMaxX) / 2;
  const vcy = (vMinY + vMaxY) / 2;
  const vHalfX = (vMaxX - vMinX) / 2;
  const vHalfY = (vMaxY - vMinY) / 2;

  const ac = Math.abs(cosR);
  const as = Math.abs(sinR);
  const det = ac * ac - as * as;

  let mergedWidth: number;
  let mergedEmHeight: number;

  if (Math.abs(det) > 1e-6) {
    const hw = (vHalfX * ac - vHalfY * as) / det;
    const hh = (vHalfY * ac - vHalfX * as) / det;
    mergedWidth = Math.max(0.5, hw * 2);
    mergedEmHeight = Math.max(0.5, hh * 2);
  } else {
    mergedWidth = Math.max(vHalfX, vHalfY) * 2;
    mergedEmHeight = mergedWidth;
  }

  const mergedLeft = vcx - mergedWidth / 2;
  const mergedTop = vcy - mergedEmHeight / 2;

  const firstIdx = first.id.replace('text-item-', '');
  const lastIdx = group[group.length - 1].id.replace('text-item-', '');
  const mergedId =
    group.length === 1 ? first.id : `text-phrase-${firstIdx}-${lastIdx}`;

  return {
    id: mergedId,
    text: textParts.join(''),
    fontSize: Math.max(8, Math.min(72, Math.round(maxFontHeight))),
    rotation: first.rotation,
    fontFamily: first.fontFamily,
    bold: first.bold,
    italic: first.italic,
    left: mergedLeft,
    top: mergedTop,
    width: mergedWidth,
    emHeight: mergedEmHeight,
    fontHeight: maxFontHeight,
    baselineX: first.baselineX,
    baselineY: first.baselineY,
  };
}

function mergeAdjacentBoxes(rawBoxes: RawEmBox[]): RawEmBox[] {
  if (rawBoxes.length <= 1) return rawBoxes;

  const merged: RawEmBox[] = [];
  let group: RawEmBox[] = [rawBoxes[0]];

  for (let i = 1; i < rawBoxes.length; i++) {
    const prev = group[group.length - 1];
    const cur = rawBoxes[i];
    if (canMerge(prev, cur)) {
      group.push(cur);
    } else {
      merged.push(mergeGroup(group));
      group = [cur];
    }
  }
  merged.push(mergeGroup(group));

  return merged;
}

/**
 * Converts PDF.js TextItems and merges horizontally-adjacent fragments into
 * phrase-level selectable items. Geometry mirrors PDF.js TextLayer em-box
 * placement, then applies neighbor-clamped cover padding so opaque covers
 * hide the current glyphs without swallowing the line below.
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

  const phrases = mergeAdjacentBoxes(rawBoxes);

  return phrases.map((box) => ({
    id: box.id,
    text: box.text,
    geometry: padForNeighbors(box, phrases, viewport),
    fontSize: box.fontSize,
    rotation: box.rotation,
    fontFamily: box.fontFamily,
    bold: box.bold,
    italic: box.italic,
  }));
}
