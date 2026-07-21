import type {
  OverlayFieldError,
  OverlayTextBox,
  PageManifestEntry,
} from '../../shared/types/pdf';

const MAX_OVERLAYS = 50;
const MAX_TEXT_LENGTH = 2_000;
const MIN_WIDTH = 5;
const MIN_HEIGHT = 3;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const FONT_FAMILIES = new Set(['Helvetica', 'Times-Roman', 'Courier']);
const HORIZONTAL_ALIGNMENTS = new Set(['left', 'center', 'right']);
const VERTICAL_ALIGNMENTS = new Set(['top', 'middle', 'bottom']);
const LIST_STYLES = new Set(['none', 'bullet', 'numbered']);

export type OverlayValidationResult =
  | { ok: true; overlays: OverlayTextBox[] }
  | { ok: false; errors: OverlayFieldError[] };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function addError(
  errors: OverlayFieldError[],
  overlayId: string | null,
  field: string,
  code: string,
  message: string
): void {
  errors.push({ overlayId, field, code, message });
}

function hasSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Removes overlays whose page is absent from the active assembly. Reorder and
 * rotation do not alter overlays because page ids and percentage geometry are
 * stable across both operations.
 */
export function stripOrphanOverlays(
  manifest: PageManifestEntry[],
  overlays: OverlayTextBox[]
): OverlayTextBox[] {
  const activePageIds = new Set(
    manifest.filter((page) => !page.deleted).map((page) => page.pageId)
  );
  return overlays.filter((overlay) => activePageIds.has(overlay.pageId));
}

/**
 * Validates an authoritative overlay collection and clamps valid geometry to
 * page bounds. The function is pure so export can reuse the same rules.
 */
export function validateOverlays(
  value: unknown,
  validPageIds: Set<string>
): OverlayValidationResult {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      errors: [
        {
          overlayId: null,
          field: 'overlays',
          code: 'OVERLAYS_INVALID',
          message: 'overlays must be an array.',
        },
      ],
    };
  }

  const errors: OverlayFieldError[] = [];
  const validated: OverlayTextBox[] = [];

  if (value.length > MAX_OVERLAYS) {
    addError(
      errors,
      null,
      'overlays',
      'OVERLAY_COUNT_EXCEEDED',
      `A session may contain at most ${MAX_OVERLAYS} overlays.`
    );
  }

  value.forEach((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      addError(
        errors,
        null,
        `overlays[${index}]`,
        'OVERLAY_INVALID',
        'Overlay must be an object.'
      );
      return;
    }

    const overlay = candidate as Record<string, unknown>;
    const overlayId = typeof overlay.id === 'string' ? overlay.id : null;
    const errorCountBefore = errors.length;

    if (typeof overlay.id !== 'string' || !UUID_PATTERN.test(overlay.id)) {
      addError(
        errors,
        overlayId,
        'id',
        'OVERLAY_ID_INVALID',
        'Overlay id must be a UUID.'
      );
    }
    if (
      typeof overlay.pageId !== 'string' ||
      !validPageIds.has(overlay.pageId)
    ) {
      addError(
        errors,
        overlayId,
        'pageId',
        'OVERLAY_PAGE_INVALID',
        'Overlay pageId must reference an active page in the session.'
      );
    }
    if (typeof overlay.text !== 'string') {
      addError(
        errors,
        overlayId,
        'text',
        'OVERLAY_TEXT_INVALID',
        'Overlay text must be a string.'
      );
    } else if (overlay.text.length > MAX_TEXT_LENGTH) {
      addError(
        errors,
        overlayId,
        'text',
        'OVERLAY_TEXT_TOO_LONG',
        `Overlay text may contain at most ${MAX_TEXT_LENGTH} characters.`
      );
    }
    if (
      typeof overlay.fontFamily !== 'string' ||
      !FONT_FAMILIES.has(overlay.fontFamily)
    ) {
      addError(
        errors,
        overlayId,
        'fontFamily',
        'OVERLAY_FONT_INVALID',
        'fontFamily must be Helvetica, Times-Roman, or Courier.'
      );
    }
    if (
      !Number.isInteger(overlay.fontSize) ||
      (overlay.fontSize as number) < 8 ||
      (overlay.fontSize as number) > 72
    ) {
      addError(
        errors,
        overlayId,
        'fontSize',
        'OVERLAY_FONT_SIZE_INVALID',
        'fontSize must be an integer from 8 through 72.'
      );
    }
    if (typeof overlay.bold !== 'boolean') {
      addError(
        errors,
        overlayId,
        'bold',
        'OVERLAY_BOLD_INVALID',
        'bold must be a boolean.'
      );
    }
    if (typeof overlay.italic !== 'boolean') {
      addError(
        errors,
        overlayId,
        'italic',
        'OVERLAY_ITALIC_INVALID',
        'italic must be a boolean.'
      );
    }
    if (
      typeof overlay.color !== 'string' ||
      !COLOR_PATTERN.test(overlay.color)
    ) {
      addError(
        errors,
        overlayId,
        'color',
        'OVERLAY_COLOR_INVALID',
        'color must use #RRGGBB format.'
      );
    }
    if (
      typeof overlay.horizontalAlign !== 'string' ||
      !HORIZONTAL_ALIGNMENTS.has(overlay.horizontalAlign)
    ) {
      addError(
        errors,
        overlayId,
        'horizontalAlign',
        'OVERLAY_HORIZONTAL_ALIGN_INVALID',
        'horizontalAlign must be left, center, or right.'
      );
    }
    if (
      typeof overlay.verticalAlign !== 'string' ||
      !VERTICAL_ALIGNMENTS.has(overlay.verticalAlign)
    ) {
      addError(
        errors,
        overlayId,
        'verticalAlign',
        'OVERLAY_VERTICAL_ALIGN_INVALID',
        'verticalAlign must be top, middle, or bottom.'
      );
    }
    if (
      !Number.isInteger(overlay.opacity) ||
      (overlay.opacity as number) < 10 ||
      (overlay.opacity as number) > 100
    ) {
      addError(
        errors,
        overlayId,
        'opacity',
        'OVERLAY_OPACITY_INVALID',
        'opacity must be an integer from 10 through 100.'
      );
    }
    if (
      !Number.isInteger(overlay.rotation) ||
      (overlay.rotation as number) < -180 ||
      (overlay.rotation as number) > 180
    ) {
      addError(
        errors,
        overlayId,
        'rotation',
        'OVERLAY_ROTATION_INVALID',
        'rotation must be an integer from -180 through 180.'
      );
    }
    if (
      typeof overlay.listStyle !== 'string' ||
      !LIST_STYLES.has(overlay.listStyle)
    ) {
      addError(
        errors,
        overlayId,
        'listStyle',
        'OVERLAY_LIST_STYLE_INVALID',
        'listStyle must be none, bullet, or numbered.'
      );
    }
    if (
      overlay.linkUrl !== undefined &&
      overlay.linkUrl !== null &&
      (typeof overlay.linkUrl !== 'string' || !hasSafeHttpUrl(overlay.linkUrl))
    ) {
      addError(
        errors,
        overlayId,
        'linkUrl',
        'OVERLAY_LINK_INVALID',
        'linkUrl must be a valid http or https URL.'
      );
    }
    if (
      overlay.linkDisplayText !== undefined &&
      overlay.linkDisplayText !== null &&
      typeof overlay.linkDisplayText !== 'string'
    ) {
      addError(
        errors,
        overlayId,
        'linkDisplayText',
        'OVERLAY_LINK_DISPLAY_TEXT_INVALID',
        'linkDisplayText must be a string.'
      );
    }
    if (!isFiniteNumber(overlay.zIndex)) {
      addError(
        errors,
        overlayId,
        'zIndex',
        'OVERLAY_Z_INDEX_INVALID',
        'zIndex must be a finite number.'
      );
    }

    const geometryFields = ['x', 'y', 'width', 'height'] as const;
    for (const field of geometryFields) {
      if (!isFiniteNumber(overlay[field])) {
        addError(
          errors,
          overlayId,
          field,
          'OVERLAY_GEOMETRY_INVALID',
          `${field} must be a finite number.`
        );
      }
    }

    if (errors.length !== errorCountBefore) return;

    const width = clamp(overlay.width as number, MIN_WIDTH, 100);
    const height = clamp(overlay.height as number, MIN_HEIGHT, 100);
    validated.push({
      ...(overlay as unknown as OverlayTextBox),
      x: clamp(overlay.x as number, 0, 100 - width),
      y: clamp(overlay.y as number, 0, 100 - height),
      width,
      height,
    });
  });

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, overlays: validated };
}
