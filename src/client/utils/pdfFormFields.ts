/**
 * Client-side utilities for mapping PDF.js widget annotations into
 * page-relative geometry and matching them to the server-side field catalog.
 *
 * PDF.js annotation viewport geometry is in the rotated display coordinate
 * space with origin at the top-left, scaled to the full canvas resolution.
 * We convert to percentage coordinates (0–100) to match OverlayTextBox.
 */
import type { PdfTextFormFieldDefinition, PdfTextFormValue } from '../../shared/types/pdf';

export interface PdfJsAnnotation {
  annotationType: number;
  fieldType?: string;
  fieldName?: string;
  readOnly?: boolean;
  multiLine?: boolean;
  maxLen?: number | null;
  rect: [number, number, number, number]; // [x1, y1, x2, y2] in viewport pixels
}

export interface FormFieldGeometry {
  fieldName: string;
  multiline: boolean;
  maxLength: number | null;
  /** Percentage geometry using a top-left origin, matching OverlayTextBox. */
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
}

const ANNOTATION_TYPE_WIDGET = 20; // PDF.js AnnotationType.WIDGET

/**
 * Filters a PDF.js annotation list to writable AcroForm text widgets and
 * converts their rects to percentage geometry.
 *
 * The server-side catalog is used purely as supplementary metadata
 * (multiline flag, max length).  A field is rendered regardless of whether
 * it appears in the catalog — this keeps the UI working even when the catalog
 * is empty (e.g. the file was ingested before cataloging was introduced, or
 * the PDF uses fields that the server-side parser can't detect).
 */
export function extractFormFieldGeometry(
  annotations: PdfJsAnnotation[],
  catalog: PdfTextFormFieldDefinition[],
  viewportWidth: number,
  viewportHeight: number
): FormFieldGeometry[] {
  if (viewportWidth <= 0 || viewportHeight <= 0) return [];

  const catalogByName = new Map(catalog.map((f) => [f.fieldName, f]));
  const result: FormFieldGeometry[] = [];
  const seen = new Set<string>();

  for (const annotation of annotations) {
    if (annotation.annotationType !== ANNOTATION_TYPE_WIDGET) continue;
    if (annotation.fieldType !== 'Tx') continue;
    if (annotation.readOnly) continue;

    const fieldName = annotation.fieldName ?? '';
    if (!fieldName) continue;
    if (seen.has(fieldName)) continue;
    seen.add(fieldName);

    const [x1, y1, x2, y2] = annotation.rect;
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    // Prefer catalog metadata; fall back to PDF.js annotation data.
    const meta = catalogByName.get(fieldName);
    const reportedMaxLength = meta
      ? meta.maxLength
      : (annotation.maxLen ?? null);
    result.push({
      fieldName,
      multiline: meta?.multiline ?? annotation.multiLine ?? false,
      // PDF.js uses 0 for an unconstrained field, while HTML maxLength=0
      // prevents every character from being entered.
      maxLength:
        reportedMaxLength !== null && reportedMaxLength > 0
          ? reportedMaxLength
          : null,
      xPct: (left / viewportWidth) * 100,
      yPct: (top / viewportHeight) * 100,
      widthPct: (width / viewportWidth) * 100,
      heightPct: (height / viewportHeight) * 100,
    });
  }

  return result;
}

/**
 * Returns the current value for a field from the persisted values array.
 * Falls back to an empty string when no value is persisted.
 */
export function getFieldValue(
  values: PdfTextFormValue[],
  fileId: string,
  fieldName: string
): string {
  return (
    values.find((v) => v.fileId === fileId && v.fieldName === fieldName)?.value ?? ''
  );
}

/**
 * Returns a new values array with the given field's value replaced.
 * If no entry exists for this field, one is appended.
 */
export function setFieldValue(
  values: PdfTextFormValue[],
  fileId: string,
  fieldName: string,
  value: string
): PdfTextFormValue[] {
  const existing = values.findIndex(
    (v) => v.fileId === fileId && v.fieldName === fieldName
  );
  if (existing !== -1) {
    return values.map((v, i) => (i === existing ? { ...v, value } : v));
  }
  return [...values, { fileId, fieldName, value }];
}
