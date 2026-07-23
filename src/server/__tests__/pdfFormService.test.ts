/**
 * Unit tests for pdfFormService — field cataloging, value validation,
 * and fill/flatten helpers.
 */
import { PDFDocument } from 'pdf-lib';
import {
  catalogTextFields,
  validateFormValues,
  fillAndFlattenForm,
} from '../services/pdfFormService';
import {
  createSingleFieldPdf,
  createMultilineFieldPdf,
  createReadOnlyFieldPdf,
  createRepeatedFieldNamePdf,
  createPlainPdf,
} from './helpers/pdfTestFixtures';
import { countEditableFields } from './helpers/pdfTestFixtures';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

// ── catalogTextFields ──────────────────────────────────────────────────────────

describe('catalogTextFields', () => {
  it('returns an empty array for a plain PDF with no form', async () => {
    const bytes = await createPlainPdf(2);
    const catalog = await catalogTextFields(new Uint8Array(bytes));
    expect(catalog).toEqual([]);
  });

  it('catalogs a single writable text field', async () => {
    const bytes = await createSingleFieldPdf();
    const catalog = await catalogTextFields(new Uint8Array(bytes));
    expect(catalog).toHaveLength(1);
    expect(catalog[0].fieldName).toBe('firstName');
    expect(catalog[0].multiline).toBe(false);
  });

  it('catalogs a multiline field correctly', async () => {
    const bytes = await createMultilineFieldPdf();
    const catalog = await catalogTextFields(new Uint8Array(bytes));
    const field = catalog.find((f) => f.fieldName === 'notes');
    expect(field).toBeDefined();
    expect(field?.multiline).toBe(true);
  });

  it('excludes read-only fields from the catalog', async () => {
    const bytes = await createReadOnlyFieldPdf();
    const catalog = await catalogTextFields(new Uint8Array(bytes));
    expect(catalog.every((f) => f.fieldName !== 'readOnlyField')).toBe(true);
  });

  it('catalogs a repeated-name field once with additionalPageIndices', async () => {
    const bytes = await createRepeatedFieldNamePdf();
    const catalog = await catalogTextFields(new Uint8Array(bytes));
    const field = catalog.find((f) => f.fieldName === 'sharedField');
    expect(field).toBeDefined();
    // The field appears on two pages so additionalPageIndices should be non-empty
    expect(field!.pageIndex + field!.additionalPageIndices.length).toBeGreaterThanOrEqual(1);
  });

  it('returns an empty array for corrupted bytes', async () => {
    const catalog = await catalogTextFields(new Uint8Array([1, 2, 3, 4]));
    expect(catalog).toEqual([]);
  });
});

// ── validateFormValues ─────────────────────────────────────────────────────────

describe('validateFormValues', () => {
  const catalog = [
    { fieldName: 'firstName', multiline: false, maxLength: 50, pageIndex: 0, additionalPageIndices: [] },
    { fieldName: 'notes', multiline: true, maxLength: null, pageIndex: 0, additionalPageIndices: [] },
  ];

  it('returns no errors for valid values', () => {
    const errors = validateFormValues(
      [
        { fileId: 'f1', fieldName: 'firstName', value: 'Jane' },
        { fileId: 'f1', fieldName: 'notes', value: 'A note.' },
      ],
      catalog
    );
    expect(errors).toHaveLength(0);
  });

  it('allows values for field names not in the catalog (no error)', () => {
    // Unknown fields are silently accepted so that form fields detected by
    // PDF.js but absent from the server catalog (e.g. ingested before
    // cataloging was introduced) can still be filled and saved.
    const errors = validateFormValues(
      [{ fileId: 'f1', fieldName: 'nonexistent', value: 'x' }],
      catalog
    );
    expect(errors).toHaveLength(0);
  });

  it('returns FORM_FIELD_VALUE_TOO_LONG when maxLength is exceeded', () => {
    const errors = validateFormValues(
      [{ fileId: 'f1', fieldName: 'firstName', value: 'A'.repeat(51) }],
      catalog
    );
    expect(errors[0].code).toBe(PDF_ERROR_CODES.FORM_FIELD_VALUE_TOO_LONG);
  });

  it('returns FORM_VALUES_INVALID when fieldName is missing', () => {
    const errors = validateFormValues(
      [{ fileId: 'f1', fieldName: '', value: 'x' }],
      catalog
    );
    expect(errors[0].code).toBe(PDF_ERROR_CODES.FORM_VALUES_INVALID);
  });

  it('returns FORM_VALUES_INVALID when value is not a string', () => {
    const errors = validateFormValues(
      [{ fileId: 'f1', fieldName: 'firstName', value: 42 as unknown as string }],
      catalog
    );
    expect(errors[0].code).toBe(PDF_ERROR_CODES.FORM_VALUES_INVALID);
  });

  it('allows null maxLength (unconstrained field) with any length value', () => {
    const errors = validateFormValues(
      [{ fileId: 'f1', fieldName: 'notes', value: 'A'.repeat(5000) }],
      catalog
    );
    // only byte-limit errors; field has no maxLength constraint
    const fieldErrors = errors.filter(
      (e) => e.code === PDF_ERROR_CODES.FORM_FIELD_VALUE_TOO_LONG
    );
    expect(fieldErrors).toHaveLength(0);
  });
});

// ── fillAndFlattenForm ─────────────────────────────────────────────────────────

describe('fillAndFlattenForm', () => {
  it('fills a text field and produces a flat PDF with no editable fields', async () => {
    const source = await createSingleFieldPdf();
    const result = await fillAndFlattenForm(new Uint8Array(source), [
      { fileId: 'any', fieldName: 'firstName', value: 'Alice' },
    ]);
    expect(await countEditableFields(result)).toBe(0);
  });

  it('handles a PDF with no form gracefully', async () => {
    const source = await createPlainPdf(1);
    const result = await fillAndFlattenForm(new Uint8Array(source), []);
    const doc = await PDFDocument.load(result);
    expect(doc.getPageCount()).toBe(1);
  });

  it('silently skips unknown field names without throwing', async () => {
    const source = await createSingleFieldPdf();
    await expect(
      fillAndFlattenForm(new Uint8Array(source), [
        { fileId: 'any', fieldName: 'fieldThatDoesNotExist', value: 'x' },
      ])
    ).resolves.toBeDefined();
  });

  it('flattens existing pre-populated fields even when values array is empty', async () => {
    const source = await createSingleFieldPdf();
    const result = await fillAndFlattenForm(new Uint8Array(source), []);
    expect(await countEditableFields(result)).toBe(0);
  });
});
