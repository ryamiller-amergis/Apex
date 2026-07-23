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
  'Times-Roman': 'Times New Roman',
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

export const OVERLAY_COLOR_PRESETS = [
  // Row 1 — Neutrals
  '#000000', '#404040', '#808080', '#A0A0A0', '#D0D0D0', '#FFFFFF',
  // Row 2 — Reds
  '#7F0000', '#C00000', '#FF0000', '#FF6666', '#FFAAAA', '#FFE4E1',
  // Row 3 — Oranges / Yellows
  '#7F3F00', '#CC6600', '#FF8000', '#FFCC00', '#FFD700', '#FFF9C4',
  // Row 4 — Greens
  '#003300', '#008000', '#00B050', '#70AD47', '#A9D18E', '#E2EFDA',
  // Row 5 — Blues
  '#001F5B', '#0070C0', '#4472C4', '#2196F3', '#9DC3E6', '#DEEAF1',
  // Row 6 — Purples / Pinks
  '#4B0082', '#7030A0', '#C71585', '#FF69B4', '#DDA0DD', '#F8D7DA',
] as const;

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
