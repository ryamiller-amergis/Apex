export interface ParseRangeResult {
  pages: number[];
  hasDuplicates: boolean;
  error: string | null;
}

/**
 * Parses a range string (e.g. "1-5, 10, 20-25") into 0-based page indices.
 * Input uses 1-based human-friendly page numbers.
 * Returns de-duplicated, sorted 0-based indices.
 */
export function parseRange(input: string, maxPage: number): ParseRangeResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { pages: [], hasDuplicates: false, error: null };
  }

  const segments = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  const rawIndices: number[] = [];
  let hasDuplicates = false;

  for (const segment of segments) {
    const rangeMatch = segment.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);

      if (isNaN(start) || isNaN(end)) {
        return {
          pages: [],
          hasDuplicates: false,
          error: 'Invalid format. Use page numbers and ranges like 1-3, 7, 10-12.',
        };
      }

      if (start > end) {
        return {
          pages: [],
          hasDuplicates: false,
          error: 'Invalid range: start must be less than or equal to end.',
        };
      }

      if (start < 1 || end > maxPage) {
        return {
          pages: [],
          hasDuplicates: false,
          error: `Page numbers must be between 1 and ${maxPage}.`,
        };
      }

      for (let i = start; i <= end; i++) {
        rawIndices.push(i - 1);
      }
    } else if (/^\d+$/.test(segment)) {
      const num = parseInt(segment, 10);
      if (isNaN(num)) {
        return {
          pages: [],
          hasDuplicates: false,
          error: 'Invalid format. Use page numbers and ranges like 1-3, 7, 10-12.',
        };
      }
      if (num < 1 || num > maxPage) {
        return {
          pages: [],
          hasDuplicates: false,
          error: `Page numbers must be between 1 and ${maxPage}.`,
        };
      }
      rawIndices.push(num - 1);
    } else {
      return {
        pages: [],
        hasDuplicates: false,
        error: 'Invalid format. Use page numbers and ranges like 1-3, 7, 10-12.',
      };
    }
  }

  const uniqueSet = new Set(rawIndices);
  hasDuplicates = uniqueSet.size < rawIndices.length;
  const pages = [...uniqueSet].sort((a, b) => a - b);

  return { pages, hasDuplicates, error: null };
}

/**
 * Converts 0-based page indices into a compact 1-based range string.
 * e.g. [0,1,2,3,4,9,19,20,21,22,23,24] => "1-5, 10, 20-25"
 */
export function selectionToRangeString(indices: number[]): string {
  if (indices.length === 0) return '';

  const sorted = [...indices].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`);

  return ranges.join(', ');
}
