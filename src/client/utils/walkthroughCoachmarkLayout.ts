/**
 * Viewport-aware coachmark placement + scroll policy.
 *
 * Design rules:
 * 1. Position against the registry target itself (the section / control), never an
 *    inner heading — attaching to a heading places the card *inside* the section.
 * 2. Flip only on the same axis (top↔bottom or left↔right).
 * 3. Scroll only when the target is off-screen or the preferred side lacks room;
 *    never force-scroll fixed/sticky header controls (that shifts the chrome).
 * 4. Soft-clamp height; keep footer chrome outside any inner scroll region.
 */

export type CoachmarkSide = 'top' | 'right' | 'bottom' | 'left';

export interface LayoutRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface FloatingSize {
  width: number;
  height: number;
}

/** Gap between the anchor edge and the coachmark (matches Floating UI offset). */
export const COACHMARK_OFFSET_PX = 14;

/** Keep the floating card this far inside the viewport edges. */
export const COACHMARK_VIEWPORT_PADDING_PX = 16;

/** Comfortable default card width before viewport clamping. */
export const COACHMARK_PREFERRED_WIDTH_PX = 420;

/** Comfortable default card height estimate used for placement/scroll room. */
export const COACHMARK_PREFERRED_HEIGHT_PX = 280;

/**
 * If available height is within this many px of the unconstrained card height,
 * expand rather than introduce an inner scrollbar.
 */
export const COACHMARK_SCROLL_SLOP_PX = 64;

/** Soft floor for coachmark max-height when the viewport is large enough. */
export const COACHMARK_SOFT_MIN_HEIGHT_PX = 260;

/** Hard ceiling relative to the viewport. */
export const COACHMARK_MAX_VIEWPORT_RATIO = 0.72;

export function oppositeSide(side: CoachmarkSide): CoachmarkSide {
  switch (side) {
    case 'top':
      return 'bottom';
    case 'bottom':
      return 'top';
    case 'left':
      return 'right';
    case 'right':
      return 'left';
  }
}

export function isVerticalSide(side: CoachmarkSide): boolean {
  return side === 'top' || side === 'bottom';
}

export function sameAxisSides(preferred: CoachmarkSide): [CoachmarkSide, CoachmarkSide] {
  return isVerticalSide(preferred) ? ['top', 'bottom'] : ['left', 'right'];
}

export function availableSpaceForPlacement(
  reference: LayoutRect,
  viewport: ViewportSize,
  padding = COACHMARK_VIEWPORT_PADDING_PX,
): Record<CoachmarkSide, number> {
  return {
    top: reference.top - padding,
    bottom: viewport.height - reference.bottom - padding,
    left: reference.left - padding,
    right: viewport.width - reference.right - padding,
  };
}

function sideFits(
  side: CoachmarkSide,
  space: Record<CoachmarkSide, number>,
  floating: FloatingSize,
  gap: number,
): boolean {
  const needed = isVerticalSide(side) ? floating.height + gap : floating.width + gap;
  return space[side] >= needed;
}

/**
 * Pick a side outside the target. Prefer authored → same-axis opposite → most room
 * on the primary axis. Never auto-flip to the cross axis (covers sibling columns).
 */
export function pickBestCoachmarkPlacement(
  preferred: CoachmarkSide,
  reference: LayoutRect,
  viewport: ViewportSize,
  floating: FloatingSize,
  options?: { padding?: number; gap?: number },
): CoachmarkSide {
  const padding = options?.padding ?? COACHMARK_VIEWPORT_PADDING_PX;
  const gap = options?.gap ?? COACHMARK_OFFSET_PX;
  const space = availableSpaceForPlacement(reference, viewport, padding);
  const [primaryA, primaryB] = sameAxisSides(preferred);
  const primaryOpposite = oppositeSide(preferred);

  if (sideFits(preferred, space, floating, gap)) return preferred;
  if (sideFits(primaryOpposite, space, floating, gap)) return primaryOpposite;

  return space[primaryA] >= space[primaryB] ? primaryA : primaryB;
}

/** Same-axis-only fallback list for Floating UI `flip`. */
export function sameAxisFallbackPlacements(preferred: CoachmarkSide): CoachmarkSide[] {
  return [oppositeSide(preferred)];
}

export function resolveCoachmarkMaxHeight(
  availableHeight: number,
  viewportHeight: number,
  options?: { softMin?: number; slop?: number; maxRatio?: number },
): number {
  const softMin = options?.softMin ?? COACHMARK_SOFT_MIN_HEIGHT_PX;
  const slop = options?.slop ?? COACHMARK_SCROLL_SLOP_PX;
  const maxRatio = options?.maxRatio ?? COACHMARK_MAX_VIEWPORT_RATIO;
  const viewportCap = Math.max(160, Math.floor(viewportHeight * maxRatio));
  const paddedAvailable = Math.max(0, availableHeight);

  if (paddedAvailable >= softMin) {
    return Math.min(viewportCap, paddedAvailable + slop);
  }

  return Math.min(viewportCap, Math.max(paddedAvailable, Math.min(softMin, viewportCap)));
}

export function resolveCoachmarkMaxWidth(
  availableWidth: number,
  preferredWidth = COACHMARK_PREFERRED_WIDTH_PX,
): number {
  return Math.max(280, Math.min(preferredWidth, Math.max(0, availableWidth)));
}

export function isRectFullyInViewport(
  rect: LayoutRect,
  viewport: ViewportSize,
  padding = COACHMARK_VIEWPORT_PADDING_PX,
): boolean {
  return (
    rect.top >= padding &&
    rect.left >= padding &&
    rect.bottom <= viewport.height - padding &&
    rect.right <= viewport.width - padding
  );
}

/**
 * True when the element belongs to app chrome that must never be scrolled.
 * AppHeader is normal-flow content inside .app-main, so position alone cannot
 * identify it; fixed/sticky chrome remains covered for other shell controls.
 */
export function isFixedOrStickyChrome(element: Element): boolean {
  let current: Element | null = element;
  while (current && current instanceof HTMLElement) {
    if (current.classList.contains('app-header')) return true;
    const position = window.getComputedStyle(current).position;
    if (position === 'fixed' || position === 'sticky') return true;
    current = current.parentElement;
  }
  return false;
}

export function shouldScrollAnchorIntoView(
  rect: LayoutRect,
  viewport: ViewportSize,
  preferred: CoachmarkSide = 'bottom',
  floating: FloatingSize = {
    width: COACHMARK_PREFERRED_WIDTH_PX,
    height: COACHMARK_PREFERRED_HEIGHT_PX,
  },
  padding = COACHMARK_VIEWPORT_PADDING_PX,
): boolean {
  if (!isRectFullyInViewport(rect, viewport, padding)) return true;
  const space = availableSpaceForPlacement(rect, viewport, padding);
  const needed = isVerticalSide(preferred)
    ? floating.height + COACHMARK_OFFSET_PX
    : floating.width + COACHMARK_OFFSET_PX;
  return space[preferred] < needed;
}

export function scrollBlockForPlacement(preferred: CoachmarkSide): ScrollLogicalPosition {
  if (preferred === 'bottom') return 'start';
  if (preferred === 'top') return 'end';
  return 'nearest';
}

export function getElementLayoutRect(element: Element): LayoutRect {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

export function getViewportSize(
  view: Pick<Window, 'innerWidth' | 'innerHeight'> = window,
): ViewportSize {
  return { width: view.innerWidth, height: view.innerHeight };
}

export function scrollWalkthroughAnchorIntoView(
  element: Element,
  options?: {
    behavior?: ScrollBehavior;
    force?: boolean;
    preferred?: CoachmarkSide;
    floating?: FloatingSize;
  },
): boolean {
  if (typeof element.scrollIntoView !== 'function') return false;

  // Header/menu chrome: never scroll — it shifts the whole shell.
  if (!options?.force && isFixedOrStickyChrome(element)) {
    return false;
  }

  const preferred = options?.preferred ?? 'bottom';
  const floating = options?.floating ?? {
    width: COACHMARK_PREFERRED_WIDTH_PX,
    height: COACHMARK_PREFERRED_HEIGHT_PX,
  };
  const viewport = getViewportSize();
  const rect = getElementLayoutRect(element);
  if (!options?.force && !shouldScrollAnchorIntoView(rect, viewport, preferred, floating)) {
    return false;
  }

  // Even with force, refuse to scroll fixed chrome unless the caller is explicit
  // about a non-chrome target.
  if (isFixedOrStickyChrome(element)) {
    return false;
  }

  const prefersReduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  element.scrollIntoView({
    behavior: prefersReduced ? 'auto' : (options?.behavior ?? 'smooth'),
    block: scrollBlockForPlacement(preferred),
    inline: 'nearest',
  });
  return true;
}

export interface AnchorHighlightStyle {
  position: 'fixed';
  top: number;
  left: number;
  width: number;
  height: number;
  borderRadius: number;
  border: string;
  boxShadow: string;
  pointerEvents: 'none';
  zIndex: number;
  boxSizing: 'border-box';
}

/**
 * Build a fixed-position highlight rect clamped to the viewport so the overlay
 * cannot expand document scrollable overflow (which shifts header chrome).
 */
export function buildAnchorHighlightStyle(
  rect: LayoutRect,
  viewport: ViewportSize = typeof window !== 'undefined'
    ? getViewportSize()
    : { width: 0, height: 0 },
): AnchorHighlightStyle {
  const pad = 4;
  const top = Math.max(0, rect.top - pad);
  const left = Math.max(0, rect.left - pad);
  const right = Math.min(viewport.width, rect.right + pad);
  const bottom = Math.min(viewport.height, rect.bottom + pad);
  return {
    position: 'fixed',
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    borderRadius: 8,
    border: '2px solid var(--accent-color)',
    boxShadow: '0 0 0 6px color-mix(in srgb, var(--accent-color) 22%, transparent)',
    pointerEvents: 'none',
    zIndex: 1200,
    boxSizing: 'border-box',
  };
}
