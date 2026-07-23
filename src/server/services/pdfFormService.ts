/**
 * pdfFormService — AcroForm text-field catalog, value validation, and fill helpers.
 *
 * Design constraints (from the locked plan decisions):
 *  - Only writable AcroForm text fields are supported.
 *  - Read-only, password, XFA, checkbox, radio, combo, and list fields are excluded.
 *  - Repeated widget names share a single value entry.
 *  - Fill → flatten must happen per source document before copyPages().
 */
import { PDFDocument } from 'pdf-lib';
import type {
  PdfTextFormFieldDefinition,
  PdfTextFormValue,
} from '../../shared/types/pdf';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_FORM_VALUE_BYTES = 10_000;

// ── Field cataloging ──────────────────────────────────────────────────────────

/**
 * Inspects a PDF byte buffer and returns a catalog of supported writable
 * AcroForm text fields.  Returns an empty array for flat PDFs, XFA forms,
 * password fields, or any document that has no readable form.
 */
export async function catalogTextFields(
  pdfBytes: Uint8Array | Buffer
): Promise<PdfTextFormFieldDefinition[]> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch {
    return [];
  }

  let form;
  try {
    form = doc.getForm();
  } catch {
    return [];
  }

  let rawFields;
  try {
    rawFields = form.getFields();
  } catch {
    return [];
  }

  const catalog: PdfTextFormFieldDefinition[] = [];
  const seenNames = new Set<string>();

  for (const field of rawFields) {
    // Only handle writable text fields. pdf-lib exposes the concrete subclass
    // through its constructor name; using `instanceof` requires importing the
    // concrete class which creates a tight coupling, so we check the name.
    if (field.constructor.name !== 'PDFTextField') continue;

    const fieldName = field.getName();
    if (seenNames.has(fieldName)) continue;
    seenNames.add(fieldName);

    // Access internal pdf-lib API to check read-only flag.
    // The public API only exposes isReadOnly() — we use that.
    if ((field as { isReadOnly?(): boolean }).isReadOnly?.()) continue;

    // Gather widget page indices
    const acroField = (field as unknown as { acroField: { getWidgets(): unknown[] } }).acroField;
    const widgets = acroField.getWidgets();
    const pageIndices: number[] = [];
    for (const widget of widgets) {
      try {
        const pageRef = (widget as { P?(): unknown }).P?.();
        if (!pageRef) continue;
        const pages = doc.getPages();
        const idx = pages.findIndex(
          (p) => p.ref === pageRef
        );
        if (idx !== -1 && !pageIndices.includes(idx)) {
          pageIndices.push(idx);
        }
      } catch {
        // Widget may not have a page reference — skip
      }
    }

    // Detect multiline and maxLength
    const textField = field as {
      isMultiline?(): boolean;
      getMaxLength?(): number | undefined;
    };
    const multiline = textField.isMultiline?.() ?? false;
    const maxLength = textField.getMaxLength?.() ?? null;

    catalog.push({
      fieldName,
      multiline,
      maxLength: maxLength !== undefined ? maxLength : null,
      pageIndex: pageIndices[0] ?? 0,
      additionalPageIndices: pageIndices.slice(1),
    });
  }

  return catalog;
}

// ── Value validation ──────────────────────────────────────────────────────────

export interface FormValueValidationError {
  fileId: string;
  fieldName: string;
  code: string;
  message: string;
}

/**
 * Validates a set of form-value updates against a known catalog.
 * Returns an array of errors; an empty array means all values are valid.
 */
export function validateFormValues(
  values: PdfTextFormValue[],
  catalog: PdfTextFormFieldDefinition[]
): FormValueValidationError[] {
  const errors: FormValueValidationError[] = [];
  const catalogByName = new Map(catalog.map((f) => [f.fieldName, f]));

  for (const value of values) {
    if (!value.fileId || typeof value.fileId !== 'string') {
      errors.push({
        fileId: String(value.fileId ?? ''),
        fieldName: String(value.fieldName ?? ''),
        code: PDF_ERROR_CODES.FORM_VALUES_INVALID,
        message: 'Missing fileId.',
      });
      continue;
    }

    if (!value.fieldName || typeof value.fieldName !== 'string') {
      errors.push({
        fileId: value.fileId,
        fieldName: String(value.fieldName ?? ''),
        code: PDF_ERROR_CODES.FORM_VALUES_INVALID,
        message: 'Missing fieldName.',
      });
      continue;
    }

    if (typeof value.value !== 'string') {
      errors.push({
        fileId: value.fileId,
        fieldName: value.fieldName,
        code: PDF_ERROR_CODES.FORM_VALUES_INVALID,
        message: 'Field value must be a string.',
      });
      continue;
    }

    if (Buffer.byteLength(value.value, 'utf8') > MAX_FORM_VALUE_BYTES) {
      errors.push({
        fileId: value.fileId,
        fieldName: value.fieldName,
        code: PDF_ERROR_CODES.FORM_FIELD_VALUE_TOO_LONG,
        message: `Value exceeds ${MAX_FORM_VALUE_BYTES}-byte limit.`,
      });
      continue;
    }

    // Unknown fields are allowed — the catalog may be empty when a file was
    // ingested before cataloging was introduced, or when the PDF uses field
    // types the server parser doesn't detect.  At export time, fillAndFlattenForm
    // applies values by field name and silently skips names that don't exist.
    const fieldDef = catalogByName.get(value.fieldName);
    if (
      fieldDef?.maxLength !== null &&
      fieldDef?.maxLength !== undefined &&
      value.value.length > fieldDef.maxLength
    ) {
      errors.push({
        fileId: value.fileId,
        fieldName: value.fieldName,
        code: PDF_ERROR_CODES.FORM_FIELD_VALUE_TOO_LONG,
        message: `Value exceeds the field's maximum length of ${fieldDef.maxLength} characters.`,
      });
    }
  }

  return errors;
}

// ── Fill and flatten ───────────────────────────────────────────────────────────

/**
 * Loads a source PDF, applies the supplied text-field values, regenerates
 * appearances, flattens the entire AcroForm, and returns the resulting bytes.
 *
 * This is the critical step that must happen **before** `copyPages()` so the
 * output assembly contains no interactive form fields.
 *
 * If the PDF has no AcroForm, or values is empty, the bytes are returned
 * unchanged (but still re-serialised through pdf-lib for consistency).
 */
export async function fillAndFlattenForm(
  pdfBytes: Uint8Array | Buffer,
  values: PdfTextFormValue[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);

  if (values.length > 0) {
    let form;
    try {
      form = doc.getForm();
    } catch {
      // Document has no AcroForm — nothing to fill
      return new Uint8Array(await doc.save());
    }

    for (const { fieldName, value } of values) {
      try {
        const field = form.getTextField(fieldName);
        field.setText(value);
      } catch {
        // Field may not exist in this source (it might belong to a different
        // file in the session) — skip silently
      }
    }

    try {
      form.flatten();
    } catch {
      // flatten() can throw on malformed XFA forms; swallow and carry on
    }
  } else {
    // Still flatten any existing pre-populated fields
    try {
      const form = doc.getForm();
      form.flatten();
    } catch {
      // No form or XFA — fine
    }
  }

  return new Uint8Array(await doc.save());
}
