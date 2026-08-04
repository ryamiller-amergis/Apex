import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFPage,
  PDFRawStream,
  PDFRef,
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

type FontVariant = 'regular' | 'bold' | 'italic' | 'boldItalic';

const STANDARD_FAMILIES = new Set<OverlayFontFamily>([
  'Helvetica',
  'Times-Roman',
  'Courier',
]);

const CUSTOM_FONT_FILE_PREFIX: Partial<Record<OverlayFontFamily, string>> = {
  Roboto: 'Roboto',
  'Open Sans': 'OpenSans',
  Lato: 'Lato',
  Montserrat: 'Montserrat',
  Merriweather: 'Merriweather',
  'Noto Sans': 'NotoSans',
};

const VARIANT_FILE_SUFFIX: Record<FontVariant, string> = {
  regular: 'Regular',
  bold: 'Bold',
  italic: 'Italic',
  boldItalic: 'BoldItalic',
};

function overlayVariant(overlay: OverlayTextBox): FontVariant {
  return overlay.bold
    ? overlay.italic
      ? 'boldItalic'
      : 'bold'
    : overlay.italic
      ? 'italic'
      : 'regular';
}

export function resolveCustomFontPath(
  family: OverlayFontFamily,
  variant: FontVariant
): string {
  const prefix = CUSTOM_FONT_FILE_PREFIX[family];
  if (!prefix) {
    throw new Error(`No bundled font for family ${family}`);
  }
  return path.resolve(
    process.cwd(),
    'public',
    'fonts',
    'pdf',
    `${prefix}-${VARIANT_FILE_SUFFIX[variant]}.ttf`
  );
}

export async function readCustomFontBytes(
  family: OverlayFontFamily,
  variant: FontVariant
): Promise<Buffer> {
  const filePath = resolveCustomFontPath(family, variant);
  try {
    return await fs.readFile(filePath);
  } catch {
    throw new Error(`Missing bundled font asset: ${filePath}`);
  }
}

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

// ── Embedded font extraction ───────────────────────────────────────────────────

/**
 * Family-name hints used server-side to match an embedded PDF font's BaseFont
 * name to one of our supported OverlayFontFamily values. Mirrors the heuristics
 * in the client-side pdfNativeTextItems.ts mapPdfFontToOverlayFamily.
 */
const FAMILY_HINTS: Record<OverlayFontFamily, string[]> = {
  Helvetica: ['helvetica', 'arial'],
  'Times-Roman': ['times', 'timesnewroman'],
  Courier: ['courier', 'couriernew', 'mono', 'consolas', 'menlo'],
  Roboto: ['roboto', 'calibri', 'aptos', 'segoe', 'opensans', 'opensan'],
  'Open Sans': ['opensans', 'opensan'],
  Lato: ['lato'],
  Montserrat: ['montserrat'],
  Merriweather: ['merriweather', 'georgia', 'garamond', 'cambria'],
  'Noto Sans': ['notosans', 'noto'],
};

function fontNameMatchesFamily(
  rawName: string,
  family: OverlayFontFamily
): boolean {
  // Strip subset prefix e.g. "ABCDEF+Calibri" → "Calibri"
  const clean = rawName.replace(/^[A-Z]{6}\+/, '');
  const lower = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (FAMILY_HINTS[family] ?? []).some((hint) => lower.includes(hint));
}

function lookupDict(doc: PDFDocument, value: unknown): PDFDict | null {
  if (!value) return null;
  if (value instanceof PDFRef) {
    const obj = doc.context.lookup(value);
    return obj instanceof PDFDict ? obj : null;
  }
  return value instanceof PDFDict ? value : null;
}

function lookupStream(doc: PDFDocument, value: unknown): PDFRawStream | null {
  if (!value) return null;
  if (value instanceof PDFRef) {
    const obj = doc.context.lookup(value);
    return obj instanceof PDFRawStream ? obj : null;
  }
  return value instanceof PDFRawStream ? value : null;
}

function decodeStream(stream: PDFRawStream): Uint8Array {
  const filter = stream.dict.get(PDFName.of('Filter'));
  const raw = stream.contents;
  const filterName = filter instanceof PDFName ? filter.asString() : '';
  if (filterName === 'FlateDecode') {
    try {
      return inflateSync(Buffer.from(raw));
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Attempts to extract unsubsetted TTF/OTF font bytes from a copied PDF page
 * whose resources are already available inside `doc`. Subsetted fonts (whose
 * BaseFont name begins with a 6-uppercase-letter prefix) are skipped because
 * only a partial glyph set is present and using it for arbitrary replacement
 * text would produce missing glyphs.
 *
 * Returns null when no suitable match is found; never throws.
 */
async function tryExtractFontBytesFromPage(
  doc: PDFDocument,
  page: PDFPage,
  targetFamily: OverlayFontFamily
): Promise<Uint8Array | null> {
  try {
    const resourcesValue = page.node.get(PDFName.of('Resources'));
    const resources = lookupDict(doc, resourcesValue);
    if (!resources) return null;

    const fontDictValue = resources.get(PDFName.of('Font'));
    const fontDict = lookupDict(doc, fontDictValue);
    if (!fontDict) return null;

    for (const fontKey of fontDict.keys()) {
      try {
        const fontObj = lookupDict(doc, fontDict.get(fontKey));
        if (!fontObj) continue;

        const baseFontValue = fontObj.get(PDFName.of('BaseFont'));
        const baseFontName =
          baseFontValue instanceof PDFName ? baseFontValue.asString() : '';

        // Skip subsetted fonts — partial glyph set would corrupt replacement
        if (/^[A-Z]{6}\+/.test(baseFontName)) continue;

        if (!fontNameMatchesFamily(baseFontName, targetFamily)) continue;

        const descriptorValue = fontObj.get(PDFName.of('FontDescriptor'));
        const descriptor = lookupDict(doc, descriptorValue);
        if (!descriptor) continue;

        for (const fileKey of ['FontFile2', 'FontFile3', 'FontFile'] as const) {
          const fileValue = descriptor.get(PDFName.of(fileKey));
          const fileStream = lookupStream(doc, fileValue);
          if (!fileStream) continue;
          const bytes = decodeStream(fileStream);
          if (bytes.length > 256) return bytes;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Any parsing error → fall through to bundled font
  }
  return null;
}

/** Embeds each used font variant at most once for the complete export. */
export async function createOverlayFontCache(
  document: PDFDocument,
  overlays: OverlayTextBox[],
  pagesByPageId?: Map<string, PDFPage>
): Promise<StandardFontCache> {
  const cache: StandardFontCache = new Map();
  let fontkitRegistered = false;
  for (const overlay of overlays) {
    const key = fontKey(overlay);
    if (cache.has(key)) continue;

    // For replace overlays, try to reuse the original embedded font from the
    // source page. This only succeeds for fully-embedded (non-subsetted) fonts,
    // which represent a minority of real-world PDFs — subsetted fonts are
    // skipped and fall through to the bundled substitutes below.
    if (overlay.kind === 'replace' && pagesByPageId) {
      const page = pagesByPageId.get(overlay.pageId);
      if (page) {
        const extracted = await tryExtractFontBytesFromPage(
          document,
          page,
          overlay.fontFamily
        );
        if (extracted) {
          if (!fontkitRegistered) {
            document.registerFontkit(fontkit);
            fontkitRegistered = true;
          }
          try {
            cache.set(
              key,
              await document.embedFont(extracted, { subset: false })
            );
            continue;
          } catch {
            // Fall through to bundled font
          }
        }
      }
    }

    if (STANDARD_FAMILIES.has(overlay.fontFamily)) {
      cache.set(key, await document.embedFont(standardFontName(overlay)));
      continue;
    }

    if (!fontkitRegistered) {
      document.registerFontkit(fontkit);
      fontkitRegistered = true;
    }
    const bytes = await readCustomFontBytes(
      overlay.fontFamily,
      overlayVariant(overlay)
    );
    cache.set(key, await document.embedFont(bytes, { subset: true }));
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
      if (current.length <= 1) break;
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

    if (hasCover && overlay.backgroundColor) {
      const cover = overlay.replacementCover ?? overlay;
      const coverWidth = (cover.width / 100) * pageGeometry.width;
      const coverHeight = (cover.height / 100) * pageGeometry.height;
      const coverLeft = (cover.x / 100) * pageGeometry.width;
      const coverTop =
        pageGeometry.height - (cover.y / 100) * pageGeometry.height;
      const coverCenterX = coverLeft + coverWidth / 2;
      const coverCenterY = coverTop - coverHeight / 2;

      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(pageA, pageB, pageC, pageD, pageE, pageF),
        concatTransformationMatrix(
          cos,
          sin,
          -sin,
          cos,
          coverCenterX,
          coverCenterY
        )
      );
      page.drawRectangle({
        x: -coverWidth / 2,
        y: -coverHeight / 2,
        width: coverWidth,
        height: coverHeight,
        color: parseColor(overlay.backgroundColor),
        opacity: 1,
      });
      page.pushOperators(popGraphicsState());
    }

    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(pageA, pageB, pageC, pageD, pageE, pageF),
      concatTransformationMatrix(cos, sin, -sin, cos, centerX, centerY),
      rectangle(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight),
      clip(),
      endPath()
    );

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
      if (
        (overlay.linkUrl || overlay.underline) &&
        line.length > 0 &&
        visibleTop > visibleBottom
      ) {
        const underlineY = y - Math.max(1, overlay.fontSize * 0.08);
        page.drawLine({
          start: { x, y: underlineY },
          end: { x: x + lineWidth, y: underlineY },
          thickness: Math.max(0.5, overlay.fontSize * 0.05),
          color: parseColor(overlay.color),
          opacity: overlay.opacity / 100,
        });

        if (overlay.linkUrl) {
          const toRawPoint = (localX: number, localY: number) => {
            const displayX = centerX + cos * localX - sin * localY;
            const displayY = centerY + sin * localX + cos * localY;
            return transformPoint(
              pageGeometry.displayToRaw,
              displayX,
              displayY
            );
          };
          addLinkAnnotation(page, overlay.linkUrl, [
            toRawPoint(x, visibleBottom),
            toRawPoint(x + lineWidth, visibleBottom),
            toRawPoint(x + lineWidth, visibleTop),
            toRawPoint(x, visibleTop),
          ]);
        }
      }
    });

    page.pushOperators(popGraphicsState());
  }
}
