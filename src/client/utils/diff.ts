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
