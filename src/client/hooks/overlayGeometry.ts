/** Page-relative geometry helpers for Overlay Text Boxes (percent, top-left origin). */

export const OVERLAY_DEFAULT_WIDTH = 30;
export const OVERLAY_DEFAULT_HEIGHT = 10;
export const OVERLAY_MIN_WIDTH = 5;
export const OVERLAY_MIN_HEIGHT = 3;
export const MAX_SESSION_OVERLAYS = 50;

export interface OverlayBoxGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OverlayResizeHandle =
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w'
  | 'nw';

/**
 * Clamps a box so it stays fully on-page (0–100%) and at least the minimum size.
 */
export function clampOverlayBox(box: OverlayBoxGeometry): OverlayBoxGeometry {
  const width = Math.min(100, Math.max(OVERLAY_MIN_WIDTH, box.width));
  const height = Math.min(100, Math.max(OVERLAY_MIN_HEIGHT, box.height));
  const x = Math.min(Math.max(0, box.x), 100 - width);
  const y = Math.min(Math.max(0, box.y), 100 - height);
  return { x, y, width, height };
}

/**
 * Places a default ~30% × 10% box with its top-left at the click, then clamps on-page.
 */
export function defaultBoxAt(xPct: number, yPct: number): OverlayBoxGeometry {
  return clampOverlayBox({
    x: xPct,
    y: yPct,
    width: OVERLAY_DEFAULT_WIDTH,
    height: OVERLAY_DEFAULT_HEIGHT,
  });
}

/** Moves a box by a page-relative delta and keeps it fully on-page. */
export function moveOverlayBox(
  box: OverlayBoxGeometry,
  deltaXPct: number,
  deltaYPct: number
): OverlayBoxGeometry {
  return clampOverlayBox({
    ...box,
    x: box.x + deltaXPct,
    y: box.y + deltaYPct,
  });
}

/**
 * Resizes a box from one of its eight handles. Opposite edges remain anchored,
 * and the result observes both minimum size and page bounds.
 */
export function resizeOverlayFromHandle(
  box: OverlayBoxGeometry,
  handle: OverlayResizeHandle,
  deltaXPct: number,
  deltaYPct: number
): OverlayBoxGeometry {
  let left = box.x;
  let right = box.x + box.width;
  let top = box.y;
  let bottom = box.y + box.height;

  if (handle.includes('w')) {
    left = Math.min(right - OVERLAY_MIN_WIDTH, Math.max(0, left + deltaXPct));
  }
  if (handle.includes('e')) {
    right = Math.max(
      left + OVERLAY_MIN_WIDTH,
      Math.min(100, right + deltaXPct)
    );
  }
  if (handle.includes('n')) {
    top = Math.min(bottom - OVERLAY_MIN_HEIGHT, Math.max(0, top + deltaYPct));
  }
  if (handle.includes('s')) {
    bottom = Math.max(
      top + OVERLAY_MIN_HEIGHT,
      Math.min(100, bottom + deltaYPct)
    );
  }

  return clampOverlayBox({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

/** Converts a CSS-pixel pointer delta into page-relative percentages. */
export function clientDeltaToPagePercent(
  deltaX: number,
  deltaY: number,
  pageSize: { width: number; height: number }
): { xPct: number; yPct: number } {
  return {
    xPct: pageSize.width > 0 ? (deltaX / pageSize.width) * 100 : 0,
    yPct: pageSize.height > 0 ? (deltaY / pageSize.height) * 100 : 0,
  };
}

/**
 * Converts a pointer position relative to a page element's bounding box into
 * page-relative percentages (top-left origin).
 */
export function clientPointToPagePercent(
  clientX: number,
  clientY: number,
  pageRect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
): { xPct: number; yPct: number } {
  if (pageRect.width <= 0 || pageRect.height <= 0) {
    return { xPct: 0, yPct: 0 };
  }
  const xPct = ((clientX - pageRect.left) / pageRect.width) * 100;
  const yPct = ((clientY - pageRect.top) / pageRect.height) * 100;
  return {
    xPct: Math.min(100, Math.max(0, xPct)),
    yPct: Math.min(100, Math.max(0, yPct)),
  };
}
