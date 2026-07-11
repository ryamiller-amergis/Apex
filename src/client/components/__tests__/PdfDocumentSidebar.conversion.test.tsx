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

  test('AC-0: shows a queued Word document without blocking the upload UI', () => {
    render(
      <PdfDocumentSidebar
        {...defaultProps}
        hero
        conversionJobs={[{
          id: 'conversion-1',
          sessionId: 'session-1',
          originalName: 'quarterly-report.docx',
          status: 'queued',
          createdAt: '2026-01-01T00:00:00Z',
        }]}
      />,
    );

    expect(screen.getByText('quarterly-report.docx')).toBeInTheDocument();
    expect(screen.getByText('Waiting to convert…')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-converting-file')).toBeInTheDocument();
  });

  test('shows a smooth processing state after the worker claims the job', () => {
    render(
      <PdfDocumentSidebar
        {...defaultProps}
        conversionJobs={[{
          id: 'conversion-2',
          sessionId: 'session-1',
          originalName: 'large-report.docx',
          status: 'processing',
          createdAt: '2026-01-01T00:00:00Z',
          startedAt: '2026-01-01T00:00:01Z',
        }]}
      />,
    );

    expect(screen.getByText('Converting Word document…')).toBeInTheDocument();
  });

  test('NFR-progress: shows determinate progress while a large file uploads', () => {
    render(
      <PdfDocumentSidebar
        {...defaultProps}
        hero
        isUploading
        uploadProgress={{ phase: 'uploading', percent: 42 }}
      />,
    );

    expect(screen.getByText('Uploading… 42%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', {
      name: 'File upload progress',
    })).toHaveAttribute('aria-valuenow', '42');
  });

  test('NFR-responsiveness: keeps a spinner visible during server-side parsing', () => {
    render(
      <PdfDocumentSidebar
        {...defaultProps}
        hero
        isUploading
        uploadProgress={{ phase: 'processing', percent: 100 }}
      />,
    );

    expect(screen.getByText('Validating and parsing documents…')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-uploading')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
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

  test('AC-1: shows the required conversion failure message exactly once', () => {
    const message =
      'This Word document could not be converted. Try saving it as PDF from Word directly and uploading the PDF.';

    render(
      <PdfDocumentSidebar
        {...defaultProps}
        errors={[
          {
            originalName: 'broken.docx',
            status: 'error',
            error: { code: 'CONVERSION_FAILED', message },
          },
        ]}
      />,
    );

    const renderedError = screen.getByTestId('pdf-upload-errors').textContent ?? '';
    expect(renderedError).toContain(message);
    expect(renderedError.split(message)).toHaveLength(2);
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
