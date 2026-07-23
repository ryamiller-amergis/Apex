import type {
  OverlayFontFamily,
  OverlayListStyle,
} from '../../shared/types/pdf';
import { PDF_OVERLAY_FONT_FAMILIES } from '../../shared/types/pdf';

export const OVERLAY_FONT_FAMILIES: readonly OverlayFontFamily[] =
  PDF_OVERLAY_FONT_FAMILIES;

export const OVERLAY_FONT_STACKS: Record<OverlayFontFamily, string> = {
  Helvetica: 'Helvetica, Arial, sans-serif',
  'Times-Roman': '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
  Roboto: '"Roboto", sans-serif',
  'Open Sans': '"Open Sans", sans-serif',
  Lato: '"Lato", sans-serif',
  Montserrat: '"Montserrat", sans-serif',
  Merriweather: '"Merriweather", serif',
  'Noto Sans': '"Noto Sans", sans-serif',
};

export const OVERLAY_FONT_LABELS: Record<OverlayFontFamily, string> = {
  Helvetica: 'Helvetica',
  'Times-Roman': 'Times Roman',
  Courier: 'Courier',
  Roboto: 'Roboto',
  'Open Sans': 'Open Sans',
  Lato: 'Lato',
  Montserrat: 'Montserrat',
  Merriweather: 'Merriweather',
  'Noto Sans': 'Noto Sans',
};

export const MIN_OVERLAY_FONT_SIZE = 8;
export const MAX_OVERLAY_FONT_SIZE = 72;
export const MIN_OVERLAY_OPACITY = 10;
export const MAX_OVERLAY_OPACITY = 100;
export const MIN_OVERLAY_ROTATION = -180;
export const MAX_OVERLAY_ROTATION = 180;

const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/i;

export function isOverlayColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value);
}

export function normalizeOverlayColor(value: string): string | null {
  return isOverlayColor(value) ? value.toUpperCase() : null;
}

export function isOverlayFontSize(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_OVERLAY_FONT_SIZE &&
    value <= MAX_OVERLAY_FONT_SIZE
  );
}

export function clampOverlayOpacity(value: number): number {
  return Math.min(
    MAX_OVERLAY_OPACITY,
    Math.max(MIN_OVERLAY_OPACITY, Math.round(value))
  );
}

export function normalizeOverlayRotation(
  value: number,
  snapToFifteen = false
): number | null {
  if (
    !Number.isFinite(value) ||
    value < MIN_OVERLAY_ROTATION ||
    value > MAX_OVERLAY_ROTATION
  ) {
    return null;
  }
  const rounded = Math.round(value);
  return snapToFifteen ? Math.round(rounded / 15) * 15 : rounded;
}

export function formatOverlayDisplayText(
  text: string,
  listStyle: OverlayListStyle,
  linkDisplayText?: string | null
): string {
  const raw = linkDisplayText?.trim() ? linkDisplayText : text;
  if (listStyle === 'none') return raw;

  return raw
    .split('\n')
    .map((line, index) =>
      listStyle === 'bullet' ? `• ${line}` : `${index + 1}. ${line}`
    )
    .join('\n');
}
