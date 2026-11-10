import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAllowedFastEditPath } from './buildRevisionFastEditArtifactStore';

export type DeterministicCopyEditResult =
  | { kind: 'edited'; changedPath: string }
  | { kind: 'not_applicable' };

const SOURCE_ROOTS = ['apps/web/src', 'packages/ui/src'] as const;
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const EXCLUDED_SOURCE_PATH =
  /(^|\/)(__tests__|__mocks__|test|tests|testing|stories)(\/|$)|\.(?:test|spec|stories)\.[^.]+$/i;
const SAFE_COPY = /^[\p{L}\p{N}][\p{L}\p{N}\p{P}\p{Zs}]{0,79}$/u;

function cleanCopy(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^["'“”‘’`]|["'“”‘’`]$/g, '')
    .trim();
  return SAFE_COPY.test(cleaned) ? cleaned : null;
}

function parseCopyChange(feedback: string): {
  from: string;
  to: string;
} | null {
  const trimmed = feedback.trim();
  const quoted = trimmed.match(
    /\b(?:change|replace)\s+["“']([^"”']{1,80})["”']\s+(?:to|with)\s+["“']([^"”']{1,80})["”']/i
  );
  if (quoted) {
    const from = cleanCopy(quoted[1]);
    const to = cleanCopy(quoted[2]);
    return from && to && from !== to ? { from, to } : null;
  }

  const fromTo = trimmed.match(
    /\bfrom\s+(.{1,80}?)\s+to\s+(.{1,80}?)(?:[.!?]|$)/i
  );
  if (fromTo) {
    const from = cleanCopy(fromTo[1]);
    const to = cleanCopy(fromTo[2]);
    return from && to && from !== to ? { from, to } : null;
  }

  const labelled = trimmed.match(
    /^\s*(?:please\s+)?(?:change|replace)\s+(?:the\s+)?(.{1,80}?)\s+(?:text|label|copy|heading|title)\s+(?:to|with)\s+(.{1,80}?)(?:[.!?]|$)/i
  );
  if (!labelled) return null;
  const from = cleanCopy(labelled[1].replace(/\s+button$/i, ''));
  const to = cleanCopy(labelled[2]);
  return from && to && from !== to ? { from, to } : null;
}

async function listFiles(
  workspacePath: string,
  relativeDirectory: string
): Promise<string[]> {
  const absoluteDirectory = path.join(
    workspacePath,
    ...relativeDirectory.split('/')
  );
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(workspacePath, relativePath)));
      continue;
    }
    if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
      !EXCLUDED_SOURCE_PATH.test(relativePath) &&
      isAllowedFastEditPath(relativePath)
    ) {
      files.push(relativePath);
    }
  }
  return files;
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacementFor(
  content: string,
  from: string,
  to: string
): { content: string; count: number } {
  const escaped = escapedPattern(from);
  let count = 0;
  let next = content.replace(
    new RegExp(`(>\\s*)${escaped}(\\s*<)`, 'g'),
    (_match, before: string, after: string) => {
      count += 1;
      return `${before}${to}${after}`;
    }
  );
  next = next.replace(
    new RegExp(`(["'\`])${escaped}\\1`, 'g'),
    (match, quote: string) => {
      if (to.includes(quote)) return match;
      count += 1;
      return `${quote}${to}${quote}`;
    }
  );
  return { content: next, count };
}

function appShellNameReplacement(
  content: string,
  to: string
): { content: string; count: number } {
  let count = 0;
  let replacedWebEnv = false;
  let next = content.replace(
    /\bappName\s*=\s*\{([^{}\r\n]+)\}/g,
    (match, expression: string, offset: number) => {
      const linePrefix = content.slice(
        content.lastIndexOf('\n', offset) + 1,
        offset
      );
      if (/^\s*(?:\*|\/\/)/.test(linePrefix)) return match;
      count += 1;
      replacedWebEnv ||= /\bwebEnv\./.test(expression);
      return `appName={${JSON.stringify(to)}}`;
    }
  );
  if (count === 1 && replacedWebEnv && !/\bwebEnv\./.test(next)) {
    next = next.replace(
      /^import\s+\{\s*webEnv\s*\}\s+from\s+['"][^'"]+['"];\r?\n/m,
      ''
    );
  }
  return { content: next, count };
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const staging = `${target}.apex-fast-edit`;
  await writeFile(staging, content);
  await rename(staging, target);
}

export async function tryApplyDeterministicCopyEdit(input: {
  workspacePath: string;
  feedback: string;
}): Promise<DeterministicCopyEditResult> {
  const change = parseCopyChange(input.feedback);
  if (!change) return { kind: 'not_applicable' };

  const candidates = (
    await Promise.all(
      SOURCE_ROOTS.map((root) => listFiles(input.workspacePath, root))
    )
  ).flat();
  const matches: Array<{ relativePath: string; content: string }> = [];
  let occurrenceCount = 0;
  for (const relativePath of candidates) {
    const absolutePath = path.join(
      input.workspacePath,
      ...relativePath.split('/')
    );
    const original = await readFile(absolutePath, 'utf8');
    const replacement = replacementFor(original, change.from, change.to);
    if (replacement.count === 0) continue;
    occurrenceCount += replacement.count;
    matches.push({ relativePath, content: replacement.content });
  }
  if (occurrenceCount === 1 && matches.length === 1) {
    const match = matches[0];
    const target = path.join(
      input.workspacePath,
      ...match.relativePath.split('/')
    );
    await writeAtomic(target, match.content);
    return { kind: 'edited', changedPath: match.relativePath };
  }

  if (!/\b(?:application|app)\s+name\b/i.test(input.feedback)) {
    return { kind: 'not_applicable' };
  }
  const appNameMatches: Array<{ relativePath: string; content: string }> = [];
  let appNameOccurrenceCount = 0;
  for (const relativePath of candidates) {
    const absolutePath = path.join(
      input.workspacePath,
      ...relativePath.split('/')
    );
    const original = await readFile(absolutePath, 'utf8');
    if (!/\bAppShell\b/.test(original)) continue;
    const replacement = appShellNameReplacement(original, change.to);
    if (replacement.count === 0) continue;
    appNameOccurrenceCount += replacement.count;
    appNameMatches.push({
      relativePath,
      content: replacement.content,
    });
  }
  if (appNameOccurrenceCount !== 1 || appNameMatches.length !== 1) {
    return { kind: 'not_applicable' };
  }
  const appNameMatch = appNameMatches[0];
  await writeAtomic(
    path.join(input.workspacePath, ...appNameMatch.relativePath.split('/')),
    appNameMatch.content
  );
  return { kind: 'edited', changedPath: appNameMatch.relativePath };
}
