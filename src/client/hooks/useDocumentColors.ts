import { useMemo } from 'react';
import type { PdfFileMetadata } from '../../shared/types/pdf';

export interface DocumentColor {
  /** Semi-transparent background, e.g. "rgba(59,130,246,0.08)" */
  bg: string;
  /** Solid border/stripe color, e.g. "rgba(59,130,246,0.6)" */
  border: string;
  /** Text-safe label color, e.g. "rgba(59,130,246,0.9)" */
  text: string;
  /** Human-readable label, e.g. "Blue" — for ARIA */
  label: string;
}

const PALETTE: { rgb: string; label: string }[] = [
  { rgb: '59,130,246', label: 'Blue' },
  { rgb: '16,185,129', label: 'Emerald' },
  { rgb: '245,158,11', label: 'Amber' },
  { rgb: '244,63,94', label: 'Rose' },
  { rgb: '139,92,246', label: 'Violet' },
  { rgb: '6,182,212', label: 'Cyan' },
  { rgb: '249,115,22', label: 'Orange' },
  { rgb: '217,70,239', label: 'Fuchsia' },
];

function buildColor(index: number): DocumentColor {
  const { rgb, label } = PALETTE[index % PALETTE.length];
  return {
    bg: `rgba(${rgb},0.18)`,
    border: `rgba(${rgb},0.85)`,
    text: `rgba(${rgb},1)`,
    label,
  };
}

export function useDocumentColors(
  fileMetadata: PdfFileMetadata[],
): Map<string, DocumentColor> {
  return useMemo(() => {
    const sortedIds = fileMetadata.map((f) => f.fileId).sort();
    const map = new Map<string, DocumentColor>();
    for (let i = 0; i < sortedIds.length; i++) {
      map.set(sortedIds[i], buildColor(i));
    }
    return map;
  }, [fileMetadata]);
}
