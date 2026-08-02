/**
 * Prevents theme-token fills from using fixed light foregrounds.
 *
 * Bright themes such as Ice intentionally use a near-white accent. Text and
 * icons rendered on accent/success fills must therefore use the matching
 * semantic foreground token instead of #fff, white, or --bg-primary.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const sourceRoot = join(process.cwd(), 'src', 'client');
const rulePattern = /([^{}]+)\{([^{}]*)\}/gs;
const backgroundPattern = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;}]+)/gim;
const foregroundPattern = /(?:^|;)\s*(color|fill|stroke)\s*:\s*([^;}]+)/gim;
const fixedLightForegroundPattern =
  /^(?:#fff(?:fff)?|white|var\(--bg-primary\))(?:\s*!important)?$/i;

function listCssFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? listCssFiles(path)
        : entry.isFile() && entry.name.endsWith('.css')
          ? [path]
          : [];
    })
    .sort();
}

function matchingForegroundTokens(ruleBody) {
  const tokens = new Set();

  for (const match of ruleBody.matchAll(backgroundPattern)) {
    const value = match[1];
    if (
      value.includes('var(--accent-color)') ||
      value.includes('var(--accent-hover)')
    ) {
      tokens.add('var(--on-accent)');
    }
    if (
      value.includes('var(--success-color)') ||
      value.includes('var(--success-hover)')
    ) {
      tokens.add('var(--on-success)');
    }
  }

  return [...tokens];
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

const violations = [];
const files = listCssFiles(sourceRoot);

for (const file of files) {
  const source = readFileSync(file, 'utf8');

  for (const rule of source.matchAll(rulePattern)) {
    const selector = rule[1].replace(/\s+/g, ' ').trim();
    const body = rule[2];
    const expectedTokens = matchingForegroundTokens(body);
    if (expectedTokens.length === 0) continue;

    const bodyOffset = rule.index + rule[0].indexOf('{') + 1;
    for (const foreground of body.matchAll(foregroundPattern)) {
      const value = foreground[2].trim();
      if (!fixedLightForegroundPattern.test(value)) continue;

      violations.push({
        file: relative(process.cwd(), file).replaceAll('\\', '/'),
        line: lineNumberAt(source, bodyOffset + foreground.index),
        selector,
        property: foreground[1].toLowerCase(),
        value,
        expectedTokens,
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    'Theme contrast check failed: tokenized fills cannot use fixed light foregrounds.'
  );
  for (const violation of violations) {
    const expected = violation.expectedTokens.join(' or ');
    console.error(
      `${violation.file}:${violation.line} ${violation.selector}\n` +
        `  ${violation.property}: ${violation.value}; use ${expected}`
    );
  }
  process.exit(1);
}

console.log(`Theme contrast check passed (${files.length} CSS files checked).`);
