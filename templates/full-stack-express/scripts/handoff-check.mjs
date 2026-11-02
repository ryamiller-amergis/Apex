/**
 * Validates docs/handoff.md ownership, contract, register, and URL rules.
 * Used only from check-docs.mjs; findings use plain-text subjects only.
 */

export const HANDOFF_DOCUMENT = 'docs/handoff.md';

const ALLOWED_OWNERS = new Set(['Template', 'Platform Engineering']);

const REQUIRED_DECISIONS = [
  'production identity provider',
  'rbac',
  'data classification',
  'nfr targets and test execution policy',
  'feature-flag provider',
];

const ABSOLUTE_URL = /https?:\/\/[^\s)\]>,'"`]+/gi;

function splitTableRow(text, { stripBackticks = true } = {}) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return null;
  }
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => {
      const value = cell.trim();
      return stripBackticks ? value.replace(/`/g, '') : value;
    });
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function sectionBody(lines, headings, title) {
  const heading = headings.find(
    (item) =>
      item.level === 2 && item.text.toLowerCase() === title.toLowerCase()
  );
  if (!heading) {
    return null;
  }
  const next = headings.find(
    (item) => item.level <= 2 && item.line > heading.line
  );
  const end = next ? next.line - 1 : lines.length;
  return lines.slice(heading.line, end).map((text, offset) => ({
    text,
    line: heading.line + offset + 1,
  }));
}

function parseTable(body) {
  const rows = [];
  for (const entry of body) {
    const cells = splitTableRow(entry.text);
    if (!cells) {
      if (rows.length > 0) {
        break;
      }
      continue;
    }
    const rawCells = splitTableRow(entry.text, { stripBackticks: false });
    rows.push({ cells, rawCells, line: entry.line, raw: entry.text });
  }
  if (rows.length < 2) {
    return null;
  }
  const [header, separator, ...data] = rows;
  if (!isSeparatorRow(separator.cells)) {
    return null;
  }
  const columnIndex = (name) =>
    header.cells.findIndex(
      (cell) => cell.trim().toLowerCase() === name.toLowerCase()
    );
  return { header, data, columnIndex };
}

function extractBacktickPaths(text) {
  const paths = [];
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const candidate = match[1].trim();
    if (candidate.includes('/') && !candidate.includes(' ')) {
      paths.push(candidate.replace(/\\/g, '/'));
    }
  }
  return paths;
}

export function readEnvExampleKeys(text) {
  const keys = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match) {
      keys.add(match[1]);
    }
  }
  return keys;
}

export function parseEndpointIdentifier(identifier) {
  const trimmed = identifier.trim();
  const match = /^(GET|PUT|POST|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/i.exec(
    trimmed
  );
  if (!match) {
    return null;
  }
  return { method: match[1].toUpperCase(), path: match[2] };
}

export function openApiHasOperation(openApi, method, routePath) {
  const pathItem = openApi?.paths?.[routePath];
  if (!pathItem) {
    return false;
  }
  const key = method.toLowerCase();
  return typeof pathItem[key] === 'object';
}

/**
 * @param {{ kind: string, identifier: string, fsView: object, scripts: Record<string,string>, envKeys: Set<string>, openApi: object }} ctx
 */
export function resolveHandoffContract(ctx) {
  const kind = ctx.kind.trim().toLowerCase();
  const id = ctx.identifier.trim();
  if (kind === 'script') {
    return Object.prototype.hasOwnProperty.call(ctx.scripts, id);
  }
  if (kind === 'manifest' || kind === 'container') {
    return ctx.fsView.exists(id);
  }
  if (kind === 'endpoint') {
    const parsed = parseEndpointIdentifier(id);
    if (!parsed) {
      return false;
    }
    return openApiHasOperation(ctx.openApi, parsed.method, parsed.path);
  }
  if (kind === 'env') {
    return ctx.envKeys.has(id);
  }
  return false;
}

function allowedUrlHost(host) {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1') {
    return true;
  }
  if (lower.startsWith('example.')) {
    return true;
  }
  return false;
}

function checkHandoffUrls(lines, add) {
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    for (const match of line.matchAll(ABSOLUTE_URL)) {
      let host;
      try {
        host = new URL(match[0]).hostname;
      } catch {
        add({
          rule: 'handoff-url',
          document: HANDOFF_DOCUMENT,
          line: lineNumber,
          subject: match[0],
        });
        continue;
      }
      if (!allowedUrlHost(host)) {
        add({
          rule: 'handoff-url',
          document: HANDOFF_DOCUMENT,
          line: lineNumber,
          subject: host,
        });
      }
    }
  });
}

function normalizeDecision(text) {
  return text.trim().toLowerCase();
}

function decisionMatches(required, cell) {
  return normalizeDecision(cell).includes(required);
}

/**
 * @param {{ fsView: { exists: Function, read: Function }, add: Function, scanMarkdown: Function }} deps
 */
export function checkHandoffDocument(deps) {
  const { fsView, add, scanMarkdown } = deps;
  if (!fsView.exists(HANDOFF_DOCUMENT)) {
    return;
  }
  const text = fsView.read(HANDOFF_DOCUMENT);
  const { lines, headings } = scanMarkdown(text);

  checkHandoffUrls(lines, add);

  let scripts = {};
  if (fsView.exists('package.json')) {
    try {
      scripts = JSON.parse(fsView.read('package.json')).scripts ?? {};
    } catch {
      scripts = {};
    }
  }

  let openApi = {};
  const openApiPath = 'packages/contracts/openapi/openapi.json';
  if (fsView.exists(openApiPath)) {
    try {
      openApi = JSON.parse(fsView.read(openApiPath));
    } catch {
      openApi = {};
    }
  }

  const envKeys = fsView.exists('.env.example')
    ? readEnvExampleKeys(fsView.read('.env.example'))
    : new Set();

  const contractCtx = { fsView, scripts, envKeys, openApi };

  const ownershipBody = sectionBody(lines, headings, 'Ownership');
  if (ownershipBody) {
    const table = parseTable(ownershipBody);
    if (table) {
      const ownerCol = table.columnIndex('Owner');
      const areaCol = table.columnIndex('Area');
      if (ownerCol !== -1) {
        for (const row of table.data) {
          if (isSeparatorRow(row.cells)) {
            continue;
          }
          const owner = row.cells[ownerCol] ?? '';
          const area = areaCol === -1 ? 'row' : (row.cells[areaCol] ?? 'row');
          if (owner === '' || !ALLOWED_OWNERS.has(owner)) {
            add({
              rule: 'handoff-owner',
              document: HANDOFF_DOCUMENT,
              line: row.line,
              subject: area === '' ? 'row' : area,
            });
          }
        }
      }
    }
  }

  const contractsBody = sectionBody(
    lines,
    headings,
    'Contracts Platform Engineering Consumes'
  );
  if (contractsBody) {
    const table = parseTable(contractsBody);
    if (table) {
      const kindCol = table.columnIndex('Kind');
      const idCol = table.columnIndex('Identifier');
      if (kindCol !== -1 && idCol !== -1) {
        for (const row of table.data) {
          if (isSeparatorRow(row.cells)) {
            continue;
          }
          const kind = row.cells[kindCol] ?? '';
          const identifier = row.cells[idCol] ?? '';
          if (
            !resolveHandoffContract({
              kind,
              identifier,
              ...contractCtx,
            })
          ) {
            add({
              rule: 'handoff-contract',
              document: HANDOFF_DOCUMENT,
              line: row.line,
              subject: identifier === '' ? kind : identifier,
            });
          }
        }
      }
    }
  }

  const registerBody = sectionBody(
    lines,
    headings,
    'Unresolved Decision Register'
  );
  const foundDecisions = new Set();
  if (registerBody) {
    const table = parseTable(registerBody);
    if (table) {
      const decisionCol = table.columnIndex('Decision');
      const extensionCol = table.columnIndex('Extension point');
      if (decisionCol !== -1 && extensionCol !== -1) {
        for (const row of table.data) {
          if (isSeparatorRow(row.cells)) {
            continue;
          }
          const decision = row.cells[decisionCol] ?? '';
          const extensionText = row.rawCells?.[extensionCol] ?? '';

          for (const required of REQUIRED_DECISIONS) {
            if (decisionMatches(required, decision)) {
              foundDecisions.add(required);
            }
          }

          if (extensionText.replace(/`/g, '').trim() === '') {
            add({
              rule: 'handoff-register',
              document: HANDOFF_DOCUMENT,
              line: row.line,
              subject: decision === '' ? 'row' : decision,
            });
            continue;
          }

          const paths = extractBacktickPaths(extensionText);
          if (paths.length === 0) {
            add({
              rule: 'handoff-register',
              document: HANDOFF_DOCUMENT,
              line: row.line,
              subject: decision === '' ? 'row' : decision,
            });
            continue;
          }
          for (const repoPath of paths) {
            if (!fsView.exists(repoPath)) {
              add({
                rule: 'handoff-extension',
                document: HANDOFF_DOCUMENT,
                line: row.line,
                subject: `${decision}|${repoPath}`,
              });
            }
          }
        }
      }
    }
  }

  for (const required of REQUIRED_DECISIONS) {
    if (!foundDecisions.has(required)) {
      add({
        rule: 'handoff-register-missing',
        document: HANDOFF_DOCUMENT,
        subject: required,
      });
    }
  }
}
