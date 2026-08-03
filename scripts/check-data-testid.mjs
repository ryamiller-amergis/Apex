/**
 * Pre-commit policy: interactive / landmark UI elements in staged (touched)
 * client TSX files must include a data-testid (or anchorTestIdProps).
 *
 * Scope: staged files under src/client matching *.tsx (excludes tests).
 * When a client TSX file is staged, the entire staged blob is scanned —
 * existing interactive elements missing data-testid fail the commit so
 * the author must address them while touching the file.
 *
 * Escape hatch: put `data-testid-exempt` on the same line as the opening
 * tag or the immediately preceding line (comment).
 *
 * Exit 0 when clean; exit 1 with a report when violations are found.
 */
import { execSync } from 'node:child_process';

const CLIENT_TSX_RE = /^src[\\/]client[\\/].+\.tsx$/i;
const TEST_PATH_RE = /(__tests__|[\\/]tests[\\/]|\.test\.tsx$|\.spec\.tsx$)/i;

/** Intrinsic HTML tags that always need a test id. */
const REQUIRED_TAGS = new Set([
  'a',
  'button',
  'dialog',
  'form',
  'input',
  'select',
  'textarea',
]);

/** Tags skipped entirely (decorative / non-interactive structure). */
const SKIP_TAGS = new Set([
  'svg',
  'path',
  'g',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'ellipse',
  'defs',
  'clippath',
  'mask',
  'use',
  'lineargradient',
  'radialgradient',
  'stop',
  'title',
  'desc',
  'symbol',
  'pattern',
  'marker',
  'foreignobject',
  'fragment',
]);

/** PascalCase component name suffixes that imply interactive UI. */
const COMPONENT_SUFFIX_RE =
  /(Button|Modal|Dialog|Drawer|Input|Select|Checkbox|Toggle|Switch|Tab|Menu|MenuItem|Dropdown|Popover|Tooltip|Form|Field|Panel|Card|Banner|Badge|Chip|Fab|Link|NavItem)$/;

const INTERACTIVE_PROP_RE =
  /\b(onClick|onSubmit|onChange|onKeyDown|onKeyUp|onPointerDown|onDoubleClick)\s*=/;

const INTERACTIVE_ROLE_RE =
  /\brole\s*=\s*\{?\s*['"`](button|link|dialog|tab|menuitem|checkbox|switch|textbox|combobox|listbox|option|radio|searchbox|slider|spinbutton|treeitem|navigation|main)['"`]/;

const HAS_TESTID_RE =
  /\bdata-testid\b|\banchorTestIdProps\s*\(|\[\s*['"`]data-testid['"`]\s*\]/;

const EXEMPT_RE = /\bdata-testid-exempt\b/;

function git(command) {
  return execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function toPosix(filePath) {
  return filePath.replace(/\\/g, '/');
}

function listStagedClientTsx() {
  const raw = git('git diff --cached --name-only --diff-filter=ACMR');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => CLIENT_TSX_RE.test(toPosix(file)))
    .filter((file) => !TEST_PATH_RE.test(toPosix(file)));
}

function lineNumberAtIndex(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function precedingLineText(source, index) {
  const before = source.slice(0, index);
  const lastNl = before.lastIndexOf('\n');
  const prevNl = lastNl === -1 ? -1 : before.lastIndexOf('\n', lastNl - 1);
  const start = prevNl + 1;
  const end = lastNl === -1 ? before.length : lastNl;
  return source.slice(start, end);
}

function tagNeedsTestId(tagName, attrs) {
  const lower = tagName.toLowerCase();
  if (SKIP_TAGS.has(lower)) return false;
  if (REQUIRED_TAGS.has(lower)) return true;
  if (INTERACTIVE_PROP_RE.test(attrs) || INTERACTIVE_ROLE_RE.test(attrs)) return true;
  if (tagName[0] === tagName[0].toUpperCase() && COMPONENT_SUFFIX_RE.test(tagName)) {
    return true;
  }
  return false;
}

/**
 * Find JSX/HTML opening tags without treating `>` inside `{...}` or strings
 * as the end of the tag (e.g. `onClick={() => ...}`).
 * @param {string} source
 * @returns {Array<{ index: number, full: string, tagName: string, attrs: string }>}
 */
function findOpenTags(source) {
  const tags = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    // Skip line comments
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    // Skip block comments
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // Skip string literals outside tags
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        // Template literal interpolations
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      continue;
    }

    if (ch !== '<') {
      i += 1;
      continue;
    }

    // Closing tag or comparison / generic — skip non-open tags
    const next = source[i + 1];
    if (!next || next === '/' || next === '!' || next === '?' || /\s/.test(next)) {
      i += 1;
      continue;
    }

    const nameMatch = /^([A-Za-z][\w.]*)/.exec(source.slice(i + 1));
    if (!nameMatch) {
      i += 1;
      continue;
    }

    const tagName = nameMatch[1];
    const nameEnd = i + 1 + tagName.length;
    let j = nameEnd;
    let braceDepth = 0;
    let quote = null;

    while (j < source.length) {
      const c = source[j];
      if (quote) {
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) quote = null;
        j += 1;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        j += 1;
        continue;
      }
      if (c === '{') {
        braceDepth += 1;
        j += 1;
        continue;
      }
      if (c === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        j += 1;
        continue;
      }
      if (c === '>' && braceDepth === 0) {
        const selfClosing = source[j - 1] === '/';
        const full = source.slice(i, j + 1);
        const attrs = source.slice(nameEnd, selfClosing ? j - 1 : j);
        tags.push({ index: i, full, tagName, attrs });
        j += 1;
        break;
      }
      j += 1;
    }
    i = j;
  }
  return tags;
}

/**
 * Scan an entire source file for interactive UI missing data-testid.
 * @param {string} source
 * @param {string} filePath
 */
function findViolations(source, filePath) {
  const violations = [];
  for (const tag of findOpenTags(source)) {
    if (!tagNeedsTestId(tag.tagName, tag.attrs)) continue;

    if (HAS_TESTID_RE.test(tag.full)) continue;
    if (EXEMPT_RE.test(tag.full) || EXEMPT_RE.test(precedingLineText(source, tag.index))) {
      continue;
    }

    const startLine = lineNumberAtIndex(source, tag.index);
    violations.push({
      filePath,
      line: startLine,
      tag: tag.tagName,
      snippet: tag.full.replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }
  return violations;
}

function readStagedFile(filePath) {
  // `git show :path` reads the staged blob; paths under src/client have no spaces.
  return git(`git show :${toPosix(filePath)}`);
}

function main() {
  const files = listStagedClientTsx();
  if (files.length === 0) {
    process.exit(0);
  }

  /** @type {Array<{ filePath: string, line: number, tag: string, snippet: string }>} */
  const violations = [];

  for (const filePath of files) {
    const source = readStagedFile(filePath);
    violations.push(...findViolations(source, filePath));
  }

  if (violations.length === 0) {
    process.exit(0);
  }

  console.error(
    'data-testid policy failed — interactive UI in touched client files must include data-testid:\n',
  );
  for (const v of violations) {
    console.error(`  ${toPosix(v.filePath)}:${v.line}  <${v.tag}>  ${v.snippet}`);
  }
  console.error(`
Add a stable data-testid (kebab-case), e.g. data-testid="save-preferences-btn",
or spread anchorTestIdProps('registry-key') for walkthrough anchors.

When a client TSX file is staged, EVERY interactive element in that file is
checked (not only newly added lines). Fix or exempt before committing.

Escape hatch (rare): put // data-testid-exempt on the line above the tag.

To resolve automatically in Cursor, run /resolve-pre-commit-data-testid
`);
  process.exit(1);
}

// Lightweight self-check when run with --self-test
if (process.argv.includes('--self-test')) {
  const sample = `
export const Demo = () => (
  <div>
    <button type="button" className="x">Save</button>
    <button type="button" data-testid="save-btn">Ok</button>
    {/* data-testid-exempt */}
    <button type="button">Decorative</button>
    <input onChange={() => {}} />
    <button
      ref={(el) => { void el; }}
      onClick={() => {}}
      data-testid="arrow-safe"
    >
      Arrow
    </button>
    <Modal open />
    <Icon size={16} />
  </div>
);
`;
  const found = findViolations(sample, 'src/client/components/Demo.tsx');
  const tags = found.map((v) => v.tag).sort();
  const expected = ['Modal', 'button', 'input'].sort();
  if (JSON.stringify(tags) !== JSON.stringify(expected)) {
    console.error('self-test failed:', tags, 'expected', expected);
    process.exit(1);
  }
  console.log('self-test passed');
  process.exit(0);
}

main();
