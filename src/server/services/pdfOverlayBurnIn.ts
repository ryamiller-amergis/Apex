import {
  PDFDocument,
  PDFFont,
  PDFName,
  PDFPage,
  PDFString,
  StandardFonts,
  clip,
  concatTransformationMatrix,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
} from 'pdf-lib';
import type { OverlayFontFamily, OverlayTextBox } from '../../shared/types/pdf';

export type StandardFontCache = Map<string, PDFFont>;

const LINE_HEIGHT_MULTIPLIER = 1.2;

type StandardFontFamily = 'Helvetica' | 'Times-Roman' | 'Courier';

const STANDARD_FONT_NAMES: Record<
  StandardFontFamily,
  Record<'regular' | 'bold' | 'italic' | 'boldItalic', StandardFonts>
> = {
  Helvetica: {
    regular: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
    boldItalic: StandardFonts.HelveticaBoldOblique,
  },
  'Times-Roman': {
    regular: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
    boldItalic: StandardFonts.TimesRomanBoldItalic,
  },
  Courier: {
    regular: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
    boldItalic: StandardFonts.CourierBoldOblique,
  },
};

function fontKey(overlay: OverlayTextBox): string {
  return `${overlay.fontFamily}:${overlay.bold ? 'bold' : 'regular'}:${
    overlay.italic ? 'italic' : 'normal'
  }`;
}

function standardFontName(overlay: OverlayTextBox): StandardFonts {
  const variant = overlay.bold
    ? overlay.italic
      ? 'boldItalic'
      : 'bold'
    : overlay.italic
      ? 'italic'
      : 'regular';
  return STANDARD_FONT_NAMES[overlay.fontFamily as StandardFontFamily][variant];
}

/** Embeds each standard-font variant at most once for the complete export. */
export async function createStandardFontCache(
  document: PDFDocument,
  overlays: OverlayTextBox[]
): Promise<StandardFontCache> {
  const cache: StandardFontCache = new Map();
  for (const overlay of overlays) {
    const key = fontKey(overlay);
    if (!cache.has(key)) {
      cache.set(key, await document.embedFont(standardFontName(overlay)));
    }
  }
  return cache;
}

function formatDisplayText(overlay: OverlayTextBox): string {
  const raw = overlay.linkDisplayText?.trim()
    ? overlay.linkDisplayText
    : overlay.text;
  if (overlay.listStyle === 'none') return raw;
  return raw
    .split('\n')
    .map((line, index) =>
      overlay.listStyle === 'bullet' ? `• ${line}` : `${index + 1}. ${line}`
    )
    .join('\n');
}

function wrapParagraph(
  paragraph: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number
): string[] {
  if (paragraph.length === 0) return [''];

  const lines: string[] = [];
  let current = '';
  for (const token of paragraph.split(/(\s+)/).filter(Boolean)) {
    const candidate = current + token;
    if (current && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
      lines.push(current.trimEnd());
      current = token.trimStart();
    } else {
      current = candidate;
    }

    while (current && font.widthOfTextAtSize(current, fontSize) > maxWidth) {
      let splitAt = current.length - 1;
      while (
        splitAt > 1 &&
        font.widthOfTextAtSize(current.slice(0, splitAt), fontSize) > maxWidth
      ) {
        splitAt--;
      }
      lines.push(current.slice(0, splitAt));
      current = current.slice(splitAt);
    }
  }
  lines.push(current.trimEnd());
  return lines;
}

function wrapText(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number
): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((paragraph) => wrapParagraph(paragraph, font, fontSize, maxWidth));
}

function parseColor(value: string): ReturnType<typeof rgb> {
  return rgb(
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255
  );
}

interface DisplayPageGeometry {
  width: number;
  height: number;
  displayToRaw: [number, number, number, number, number, number];
}

function getDisplayPageGeometry(page: PDFPage): DisplayPageGeometry {
  const rawWidth = page.getWidth();
  const rawHeight = page.getHeight();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  switch (rotation) {
    case 90:
      return {
        width: rawHeight,
        height: rawWidth,
        displayToRaw: [0, 1, -1, 0, rawWidth, 0],
      };
    case 180:
      return {
        width: rawWidth,
        height: rawHeight,
        displayToRaw: [-1, 0, 0, -1, rawWidth, rawHeight],
      };
    case 270:
      return {
        width: rawHeight,
        height: rawWidth,
        displayToRaw: [0, -1, 1, 0, 0, rawHeight],
      };
    default:
      return {
        width: rawWidth,
        height: rawHeight,
        displayToRaw: [1, 0, 0, 1, 0, 0],
      };
  }
}

function transformPoint(
  matrix: DisplayPageGeometry['displayToRaw'],
  x: number,
  y: number
): { x: number; y: number } {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

function addLinkAnnotation(
  page: PDFPage,
  url: string,
  points: Array<{ x: number; y: number }>
): void {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const annotation = page.doc.context.register(
    page.doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ],
      Border: [0, 0, 0],
      A: {
        Type: 'Action',
        S: 'URI',
        URI: PDFString.of(url),
      },
    })
  );
  page.node.addAnnot(annotation);
}

/**
 * Burns validated overlays onto one output page. Geometry is evaluated in the
 * rotated display coordinate space, then mapped back into PDF page coordinates.
 */
export function burnOverlaysOntoPage(
  page: PDFPage,
  overlays: OverlayTextBox[],
  fonts: StandardFontCache
): void {
  const pageGeometry = getDisplayPageGeometry(page);
  const [pageA, pageB, pageC, pageD, pageE, pageF] = pageGeometry.displayToRaw;

  for (const overlay of [...overlays].sort((a, b) => a.zIndex - b.zIndex)) {
    if (overlay.kind === 'replace' && overlay.coverActive === false) continue;

    const hasText = overlay.text.trim().length > 0;
    const hasCover =
      overlay.kind === 'replace' && Boolean(overlay.backgroundColor);
    if (!hasText && !hasCover) continue;

    const font = fonts.get(fontKey(overlay));
    if (!font) {
      throw new Error(`Missing embedded font for overlay ${overlay.id}`);
    }

    const boxWidth = (overlay.width / 100) * pageGeometry.width;
    const boxHeight = (overlay.height / 100) * pageGeometry.height;
    const boxLeft = (overlay.x / 100) * pageGeometry.width;
    const boxTop =
      pageGeometry.height - (overlay.y / 100) * pageGeometry.height;
    const centerX = boxLeft + boxWidth / 2;
    const centerY = boxTop - boxHeight / 2;
    const angle = (overlay.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const displayText = hasText ? formatDisplayText(overlay) : '';
    const lines = hasText
      ? wrapText(displayText, font, overlay.fontSize, boxWidth)
      : [];
    const lineHeight = overlay.fontSize * LINE_HEIGHT_MULTIPLIER;
    const blockHeight = lines.length * lineHeight;
    const blockTop =
      overlay.verticalAlign === 'middle'
        ? blockHeight / 2
        : overlay.verticalAlign === 'bottom'
          ? -boxHeight / 2 + blockHeight
          : boxHeight / 2;

    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(pageA, pageB, pageC, pageD, pageE, pageF),
      concatTransformationMatrix(cos, sin, -sin, cos, centerX, centerY),
      rectangle(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight),
      clip(),
      endPath()
    );

    if (hasCover && overlay.backgroundColor) {
      page.drawRectangle({
        x: -boxWidth / 2,
        y: -boxHeight / 2,
        width: boxWidth,
        height: boxHeight,
        color: parseColor(overlay.backgroundColor),
        opacity: 1,
      });
    }

    lines.forEach((line, index) => {
      const lineWidth = font.widthOfTextAtSize(line, overlay.fontSize);
      const x =
        overlay.horizontalAlign === 'center'
          ? -lineWidth / 2
          : overlay.horizontalAlign === 'right'
            ? boxWidth / 2 - lineWidth
            : -boxWidth / 2;
      const y = blockTop - overlay.fontSize - index * lineHeight;

      page.drawText(line, {
        x,
        y,
        size: overlay.fontSize,
        font,
        color: parseColor(overlay.color),
        opacity: overlay.opacity / 100,
      });

      const visibleBottom = Math.max(y, -boxHeight / 2);
      const visibleTop = Math.min(y + lineHeight, boxHeight / 2);
      if (overlay.linkUrl && line.length > 0 && visibleTop > visibleBottom) {
        const underlineY = y - Math.max(1, overlay.fontSize * 0.08);
        page.drawLine({
          start: { x, y: underlineY },
          end: { x: x + lineWidth, y: underlineY },
          thickness: Math.max(0.5, overlay.fontSize * 0.05),
          color: parseColor(overlay.color),
          opacity: overlay.opacity / 100,
        });

        const toRawPoint = (localX: number, localY: number) => {
          const displayX = centerX + cos * localX - sin * localY;
          const displayY = centerY + sin * localX + cos * localY;
          return transformPoint(pageGeometry.displayToRaw, displayX, displayY);
        };
        addLinkAnnotation(page, overlay.linkUrl, [
          toRawPoint(x, visibleBottom),
          toRawPoint(x + lineWidth, visibleBottom),
          toRawPoint(x + lineWidth, visibleTop),
          toRawPoint(x, visibleTop),
        ]);
      }
    });

    page.pushOperators(popGraphicsState());
  }
}
