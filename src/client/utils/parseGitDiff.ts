export interface GitDiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk-header';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface GitDiffFile {
  path: string;
  hunks: GitDiffLine[];
}

/** Splits `git diff` output into per-file line lists with old/new line numbers. */
export function parseGitDiff(raw: string): GitDiffFile[] {
  const files: GitDiffFile[] = [];
  const lines = raw.split('\n');
  let current: GitDiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      current = { path: match?.[1] ?? line, hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('new file') || line.startsWith('deleted file')) {
      continue;
    }
    if (line.startsWith('@@')) {
      const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      oldLine = hunkMatch ? parseInt(hunkMatch[1], 10) : 0;
      newLine = hunkMatch ? parseInt(hunkMatch[2], 10) : 0;
      current.hunks.push({ type: 'hunk-header', content: line });
      continue;
    }
    if (line.startsWith('+')) {
      current.hunks.push({ type: 'add', content: line.slice(1), newLineNo: newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      current.hunks.push({ type: 'remove', content: line.slice(1), oldLineNo: oldLine });
      oldLine++;
    } else {
      current.hunks.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line, oldLineNo: oldLine, newLineNo: newLine });
      oldLine++;
      newLine++;
    }
  }
  return files;
}
