import { act, render, screen } from '@testing-library/react';
import { PdfConversionStatus } from '../PdfConversionStatus';
import type { PdfConversionJob } from '../../../shared/types/pdf';

function makeJob(overrides: Partial<PdfConversionJob> = {}): PdfConversionJob {
  return {
    id: 'conversion-1',
    sessionId: 'session-1',
    originalName: 'report.docx',
    status: 'queued',
    createdAt: '2026-07-11T05:00:00.000Z',
    ...overrides,
  };
}

describe('PdfConversionStatus', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the number of documents ahead for a queued conversion', () => {
    render(<PdfConversionStatus job={makeJob()} queuePosition={2} />);

    expect(screen.getByText('Waiting to convert…')).toBeInTheDocument();
    expect(screen.getByText(/2 documents ahead/)).toBeInTheDocument();
  });

  it('updates elapsed time while a document is processing', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-11T05:01:05.000Z'));
    const job = makeJob({
      status: 'processing',
      startedAt: '2026-07-11T05:00:00.000Z',
    });

    render(<PdfConversionStatus job={job} queuePosition={0} />);
    expect(screen.getByText(/1m 5s elapsed/)).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(screen.getByText(/1m 6s elapsed/)).toBeInTheDocument();
  });
});
