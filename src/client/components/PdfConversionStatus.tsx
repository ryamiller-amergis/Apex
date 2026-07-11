import React, { useEffect, useState } from 'react';
import type { PdfConversionJob } from '../../shared/types/pdf';

export interface PdfConversionStatusProps {
  job: PdfConversionJob;
  queuePosition: number;
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export const PdfConversionStatus: React.FC<PdfConversionStatusProps> = ({
  job,
  queuePosition,
}) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (job.status !== 'processing') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [job.status]);

  if (job.status === 'queued') {
    return (
      <>
        <span>Waiting to convert…</span>
        <span>
          {' '}
          {queuePosition > 0
            ? `· ${queuePosition} ${queuePosition === 1 ? 'document' : 'documents'} ahead`
            : '· starting shortly'}
        </span>
      </>
    );
  }

  const startedAt = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
  const elapsed = Number.isFinite(startedAt) ? formatElapsed(now - startedAt) : null;

  return (
    <>
      <span>Converting Word document…</span>
      {elapsed && <span> · {elapsed} elapsed</span>}
    </>
  );
};
