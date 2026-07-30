export const BRAND_MARK_VIEWBOX = '0 0 96 96';

export const BRAND_SLOGAN = 'Build higher, faster.';

export const BRAND_MARK_SURFACE = {
  x: 10,
  y: 10,
  width: 76,
  height: 76,
  rx: 20,
} as const;

/**
 * Exact original Apex mark, flipped horizontally.
 * After the flip, the kinked stroke sits on the left and must paint
 * on top so the peak fold stays clean (same as original right-over-left).
 *
 * Original (good reference):
 *   left  M20 72L43 22H56L34 72H20Z   ← under
 *   right M52 22L78 72H61L43 38L52 22Z ← on top (kink + fold)
 */

/** Left wedge — mirrored original right (kink + peak fold; paint on top). */
export const BRAND_MARK_LEFT_LEG = 'M44 22L18 72H35L53 38L44 22Z';

/** Right wedge — mirrored original left (flat top; paint underneath). */
export const BRAND_MARK_RIGHT_LEG = 'M76 72L53 22H40L62 72H76Z';

/** Inner triangle — mirrored original cutout. */
export const BRAND_MARK_INNER = 'M56 72L47 54L38 72H56Z';

/** Outer silhouette used by the animated loader circuit trace. */
export const BRAND_MARK_OUTLINE =
  'M18 72 L44 22 L53 22 L76 72 L62 72 L47 54 L38 72 Z';

/** Approximate perimeter length for loader dash animation. */
export const BRAND_MARK_OUTLINE_LENGTH = 214;
