#!/usr/bin/env node
// Checks the documentation set: internal links, required sections, stale
// paths, index coverage, entry-point reachability, the module map, and origin
// terms. It reads local files only. It never fetches a URL, spawns a process,
// or prints document text beyond the offending link, path, heading, or term.
//
// Exit 0: no findings. Exit 1: findings. Exit 2: unusable config or invocation.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_CONFIG = 'docs/docs-check.config.json';
const EXEMPT_MARKER = '<!-- docs-check-exempt -->';
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

export class DocsCheckUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocsCheckUsageError';
  }
}

const toPosix = (value) => value.split(path.sep).join('/');

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        source += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(relative, glob) {
  return globToRegExp(glob).test(relative);
}

function createFileSystem(root) {
  const listings = new Map();
  function list(relativeDir) {
    if (!listings.has(relativeDir)) {
      let entries = null;
      try {
        entries = readdirSync(path.join(root, relativeDir), {
          withFileTypes: true,
        });
      } catch {
        entries = null;
      }
      listings.set(
        relativeDir,
        entries === null
          ? null
          : new Map(entries.map((entry) => [entry.name, entry]))
      );
    }
    return listings.get(relativeDir);
  }

  // Compares each segment with the directory listing, so a case mismatch fails
  // on case-insensitive file systems too.
  function exists(relative, { directory = false } = {}) {
    const segments = relative.split('/').filter((part) => part !== '');
    if (segments.length === 0) {
      return true;
    }
    let current = '';
    for (const [index, segment] of segments.entries()) {
      const entries = list(current);
      const entry = entries?.get(segment);
      if (!entry) {
        return false;
      }
      current = current === '' ? segment : `${current}/${segment}`;
      const last = index === segments.length - 1;
      if (last && directory) {
        return entry.isDirectory() || isDirectoryLink(current);
      }
    }
    return true;
  }

  function isDirectoryLink(relative) {
    try {
      return statSync(path.join(root, relative)).isDirectory();
    } catch {
      return false;
    }
  }

  function walk(relativeDir, found) {
    const entries = list(relativeDir);
    if (!entries) {
      return;
    }
    for (const [name, entry] of entries) {
      if (SKIPPED_DIRS.has(name)) {
        continue;
      }
      const relative = relativeDir === '' ? name : `${relativeDir}/${name}`;
      if (
        entry.isDirectory() ||
        (entry.isSymbolicLink() && isDirectoryLink(relative))
      ) {
        walk(relative, found);
      } else {
        found.push(relative);
      }
    }
  }

  function filesMatching(globs) {
    const found = new Set();
    for (const glob of globs) {
      const segments = glob.split('/');
      const stop = segments.findIndex((part) => /[*?]/.test(part));
      if (stop === -1) {
        if (exists(glob) && !exists(glob, { directory: true })) {
          found.add(glob);
        }
        continue;
      }
      const base = segments.slice(0, stop).join('/');
      if (base !== '' && !exists(base, { directory: true })) {
        continue;
      }
      const files = [];
      walk(base, files);
      for (const file of files) {
        if (matchesGlob(file, glob)) {
          found.add(file);
        }
      }
    }
    return [...found].sort();
  }

  function read(relative) {
    return readFileSync(path.join(root, relative), 'utf8').replace(
      /\r\n?/g,
      '\n'
    );
  }

  return { exists, filesMatching, read, list };
}

// --- Config -----------------------------------------------------------------

function isStringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

export function validateConfig(config, label = DEFAULT_CONFIG) {
  const fail = (message) => {
    throw new DocsCheckUsageError(`docs:check: ${label} ${message}`);
  };
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    fail('must be a JSON object');
  }
  for (const key of ['entryPoint', 'index']) {
    if (typeof config[key] !== 'string' || config[key].trim() === '') {
      fail(`is missing "${key}" (a file path)`);
    }
  }
  if (!isStringArray(config.documents) || config.documents.length === 0) {
    fail('is missing "documents" (a non-empty list of globs)');
  }
  for (const key of ['requiredDocuments', 'ignorePaths', 'forbiddenTerms']) {
    if (config[key] !== undefined && !isStringArray(config[key])) {
      fail(`has an invalid "${key}" (expected a list of strings)`);
    }
  }
  if (config.requiredSections !== undefined) {
    const valid =
      Array.isArray(config.requiredSections) &&
      config.requiredSections.every(
        (rule) =>
          rule && typeof rule.match === 'string' && isStringArray(rule.headings)
      );
    if (!valid) {
      fail(
        'has an invalid "requiredSections" (expected { match, headings } entries)'
      );
    }
  }
  if (config.moduleMap !== undefined) {
    const map = config.moduleMap;
    const valid =
      map &&
      typeof map.file === 'string' &&
      typeof map.workspaceFile === 'string' &&
      isStringArray(map.fields);
    if (!valid) {
      fail(
        'has an invalid "moduleMap" (expected { file, workspaceFile, fields })'
      );
    }
  }
  if (
    config.originHeading !== undefined &&
    typeof config.originHeading !== 'string'
  ) {
    fail('has an invalid "originHeading" (expected a string)');
  }
  return config;
}

// --- Markdown scanning ------------------------------------------------------

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
const INLINE_LINK =
  /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;

function scanMarkdown(text) {
  const lines = text.split('\n');
  const headings = [];
  const links = [];
  const spans = [];
  let fence = null;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length &&
        line.trim() === fenceMatch[1]
      ) {
        fence = null;
      }
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      headings.push({
        level: heading[1].length,
        text: heading[2].trim(),
        line: lineNumber,
      });
    }
    const exempt =
      line.includes(EXEMPT_MARKER) ||
      (index > 0 && lines[index - 1].includes(EXEMPT_MARKER));
    let withoutCode = line;
    for (const match of line.matchAll(CODE_SPAN)) {
      spans.push({ text: match[2].trim(), line: lineNumber, exempt });
      withoutCode =
        withoutCode.slice(0, match.index) +
        ' '.repeat(match[0].length) +
        withoutCode.slice(match.index + match[0].length);
    }
    const definition = REFERENCE_DEFINITION.exec(withoutCode);
    if (definition) {
      links.push({ target: unwrap(definition[1]), line: lineNumber });
      return;
    }
    for (const match of withoutCode.matchAll(INLINE_LINK)) {
      links.push({ target: unwrap(match[1]), line: lineNumber });
    }
  });
  return { lines, headings, links, spans };
}

function unwrap(target) {
  return target.startsWith('<') && target.endsWith('>')
    ? target.slice(1, -1)
    : target;
}

// --- Path helpers -----------------------------------------------------------

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

function decode(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

// Returns the root-relative POSIX path, or null when it leaves the root.
function resolveFrom(documentPath, target) {
  const base = target.startsWith('/') ? '' : path.posix.dirname(documentPath);
  const joined = path.posix.normalize(
    path.posix.join(base === '.' ? '' : base, target.replace(/^\/+/, ''))
  );
  if (joined === '..' || joined.startsWith('../')) {
    return null;
  }
  return joined === '.' ? '' : joined.replace(/\/$/, '');
}

function stalePathCandidate(span, topLevel) {
  const text = span.replace(/:\d+(?:-\d+)?$/, '');
  if (text === '' || /\s/.test(text) || !text.includes('/')) {
    return null;
  }
  if (/[*{<$]/.test(text) || text.includes('://')) {
    return null;
  }
  const trailingSlash = text.endsWith('/');
  const segments = text.split('/').filter((part) => part !== '');
  if (segments.length === 0) {
    return null;
  }
  const last = segments.at(-1);
  if (!trailingSlash && path.posix.extname(last) === '') {
    return null;
  }
  const relative = text.startsWith('./') || text.startsWith('../');
  if (!relative && !topLevel.has(segments[0])) {
    return null;
  }
  return { text, relative, directory: trailingSlash };
}

// --- Rules ------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function originRanges(headings, originHeading, lineCount) {
  const ranges = [];
  if (!originHeading) {
    return ranges;
  }
  const wanted = originHeading.trim().toLowerCase();
  headings.forEach((heading, index) => {
    if (heading.text.toLowerCase() !== wanted) {
      return;
    }
    const next = headings
      .slice(index + 1)
      .find((other) => other.level <= heading.level);
    ranges.push([heading.line, next ? next.line - 1 : lineCount]);
  });
  return ranges;
}

function readWorkspaceMembers(fsView, workspaceFile) {
  const text = fsView.read(workspaceFile);
  const patterns = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item) {
      patterns.push(item[1].replace(/^['"]|['"]$/g, ''));
    } else if (line.trim() !== '' && !/^\s/.test(line)) {
      inPackages = false;
    }
  }
  const members = new Set();
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      continue;
    }
    const clean = pattern.replace(/\/+$/, '');
    if (clean.endsWith('/*')) {
      const parent = clean.slice(0, -2);
      const entries = fsView.list(parent);
      for (const [name, entry] of entries ?? []) {
        const member = `${parent}/${name}`;
        if (entry.isDirectory() && fsView.exists(`${member}/package.json`)) {
          members.add(member);
        }
      }
    } else if (fsView.exists(`${clean}/package.json`)) {
      members.add(clean);
    }
  }
  return [...members].sort();
}

function checkModuleMap(fsView, moduleMap, add) {
  if (!fsView.exists(moduleMap.file)) {
    add({ rule: 'required-missing', document: moduleMap.file });
    return;
  }
  const { lines, headings } = scanMarkdown(fsView.read(moduleMap.file));
  const members = readWorkspaceMembers(fsView, moduleMap.workspaceFile);
  for (const member of members) {
    const index = headings.findIndex(
      (heading) =>
        heading.level === 3 &&
        heading.text.replace(/`/g, '').trim().replace(/\/$/, '') === member
    );
    if (index === -1) {
      add({ rule: 'module-unmapped', document: member });
      continue;
    }
    const heading = headings[index];
    const next = headings
      .slice(index + 1)
      .find((other) => other.level <= heading.level);
    const body = lines.slice(heading.line, next ? next.line - 1 : lines.length);
    for (const field of moduleMap.fields) {
      const pattern = new RegExp(
        `^\\s*(?:[-*]\\s+)?\\*\\*${escapeRegExp(field)}(?::\\*\\*|\\*\\*:)\\s*(.*)$`,
        'i'
      );
      const filled = body.some((line) => {
        const match = pattern.exec(line);
        return match !== null && match[1].trim() !== '';
      });
      if (!filled) {
        add({ rule: 'module-incomplete', document: member, subject: field });
      }
    }
  }
}

/**
 * Runs every check against `root` with a parsed config. Has no side effects.
 * Throws DocsCheckUsageError when the config, entry point, index, or
 * workspace file cannot be used.
 *
 * @returns {{ findings: Array<{ rule: string, document: string, line?: number, subject?: string }>, documentCount: number }}
 */
export function checkDocs({ root, config }) {
  validateConfig(config);
  const fsView = createFileSystem(root);
  for (const key of ['entryPoint', 'index']) {
    if (!fsView.exists(config[key])) {
      throw new DocsCheckUsageError(
        `docs:check: ${key} file ${config[key]} does not exist`
      );
    }
  }
  if (config.moduleMap && !fsView.exists(config.moduleMap.workspaceFile)) {
    throw new DocsCheckUsageError(
      `docs:check: moduleMap.workspaceFile ${config.moduleMap.workspaceFile} does not exist`
    );
  }

  const findings = [];
  const add = (finding) => findings.push(finding);
  const topLevel = new Set(fsView.list('')?.keys() ?? []);
  const ignorePaths = config.ignorePaths ?? [];
  const forbiddenTerms = (config.forbiddenTerms ?? []).map((term) => ({
    term,
    pattern: new RegExp(
      `(?<![A-Za-z0-9_-])${escapeRegExp(term)}(?![A-Za-z0-9_-])`,
      'i'
    ),
  }));
  const documents = fsView.filesMatching(config.documents);
  let entryTargets = new Set();

  for (const document of documents) {
    const { lines, headings, links, spans } = scanMarkdown(
      fsView.read(document)
    );
    const targets = new Set();

    for (const link of links) {
      const target = decode(link.target.replace(/[?#].*$/, ''));
      if (
        link.target.startsWith('#') ||
        isExternal(link.target) ||
        target === ''
      ) {
        continue;
      }
      const resolved = resolveFrom(document, target);
      if (resolved === null) {
        add({
          rule: 'broken-link',
          document,
          line: link.line,
          subject: 'outside template root',
        });
        continue;
      }
      if (!fsView.exists(resolved)) {
        add({
          rule: 'broken-link',
          document,
          line: link.line,
          subject: target,
        });
        continue;
      }
      targets.add(resolved);
    }
    if (document === config.entryPoint) {
      entryTargets = targets;
    }

    for (const span of spans) {
      if (span.exempt) {
        continue;
      }
      const candidate = stalePathCandidate(span.text, topLevel);
      if (!candidate) {
        continue;
      }
      const resolved = candidate.relative
        ? resolveFrom(document, candidate.text)
        : resolveFrom('', candidate.text);
      if (
        resolved !== null &&
        ignorePaths.some(
          (glob) =>
            matchesGlob(resolved, glob) || matchesGlob(`${resolved}/`, glob)
        )
      ) {
        continue;
      }
      if (
        resolved === null ||
        !fsView.exists(resolved, { directory: candidate.directory })
      ) {
        add({
          rule: 'stale-path',
          document,
          line: span.line,
          subject: candidate.text,
        });
      }
    }

    const level2 = new Set(
      headings
        .filter((heading) => heading.level === 2)
        .map((heading) => heading.text.toLowerCase())
    );
    for (const rule of config.requiredSections ?? []) {
      if (!matchesGlob(document, rule.match)) {
        continue;
      }
      for (const heading of rule.headings) {
        if (!level2.has(heading.trim().toLowerCase())) {
          add({ rule: 'missing-section', document, subject: heading });
        }
      }
    }

    if (forbiddenTerms.length > 0) {
      const exempt = originRanges(headings, config.originHeading, lines.length);
      lines.forEach((line, index) => {
        const lineNumber = index + 1;
        if (
          exempt.some(
            ([start, end]) => lineNumber >= start && lineNumber <= end
          )
        ) {
          return;
        }
        for (const { term, pattern } of forbiddenTerms) {
          if (pattern.test(line)) {
            add({
              rule: 'origin-term',
              document,
              line: lineNumber,
              subject: term,
            });
          }
        }
      });
    }
  }

  const indexed = new Set();
  fsView
    .read(config.index)
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) {
        return;
      }
      const entry = line.split(/\s+/)[0].replace(/^\.\//, '');
      indexed.add(entry);
      if (!fsView.exists(entry)) {
        add({
          rule: 'index-stale',
          document: config.index,
          line: index + 1,
          subject: entry,
        });
      }
    });

  for (const document of documents) {
    if (!indexed.has(document)) {
      add({ rule: 'index-missing', document });
    }
    if (document !== config.entryPoint && !entryTargets.has(document)) {
      add({ rule: 'entry-unlinked', document });
    }
  }
  if (!entryTargets.has(config.index)) {
    add({ rule: 'entry-unlinked', document: config.index });
  }

  for (const required of config.requiredDocuments ?? []) {
    if (!fsView.exists(required)) {
      add({ rule: 'required-missing', document: required });
    }
  }

  if (config.moduleMap) {
    checkModuleMap(fsView, config.moduleMap, add);
  }

  return { findings: sortFindings(findings), documentCount: documents.length };
}

function sortFindings(findings) {
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return findings.sort(
    (a, b) =>
      compare(a.document, b.document) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      compare(a.rule, b.rule) ||
      compare(a.subject ?? '', b.subject ?? '')
  );
}

export function formatFinding(finding) {
  const location =
    finding.line === undefined
      ? finding.document
      : `${finding.document}:${finding.line}`;
  return [finding.rule, location, finding.subject]
    .filter((part) => part !== undefined)
    .join(' ');
}

export function formatReport({ findings, documentCount }) {
  return [
    ...findings.map(formatFinding),
    `docs:check: ${findings.length} problems in ${documentCount} documents`,
  ].join('\n');
}

// --- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const options = { root: undefined, config: undefined, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') {
      options.selfTest = true;
    } else if (arg === '--root' || arg === '--config') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new DocsCheckUsageError(`docs:check: ${arg} needs a value`);
      }
      options[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new DocsCheckUsageError(
        `docs:check: unknown argument ${arg}. Use --root <dir>, --config <path>, or --self-test`
      );
    }
  }
  return options;
}

function displayPath(root, file) {
  const relative = path.relative(root, file);
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? toPosix(file)
    : toPosix(relative);
}

export function loadConfig(root, configPath) {
  const file = configPath
    ? path.resolve(configPath)
    : path.join(root, DEFAULT_CONFIG);
  const label = displayPath(root, file);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new DocsCheckUsageError(
      `docs:check: config file ${label} is missing or unreadable`
    );
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new DocsCheckUsageError(
      `docs:check: config file ${label} is not valid JSON`
    );
  }
  return validateConfig(config, `config file ${label}`);
}

export function run(argv, { stdout, stderr }) {
  try {
    const options = parseArgs(argv);
    if (options.selfTest) {
      selfTest();
      stdout('docs:check self-test passed');
      return 0;
    }
    const root = path.resolve(
      options.root ??
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    );
    let rootIsDirectory = false;
    try {
      rootIsDirectory = statSync(root).isDirectory();
    } catch {
      rootIsDirectory = false;
    }
    if (!rootIsDirectory) {
      throw new DocsCheckUsageError(
        `docs:check: root ${toPosix(root)} is not a readable directory`
      );
    }
    const config = loadConfig(root, options.config);
    const result = checkDocs({ root, config });
    stdout(formatReport(result));
    return result.findings.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof DocsCheckUsageError) {
      stderr(error.message);
      return 2;
    }
    throw error;
  }
}

function selfTest() {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-check-self-'));
  try {
    const files = {
      'AGENTS.md':
        '# Agents\n\n## Start here\n\n[Guide](docs/guide.md) and [index](docs/agent-index.txt).\n',
      'docs/guide.md': '# Guide\n\nSee `docs/guide.md`.\n',
      'docs/agent-index.txt': 'AGENTS.md  Entry\ndocs/guide.md  Guide\n',
    };
    for (const [relative, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), content);
    }
    const config = {
      entryPoint: 'AGENTS.md',
      index: 'docs/agent-index.txt',
      documents: ['AGENTS.md', 'docs/**/*.md'],
      requiredSections: [{ match: 'AGENTS.md', headings: ['Start here'] }],
    };
    const clean = checkDocs({ root, config });
    if (clean.findings.length !== 0 || clean.documentCount !== 2) {
      throw new Error(`clean fixture failed: ${formatReport(clean)}`);
    }
    writeFileSync(
      path.join(root, 'docs/guide.md'),
      '# Guide\n\n[Gone](gone.md) and `docs/gone.md`.\n'
    );
    const broken = formatReport(checkDocs({ root, config }));
    for (const expected of [
      'broken-link docs/guide.md:3 gone.md',
      'stale-path docs/guide.md:3 docs/gone.md',
    ]) {
      if (!broken.includes(expected)) {
        throw new Error(`self-test expected "${expected}" in:\n${broken}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  });
}
