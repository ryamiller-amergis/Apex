/**
 * Reusable PDF fixture builders for unit tests.
 * Creates synthetic PDFs with known AcroForm structure so tests can
 * assert on fill/flatten/copy behaviour without requiring real document files.
 */
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

export interface AcroFormFixtureOptions {
  /** Width in points (default: 612 — US letter). */
  width?: number;
  /** Height in points (default: 792 — US letter). */
  height?: number;
}

/**
 * Single-page PDF with one writable text field named 'firstName'.
 */
export async function createSingleFieldPdf(
  options: AcroFormFixtureOptions = {},
): Promise<Uint8Array> {
  const { width = 612, height = 792 } = options;
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  const form = doc.getForm();
  const field = form.createTextField('firstName');
  field.setText('');
  field.addToPage(page, { x: 72, y: 650, width: 200, height: 24 });
  return doc.save();
}

/**
 * Single-page PDF with one multiline text field named 'notes'.
 */
export async function createMultilineFieldPdf(
  options: AcroFormFixtureOptions = {},
): Promise<Uint8Array> {
  const { width = 612, height = 792 } = options;
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  const form = doc.getForm();
  const field = form.createTextField('notes');
  field.enableMultiline();
  field.setText('');
  field.addToPage(page, { x: 72, y: 500, width: 400, height: 100 });
  return doc.save();
}

/**
 * Single-page PDF with one read-only text field named 'readOnlyField'
 * pre-populated with a value that must survive flatten intact.
 */
export async function createReadOnlyFieldPdf(
  options: AcroFormFixtureOptions = {},
): Promise<Uint8Array> {
  const { width = 612, height = 792 } = options;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([width, height]);
  const form = doc.getForm();
  const field = form.createTextField('readOnlyField');
  field.setText('Read-only value');
  field.enableReadOnly();
  field.addToPage(page, { x: 72, y: 650, width: 200, height: 24, font });
  return doc.save();
}

/**
 * Two-page PDF where both pages carry a widget for the same field name
 * 'sharedField'. Setting the field value once must appear on both pages
 * after flattening.
 */
export async function createRepeatedFieldNamePdf(
  options: AcroFormFixtureOptions = {},
): Promise<Uint8Array> {
  const { width = 612, height = 792 } = options;
  const doc = await PDFDocument.create();
  const page0 = doc.addPage([width, height]);
  const page1 = doc.addPage([width, height]);
  const form = doc.getForm();
  const field = form.createTextField('sharedField');
  field.setText('');
  field.addToPage(page0, { x: 72, y: 700, width: 200, height: 24 });
  field.addToPage(page1, { x: 72, y: 700, width: 200, height: 24 });
  return doc.save();
}

/**
 * Single-page PDF rotated 90 degrees with a text field named 'rotatedField'.
 * Verifies that rotation metadata survives fill → flatten → copy.
 */
export async function createRotatedPageWithFieldPdf(
  options: AcroFormFixtureOptions = {},
): Promise<Uint8Array> {
  const { width = 612, height = 792 } = options;
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  page.setRotation(degrees(90));
  const form = doc.getForm();
  const field = form.createTextField('rotatedField');
  field.setText('');
  field.addToPage(page, { x: 72, y: 650, width: 200, height: 24 });
  return doc.save();
}

/**
 * Plain PDF with N pages and no form fields — used as a control / comparison
 * fixture to ensure the assembly logic still handles non-form PDFs correctly.
 */
export async function createPlainPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([612, 792]);
  }
  return doc.save();
}

/**
 * Helpers to introspect flattened output.
 * After flatten, the AcroForm dict should have no /Fields left that are
 * interactive text widgets (i.e. getForm().getFields() returns an empty array
 * or all fields are of type non-widget).
 */
export async function countEditableFields(pdfBytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdfBytes);
  try {
    return doc.getForm().getFields().length;
  } catch {
    return 0;
  }
}
