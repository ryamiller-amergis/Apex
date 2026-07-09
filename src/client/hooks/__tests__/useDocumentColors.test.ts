import { renderHook } from '@testing-library/react';
import { useDocumentColors } from '../useDocumentColors';
import type { PdfFileMetadata } from '../../../shared/types/pdf';

function makeFile(fileId: string): PdfFileMetadata {
  return {
    fileId,
    originalName: `${fileId}.pdf`,
    storedName: `${fileId}-stored.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    pageCount: 3,
    uploadedAt: '2026-01-01T00:00:00Z',
  };
}

describe('useDocumentColors', () => {
  it('returns an empty map for an empty array', () => {
    const { result } = renderHook(() => useDocumentColors([]));
    expect(result.current.size).toBe(0);
  });

  it('assigns distinct colors to 2 documents', () => {
    const files = [makeFile('doc-a'), makeFile('doc-b')];
    const { result } = renderHook(() => useDocumentColors(files));

    expect(result.current.size).toBe(2);
    const colorA = result.current.get('doc-a')!;
    const colorB = result.current.get('doc-b')!;

    expect(colorA).toBeDefined();
    expect(colorB).toBeDefined();
    expect(colorA.border).not.toBe(colorB.border);
    expect(colorA.label).not.toBe(colorB.label);
  });

  it('keeps existing colors stable when a 3rd document is added', () => {
    const files2 = [makeFile('doc-a'), makeFile('doc-b')];
    const { result: result2 } = renderHook(() => useDocumentColors(files2));

    const files3 = [makeFile('doc-a'), makeFile('doc-b'), makeFile('doc-c')];
    const { result: result3 } = renderHook(() => useDocumentColors(files3));

    expect(result3.current.get('doc-a')!.border).toBe(
      result2.current.get('doc-a')!.border,
    );
    expect(result3.current.get('doc-b')!.border).toBe(
      result2.current.get('doc-b')!.border,
    );
    expect(result3.current.get('doc-c')).toBeDefined();
  });

  it('cycles colors when more than 8 documents are uploaded', () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFile(`doc-${String(i).padStart(2, '0')}`),
    );
    const { result } = renderHook(() => useDocumentColors(files));

    expect(result.current.size).toBe(10);

    const color0 = result.current.get('doc-00')!;
    const color8 = result.current.get('doc-08')!;
    expect(color0.border).toBe(color8.border);
  });
});
