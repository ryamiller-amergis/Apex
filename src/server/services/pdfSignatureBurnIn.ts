/**
 * pdfSignatureBurnIn — embeds session-scoped signature PNG images onto assembled PDF pages.
 *
 * Uses the same rotated display-coordinate transform as pdfOverlayBurnIn.ts:
 *   1. concat displayToRaw matrix to switch from display space to PDF raw space.
 *   2. concat rotation matrix around the overlay's centre point.
 *   3. Draw the image at local coordinates centred on (0, 0).
 *
 * PNG bytes are embedded once per unique assetId to avoid duplication.
 */
import {
  PDFDocument,
  PDFImage,
  PDFPage,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import type { PdfSignatureOverlay } from '../../shared/types/pdf';

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

/**
 * Embeds each unique PNG asset once into the output document.
 * Returns a map from assetId → embedded PDFImage.
 */
export async function embedSignatureAssets(
  doc: PDFDocument,
  assetsByteMap: Map<string, Uint8Array | Buffer>
): Promise<Map<string, PDFImage>> {
  const embedded = new Map<string, PDFImage>();
  for (const [assetId, pngBytes] of assetsByteMap) {
    const image = await doc.embedPng(pngBytes);
    embedded.set(assetId, image);
  }
  return embedded;
}

/**
 * Burns all signature overlays for one output page into that page.
 *
 * @param page - The assembled output PDF page.
 * @param pageOverlays - Overlays whose pageId matches this page (sorted by zIndex internally).
 * @param embedded - Pre-embedded images keyed by assetId.
 */
export function burnSignaturesOntoPage(
  page: PDFPage,
  pageOverlays: PdfSignatureOverlay[],
  embedded: Map<string, PDFImage>
): void {
  if (pageOverlays.length === 0) return;

  const geo = getDisplayPageGeometry(page);
  const [pageA, pageB, pageC, pageD, pageE, pageF] = geo.displayToRaw;

  for (const overlay of [...pageOverlays].sort((a, b) => a.zIndex - b.zIndex)) {
    const image = embedded.get(overlay.assetId);
    if (!image) {
      throw new Error(
        `Signature asset "${overlay.assetId}" could not be found in the embedded image set. ` +
          `Abort export to prevent a PDF that silently omits a signature.`
      );
    }

    const boxW = (overlay.width / 100) * geo.width;
    const boxH = (overlay.height / 100) * geo.height;

    // In display space the overlay origin is top-left, y increasing downward.
    // PDF y-axis is bottom-up, so convert:
    const displayLeft = (overlay.x / 100) * geo.width;
    const displayTop = (overlay.y / 100) * geo.height;

    // Centre of the overlay in display space (y-up)
    const centerX = displayLeft + boxW / 2;
    const centerY = geo.height - displayTop - boxH / 2;

    const rotationRad = ((overlay.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rotationRad);
    const sin = Math.sin(rotationRad);

    const opacity = Math.max(0, Math.min(1, (overlay.opacity ?? 100) / 100));

    // Set up the same two-matrix transform as pdfOverlayBurnIn:
    //   1. displayToRaw: converts display space (origin top-left) → raw PDF coordinates
    //   2. rotation + translation: centre the rotation around the overlay's centre
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(pageA, pageB, pageC, pageD, pageE, pageF),
      concatTransformationMatrix(cos, sin, -sin, cos, centerX, centerY)
    );

    // Draw image centred at local (0,0). pdf-lib drawImage x,y is bottom-left of image
    // in the current transformed coordinate system.
    page.drawImage(image, {
      x: -boxW / 2,
      y: -boxH / 2,
      width: boxW,
      height: boxH,
      opacity,
    });

    page.pushOperators(popGraphicsState());
  }
}
