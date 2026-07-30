/**
 * Fetches PDF.js widget annotations for a single page, transforms their rects
 * into viewport pixel coordinates, and cross-references with the server-side
 * field catalog to produce percentage geometry for PdfFormFieldLayer.
 *
 * Results are cached by (fileUrl, pageIndex, rotation, catalogKey) so that
 * switching back to a previously-viewed page does not re-fetch annotations.
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfTextFormFieldDefinition } from '../../shared/types/pdf';
import {
  extractFormFieldGeometry,
  type FormFieldGeometry,
  type PdfJsAnnotation,
} from '../utils/pdfFormFields';

export interface UsePdfFormFieldsResult {
  fields: FormFieldGeometry[];
  isLoading: boolean;
}

const cache = new Map<string, FormFieldGeometry[]>();

export function usePdfFormFields(
  document: PDFDocumentProxy | null,
  fileUrl: string | null,
  sourcePageIndex: number,
  rotation: 0 | 90 | 180 | 270,
  catalog: PdfTextFormFieldDefinition[],
  enabled: boolean
): UsePdfFormFieldsResult {
  const [state, setState] = useState<UsePdfFormFieldsResult>({
    fields: [],
    isLoading: false,
  });
  const requestRef = useRef(0);

  // Derive a stable primitive key from the catalog. The effect depends on this
  // string rather than the `catalog` array reference, so upstream churn (a new
  // `[]` produced every render when a file has no textFormFields) can no longer
  // re-trigger the effect and cause an infinite setState loop.
  const catalogKey = useMemo(
    () => catalog.map((f) => f.fieldName).sort().join('\x00'),
    [catalog]
  );
  // Read the latest catalog inside the effect without adding it as a dependency.
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

  useEffect(() => {
    if (!enabled || !document || !fileUrl) {
      setState((prev) =>
        prev.fields.length === 0 && !prev.isLoading
          ? prev
          : { fields: [], isLoading: false }
      );
      return;
    }

    const cacheKey = `${fileUrl}:${sourcePageIndex}:${rotation}:${catalogKey}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      setState({ fields: cached, isLoading: false });
      return;
    }

    const requestId = ++requestRef.current;
    setState({ fields: [], isLoading: true });

    void (async () => {
      try {
        const page = await document.getPage(sourcePageIndex + 1);
        if (requestRef.current !== requestId) return;

        // Viewport at scale=1 with rotation applied — gives us the coordinate
        // system that the rendered canvas uses.
        const viewport = page.getViewport({ scale: 1, rotation });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawAnnotations: any[] = await page.getAnnotations();
        if (requestRef.current !== requestId) return;

        // Transform each annotation rect from PDF page space (bottom-left origin,
        // unrotated) into the viewport pixel space (top-left origin, rotated).
        const annotations: PdfJsAnnotation[] = rawAnnotations.map((ann) => {
          const [x1, y1, x2, y2] = ann.rect as number[];
          // Convert all four corners and derive the bounding box, because
          // rotation can swap x/y ordering.
          const [vx1, vy1] = viewport.convertToViewportPoint(x1, y1);
          const [vx2, vy2] = viewport.convertToViewportPoint(x2, y2);
          return {
            annotationType: ann.annotationType,
            fieldType: ann.fieldType,
            fieldName: ann.fieldName,
            readOnly: ann.readOnly,
            multiLine: ann.multiLine,
            maxLen: ann.maxLen,
            rect: [vx1, vy1, vx2, vy2] as [number, number, number, number],
          };
        });

        const fields = extractFormFieldGeometry(
          annotations,
          catalogRef.current,
          viewport.width,
          viewport.height
        );

        cache.set(cacheKey, fields);
        if (requestRef.current !== requestId) return;
        setState({ fields, isLoading: false });
      } catch {
        if (requestRef.current !== requestId) return;
        setState({ fields: [], isLoading: false });
      }
    })();

    return () => {
      requestRef.current += 1;
    };
  // Depends on catalogKey (a stable primitive) instead of the catalog array.
  }, [document, enabled, fileUrl, sourcePageIndex, rotation, catalogKey]);

  return state;
}
