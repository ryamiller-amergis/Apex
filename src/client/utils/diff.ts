// ── Shared diff utilities ─────────────────────────────────────────────────────

export interface WordSpan {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
}

export interface DiffLine {
  type: 'added' | 'removed' | 'context';
  lineNum: number | null;
  text: string;
  /** Word-level spans — present when this line is part of a modified pair. */
  spans?: WordSpan[];
}

/** Normalize a line for comparison purposes: trim and collapse runs of whitespace. */
export function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

export function computeWordLevelDiff(oldText: string, newText: string): WordSpan[] {
  const tokenize = (t: string): string[] => t.match(/\S+|\s+/g) ?? [];
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  const m = oldTokens.length;
  const n = newTokens.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldTokens[i - 1] === newTokens[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const spans: WordSpan[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      spans.unshift({ type: 'unchanged', text: oldTokens[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      spans.unshift({ type: 'added', text: newTokens[j - 1] });
      j--;
    } else {
      spans.unshift({ type: 'removed', text: oldTokens[i - 1] });
      i--;
    }
  }
  // Don't highlight whitespace-only differences — they're noise
  return spans.map((s) =>
    /^\s+$/.test(s.text) ? { ...s, type: 'unchanged' as const } : s,
  );
}

/**
 * GitHub-style annotation: for each adjacent (removed, added) pair, compute
 * a word-level diff and attach filtered spans to BOTH lines.
 *
 * - Removed row spans: 'unchanged' + 'removed' tokens  → dark-red chips on red row
 * - Added row spans:   'unchanged' + 'added'   tokens  → dark-green chips on green row
 *
 * Both rows are kept; only the chip highlights differ.
 */
export function annotateAdjacentPairs(lines: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'removed') {
      result.push(lines[i]);
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'removed') {
      removed.push(lines[i++]);
    }
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'added') {
      added.push(lines[i++]);
    }
    const pairs = Math.min(removed.length, added.length);
    for (let p = 0; p < pairs; p++) {
      const wordDiff = computeWordLevelDiff(removed[p].text, added[p].text);
      result.push({
        ...removed[p],
        spans: wordDiff.filter((s) => s.type !== 'added'),
      });
      result.push({
        ...added[p],
        spans: wordDiff.filter((s) => s.type !== 'removed'),
      });
    }
    for (let p = pairs; p < removed.length; p++) result.push(removed[p]);
    for (let p = pairs; p < added.length; p++) result.push(added[p]);
  }
  return result;
}

export function computeUnifiedDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = normalizeLine(oldLines[i - 1]) === normalizeLine(newLines[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const stack: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && normalizeLine(oldLines[i - 1]) === normalizeLine(newLines[j - 1])) {
      stack.push({ type: 'context', lineNum: j, text: newLines[j - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'added', lineNum: j, text: newLines[j - 1] });
      j--;
    } else {
      stack.push({ type: 'removed', lineNum: i, text: oldLines[i - 1] });
      i--;
    }
  }

  stack.reverse();

  const hasChanges = stack.some((l) => l.type !== 'context');
  if (!hasChanges) return [];

  const changeIndices = new Set<number>();
  for (let idx = 0; idx < stack.length; idx++) {
    if (stack[idx].type !== 'context') changeIndices.add(idx);
  }

  const result: DiffLine[] = [];
  let lastIncluded = -10;
  for (let idx = 0; idx < stack.length; idx++) {
    const nearChange = [...changeIndices].some((ci) => Math.abs(ci - idx) <= 3);
    if (stack[idx].type !== 'context' || nearChange) {
      if (idx - lastIncluded > 1 && lastIncluded >= 0) {
        result.push({ type: 'context', lineNum: null, text: '···' });
      }
      result.push(stack[idx]);
      lastIncluded = idx;
    }
  }

  return annotateAdjacentPairs(result);
}

/** Contiguous change region within a line-based diff (0-based line indices). */
export interface DiffHunk {
  id: string;
  /** 0-based start index into the old document's lines. */
  oldStart: number;
  /** Number of old lines covered by this hunk (0 for pure insertion). */
  oldCount: number;
  /** 0-based start index into the new document's lines. */
  newStart: number;
  /** Number of new lines covered by this hunk (0 for pure deletion). */
  newCount: number;
  oldText: string;
  newText: string;
}

interface AlignOp {
  type: 'equal' | 'insert' | 'delete';
  oldIndex: number | null;
  newIndex: number | null;
  oldLine?: string;
  newLine?: string;
}

/** Full LCS alignment of old/new lines (no context collapsing). */
function computeLineAlignment(oldText: string, newText: string): AlignOp[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        normalizeLine(oldLines[i - 1]) === normalizeLine(newLines[j - 1])
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const stack: AlignOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && normalizeLine(oldLines[i - 1]) === normalizeLine(newLines[j - 1])) {
      stack.push({
        type: 'equal',
        oldIndex: i - 1,
        newIndex: j - 1,
        oldLine: oldLines[i - 1],
        newLine: newLines[j - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({
        type: 'insert',
        oldIndex: null,
        newIndex: j - 1,
        newLine: newLines[j - 1],
      });
      j--;
    } else {
      stack.push({
        type: 'delete',
        oldIndex: i - 1,
        newIndex: null,
        oldLine: oldLines[i - 1],
      });
      i--;
    }
  }
  stack.reverse();
  return stack;
}

function hashHunkId(parts: string[]): string {
  // FNV-1a 32-bit — stable, short, no crypto dependency
  let h = 0x811c9dc5;
  const s = parts.join('\0');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `hunk-${(h >>> 0).toString(16)}`;
}

/**
 * Split a document-level change into contiguous non-overlapping hunks.
 * Each hunk covers a maximal run of insert/delete ops (with no equal lines between).
 */
export function computeDiffHunks(oldText: string, newText: string): DiffHunk[] {
  if (oldText === newText) return [];

  const alignment = computeLineAlignment(oldText, newText);
  const hunks: DiffHunk[] = [];

  let i = 0;
  while (i < alignment.length) {
    if (alignment[i].type === 'equal') {
      i++;
      continue;
    }

    const start = i;
    while (i < alignment.length && alignment[i].type !== 'equal') {
      i++;
    }
    const ops = alignment.slice(start, i);

    const oldLines: string[] = [];
    const newLines: string[] = [];
    let oldStart = -1;
    let newStart = -1;

    for (const op of ops) {
      if (op.type === 'delete' && op.oldIndex != null) {
        if (oldStart < 0) oldStart = op.oldIndex;
        oldLines.push(op.oldLine ?? '');
      } else if (op.type === 'insert' && op.newIndex != null) {
        if (newStart < 0) newStart = op.newIndex;
        newLines.push(op.newLine ?? '');
      }
    }

    // Pure insertion: oldStart stays at the next equal's old index (or end).
    // Approximate by using the first delete/insert context — for insert-only,
    // place at the old index of the preceding equal + 1, or 0.
    if (oldStart < 0) {
      // Look backward for last equal's oldIndex
      let prev = start - 1;
      while (prev >= 0 && alignment[prev].type !== 'equal') prev--;
      oldStart = prev >= 0 && alignment[prev].oldIndex != null
        ? (alignment[prev].oldIndex as number) + 1
        : 0;
    }
    if (newStart < 0) {
      let prev = start - 1;
      while (prev >= 0 && alignment[prev].type !== 'equal') prev--;
      newStart = prev >= 0 && alignment[prev].newIndex != null
        ? (alignment[prev].newIndex as number) + 1
        : 0;
    }

    const oldTextHunk = oldLines.join('\n');
    const newTextHunk = newLines.join('\n');
    hunks.push({
      id: hashHunkId([String(oldStart), String(oldLines.length), oldTextHunk, newTextHunk]),
      oldStart,
      oldCount: oldLines.length,
      newStart,
      newCount: newLines.length,
      oldText: oldTextHunk,
      newText: newTextHunk,
    });
  }

  return hunks;
}

/**
 * Rebuild a document by applying approved hunks onto `oldText`.
 * Rejected (or unknown) hunks keep the original old lines.
 */
export function mergeSelectedHunks(
  oldText: string,
  hunks: DiffHunk[],
  approvedIds: ReadonlySet<string>,
): string {
  if (hunks.length === 0) return oldText;

  const oldLines = oldText.split('\n');
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  const result: string[] = [];
  let cursor = 0;

  for (const hunk of sorted) {
    const start = Math.max(0, Math.min(hunk.oldStart, oldLines.length));
    const end = Math.max(start, Math.min(start + hunk.oldCount, oldLines.length));
    result.push(...oldLines.slice(cursor, start));

    if (approvedIds.has(hunk.id)) {
      if (hunk.newCount > 0) {
        result.push(...hunk.newText.split('\n'));
      }
    } else {
      result.push(...oldLines.slice(start, end));
    }
    cursor = end;
  }

  result.push(...oldLines.slice(cursor));
  return result.join('\n');
}
