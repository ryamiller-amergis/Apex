/**
 * Unit tests for PdfDocumentSidebar — Word-to-PDF conversion UI features.
 * Covers: AC-0 (accept .docx), AC-2 (badge), AC-3 (first-class behavior) (PBI-012)
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PdfDocumentSidebar } from '../PdfDocumentSidebar';
import type { PdfFileMetadata } from '../../../shared/types/pdf';

const defaultProps = {
  fileMetadata: [] as PdfFileMetadata[],
  selectedFileId: null,
  onSelectFile: jest.fn(),
  onRemoveFile: jest.fn(),
  dragActive: false,
  onDrop: jest.fn(),
  onDragOver: jest.fn(),
  onDragLeave: jest.fn(),
  onDropzoneClick: jest.fn(),
  inputRef: React.createRef<HTMLInputElement>(),
  onInputChange: jest.fn(),
  isUploading: false,
  createSessionPending: false,
  errors: [],
  sessionLimitError: false,
};

describe('PdfDocumentSidebar — Word conversion UI', () => {
  test('AC-0: hero dropzone file input accepts .docx and .pdf files', () => {
    render(<PdfDocumentSidebar {...defaultProps} hero />);
    const input = screen.getByTestId('pdf-file-input');
    expect(input).toHaveAttribute(
      'accept',
      expect.stringContaining('.docx'),
    );
    expect(input).toHaveAttribute(
      'accept',
      expect.stringContaining('.pdf'),
    );
  });

  test('AC-0: compact dropzone file input accepts .docx and .pdf files', () => {
    render(
      <PdfDocumentSidebar
        {...defaultProps}
        fileMetadata={[
          {
            fileId: 'f1',
            originalName: 'test.pdf',
            storedName: 'f1.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            pageCount: 1,
            uploadedAt: '2026-01-01T00:00:00Z',
          },
        ]}
      />,
    );
    const input = screen.getByTestId('pdf-file-input');
    expect(input).toHaveAttribute(
      'accept',
      expect.stringContaining('.docx'),
    );
  });

  test('AC-0: hero help text mentions Word (.docx)', () => {
    render(<PdfDocumentSidebar {...defaultProps} hero />);
    const hint = screen.getByText(/Word/i);
    expect(hint).toBeInTheDocument();
  });

  test('AC-2: shows "Converted from Word" badge when convertedFrom is present', () => {
    const convertedFile: PdfFileMetadata = {
      fileId: 'conv-1',
      originalName: 'report.docx',
      storedName: 'conv-1.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      pageCount: 5,
      convertedFrom: 'report.docx',
      uploadedAt: '2026-01-01T00:00:00Z',
    };

    render(
      <PdfDocumentSidebar {...defaultProps} fileMetadata={[convertedFile]} />,
    );

    const badge = screen.getByTestId('pdf-converted-badge-conv-1');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/Converted from Word/i);
  });

  test('AC-2: does NOT show badge for directly uploaded PDFs', () => {
    const nativeFile: PdfFileMetadata = {
      fileId: 'nat-1',
      originalName: 'native.pdf',
      storedName: 'nat-1.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      pageCount: 3,
      uploadedAt: '2026-01-01T00:00:00Z',
    };

    render(
      <PdfDocumentSidebar {...defaultProps} fileMetadata={[nativeFile]} />,
    );

    expect(screen.queryByTestId('pdf-converted-badge-nat-1')).not.toBeInTheDocument();
  });

  test('AC-3: converted file appears in file list with page count and size', () => {
    const convertedFile: PdfFileMetadata = {
      fileId: 'conv-2',
      originalName: 'notes.docx',
      storedName: 'conv-2.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5120,
      pageCount: 10,
      convertedFrom: 'notes.docx',
      uploadedAt: '2026-01-01T00:00:00Z',
    };

    render(
      <PdfDocumentSidebar {...defaultProps} fileMetadata={[convertedFile]} />,
    );

    expect(screen.getByText('notes.docx')).toBeInTheDocument();
    expect(screen.getByText(/10 pages/)).toBeInTheDocument();
  });
});
