/**
 * Unit tests for useExportSession hook utility functions.
 * Covers: AC-2 (.pdf extension), BR-008 (default filename format)
 */

import { generateDefaultFilename, ensurePdfExtension } from '../useExportSession';

describe('generateDefaultFilename', () => {
  // BR-008: default filename follows merged-document-YYYYMMDD-HHMM.pdf format
  it('BR-008: generates filename in merged-document-YYYYMMDD-HHMM.pdf format', () => {
    const result = generateDefaultFilename();
    expect(result).toMatch(/^merged-document-\d{8}-\d{4}\.pdf$/);
  });
});

describe('ensurePdfExtension', () => {
  // AC-2: appends .pdf if missing
  it('AC-2: appends .pdf to filename without extension', () => {
    expect(ensurePdfExtension('my-report')).toBe('my-report.pdf');
  });

  it('AC-2: preserves .pdf when already present', () => {
    expect(ensurePdfExtension('my-report.pdf')).toBe('my-report.pdf');
  });

  it('AC-2: case-insensitive .PDF detection', () => {
    expect(ensurePdfExtension('my-report.PDF')).toBe('my-report.PDF');
  });

  it('falls back to default for empty string', () => {
    expect(ensurePdfExtension('')).toMatch(/^merged-document-\d{8}-\d{4}\.pdf$/);
  });

  it('trims whitespace before checking', () => {
    expect(ensurePdfExtension('  my-doc  ')).toBe('my-doc.pdf');
  });
});
