import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const RANGE_GRAMMAR = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.0\.0$/;
const PACKAGE_MANAGER = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:\+.+)?$/;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const rangeGrammarMessage = (range) =>
  `check-toolchain: engines.node "${range}" must match ">=X.Y.Z <N.0.0"`;

function readText(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function parsePackageManager(value) {
  const match = PACKAGE_MANAGER.exec(value ?? '');
  return match ? match[1] : null;
}

function parseTuple(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareTuple(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function displayVersion(version) {
  return String(version).replace(/^v/, '');
}

function parseRange(range) {
  const match = RANGE_GRAMMAR.exec(range ?? '');
  if (!match) {
    return null;
  }
  return {
    lower: [Number(match[1]), Number(match[2]), Number(match[3])],
    upper: [Number(match[4]), 0, 0],
  };
}

function versionInRange(version, range) {
  const parsed = parseRange(range);
  const actual = parseTuple(version);
  if (!parsed || !actual) {
    return false;
  }
  return (
    compareTuple(actual, parsed.lower) >= 0 &&
    compareTuple(actual, parsed.upper) < 0
  );
}

function readSections(text) {
  const sections = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const indent = line.match(/^[ \t]*/)[0].length;
    if (indent === 0) {
      if (trimmed.startsWith('#')) {
        continue;
      }
      const top = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(trimmed);
      if (!top) {
        current = null;
        continue;
      }
      current = top[1];
      const inline = top[2].trim();
      sections.set(current, inline ? [inline] : []);
      continue;
    }
    if (current) {
      sections.get(current).push(line);
    }
  }
  return sections;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseList(lines) {
  const items = [];
  for (const line of lines) {
    const match = /^[ \t]+-[ \t]+(.+?)\s*$/.exec(line);
    if (!match) {
      return { error: line.trim() };
    }
    items.push(unquote(match[1].trim()));
  }
  return { items };
}

function parseCatalog(lines) {
  const entries = new Map();
  const problems = [];
  for (const line of lines) {
    const match =
      /^[ \t]+(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._/@-]+))\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*$/.exec(
        line
      );
    if (!match) {
      problems.push(
        `check-toolchain: pnpm-workspace.yaml catalog must be a flat name: version mapping. Unsupported line: ${line.trim()}`
      );
      continue;
    }
    const name = match[1] || match[2] || match[3];
    const version = match[4] ?? match[5] ?? match[6];
    if (entries.has(name)) {
      problems.push(
        `check-toolchain: catalog entry ${name} is listed more than once`
      );
      continue;
    }
    entries.set(name, version);
  }
  return { entries, problems };
}

function listMemberDirs(root, patterns, problems) {
  const dirs = [];
  for (const pattern of patterns) {
    if (!/^[A-Za-z0-9._/-]+\/\*$/.test(pattern)) {
      problems.push(
        `check-toolchain: pnpm-workspace.yaml package pattern "${pattern}" must be a single-level "*" glob`
      );
      continue;
    }
    const parent = pattern.slice(0, -2);
    const parentAbs = path.join(root, parent);
    if (!existsSync(parentAbs)) {
      continue;
    }
    for (const entry of readdirSync(parentAbs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.push(path.join(parentAbs, entry.name));
      }
    }
  }
  return dirs;
}

function checkDependencyMap(problems, memberLabel, manifest) {
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (!deps || typeof deps !== 'object') {
      continue;
    }
    for (const [name, spec] of Object.entries(deps)) {
      if (spec !== 'catalog:' && spec !== 'workspace:*') {
        problems.push(
          `check-toolchain: ${memberLabel}: ${name} uses "${spec}" but must use "catalog:" or "workspace:*"`
        );
      }
    }
  }
}

function expectedExtends(relDir, scope) {
  if (relDir === 'packages/config') {
    return './tsconfig.base.json';
  }
  const file =
    relDir === 'apps/web' || relDir === 'packages/ui'
      ? 'tsconfig.react.json'
      : 'tsconfig.node.json';
  return `${scope}/config/${file}`;
}

function readCompatibilityTable(text) {
  const rows = new Map();
  const problems = [];
  let inTable = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (inTable) {
        break;
      }
      continue;
    }
    const cells = trimmed
      .split('|')
      .map((cell) => cell.trim())
      .filter((_, index, all) => index > 0 && index < all.length - 1);
    if (cells.length < 2) {
      continue;
    }
    if (cells[0] === 'Component' && cells[1] === 'Pinned version') {
      inTable = true;
      continue;
    }
    if (!inTable || /^:?-+:?$/.test(cells[0])) {
      continue;
    }
    const name = cells[0];
    const version = cells[1];
    if (rows.has(name)) {
      problems.push(
        `check-toolchain: docs/compatibility.md lists ${name} more than once`
      );
      continue;
    }
    rows.set(name, version);
  }
  if (!inTable) {
    problems.push(
      'check-toolchain: docs/compatibility.md must contain a table with columns Component and Pinned version'
    );
  }
  return { rows, problems };
}

function checkPreinstall(root) {
  const problems = [];
  const manifestPath = path.join(root, 'package.json');
  if (!existsSync(manifestPath)) {
    return ['check-toolchain: package.json is missing'];
  }
  const manifest = readJson(manifestPath);
  const userAgent = process.env.npm_config_user_agent ?? '';
  if (!userAgent.startsWith('pnpm/')) {
    const npmLock = path.join(root, 'package-lock.json');
    if (existsSync(npmLock)) {
      rmSync(npmLock);
    }
    return [
      'check-toolchain: this workspace uses pnpm. Run "corepack enable", then "pnpm install --frozen-lockfile" from the workspace root.',
    ];
  }
  const pinned = parsePackageManager(manifest.packageManager);
  const actualMatch = /^pnpm\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(
    userAgent
  );
  const actual = actualMatch ? actualMatch[1] : userAgent;
  if (!pinned || actual !== pinned) {
    problems.push(
      `check-toolchain: pnpm ${actual} does not match the pinned pnpm ${pinned ?? 'unknown'} (packageManager in package.json). Run "corepack enable" and retry.`
    );
  }
  const range = manifest.engines?.node;
  if (!parseRange(range)) {
    problems.push(rangeGrammarMessage(String(range)));
    return problems;
  }
  const nodeVersion = displayVersion(process.version);
  if (!versionInRange(nodeVersion, range)) {
    problems.push(
      `check-toolchain: Node ${nodeVersion} is outside the supported range ${range} (engines.node in package.json). Install the version in .nvmrc and retry.`
    );
  }
  return problems;
}

function checkWorkspace(root) {
  const problems = [];
  const manifestPath = path.join(root, 'package.json');
  const workspacePath = path.join(root, 'pnpm-workspace.yaml');
  const nvmrcPath = path.join(root, '.nvmrc');
  const tablePath = path.join(root, 'docs', 'compatibility.md');

  if (!existsSync(manifestPath)) {
    return ['check-toolchain: package.json is missing'];
  }
  const manifest = readJson(manifestPath);
  const pinnedPnpm = parsePackageManager(manifest.packageManager);
  const enginesPnpm = manifest.engines?.pnpm;
  if (!pinnedPnpm) {
    problems.push(
      'check-toolchain: package.json packageManager must pin pnpm@<version>'
    );
  }
  if (pinnedPnpm && enginesPnpm !== pinnedPnpm) {
    problems.push(
      `check-toolchain: packageManager pnpm@${pinnedPnpm} does not equal engines.pnpm ${enginesPnpm}`
    );
  }

  const range = manifest.engines?.node;
  if (!parseRange(range)) {
    problems.push(rangeGrammarMessage(String(range)));
  } else if (!existsSync(nvmrcPath)) {
    problems.push('check-toolchain: .nvmrc is missing');
  } else {
    const nvmrc = readText(nvmrcPath).trim();
    if (!versionInRange(nvmrc, range)) {
      problems.push(
        `check-toolchain: .nvmrc ${displayVersion(nvmrc)} is outside engines.node ${range}`
      );
    }
  }

  if (!existsSync(workspacePath)) {
    problems.push('check-toolchain: pnpm-workspace.yaml is missing');
    return problems;
  }
  const sections = readSections(readText(workspacePath));
  const packageLines = sections.get('packages');
  if (!packageLines) {
    problems.push(
      'check-toolchain: pnpm-workspace.yaml must list workspace packages'
    );
  }
  const packageParse = packageLines ? parseList(packageLines) : { items: [] };
  if (packageParse.error) {
    problems.push(
      `check-toolchain: pnpm-workspace.yaml package pattern "${packageParse.error}" must be a single-level "*" glob`
    );
  }
  const catalogLines = sections.get('catalog');
  if (!catalogLines) {
    problems.push(
      'check-toolchain: pnpm-workspace.yaml must contain a flat catalog block'
    );
  }
  const catalog = catalogLines
    ? parseCatalog(catalogLines)
    : { entries: new Map(), problems: [] };
  problems.push(...catalog.problems);
  for (const [name, version] of catalog.entries) {
    if (!EXACT_VERSION.test(version)) {
      problems.push(
        `check-toolchain: catalog entry ${name} has non-exact version "${version}"`
      );
    }
  }

  const scopeMatch = /^(@[^/]+)\//.exec(manifest.name ?? '');
  const scope = scopeMatch ? scopeMatch[1] : null;
  if (!scope) {
    problems.push(
      'check-toolchain: root package.json name must be a scoped package so the TypeScript extends check can read the scope'
    );
  }

  checkDependencyMap(problems, manifest.name ?? 'root', manifest);
  if (packageParse.items) {
    for (const dir of listMemberDirs(root, packageParse.items, problems)) {
      const relDir = path.relative(root, dir).split(path.sep).join('/');
      const memberManifestPath = path.join(dir, 'package.json');
      if (!existsSync(memberManifestPath)) {
        problems.push(`check-toolchain: ${relDir}: package.json is missing`);
        continue;
      }
      const memberManifest = readJson(memberManifestPath);
      const memberLabel = memberManifest.name ?? relDir;
      checkDependencyMap(problems, memberLabel, memberManifest);
      if (!scope) {
        continue;
      }
      const expected = expectedExtends(relDir, scope);
      const tsconfigPath = path.join(dir, 'tsconfig.json');
      let actual;
      if (!existsSync(tsconfigPath)) {
        actual = undefined;
      } else {
        try {
          const tsconfig = readJson(tsconfigPath);
          actual = tsconfig.extends;
        } catch {
          actual = undefined;
        }
      }
      if (actual !== expected) {
        problems.push(
          `check-toolchain: ${memberLabel}: tsconfig.json must extend ${expected}`
        );
      }
    }
  }

  if (!existsSync(tablePath)) {
    problems.push('check-toolchain: docs/compatibility.md is missing');
    return problems;
  }
  const table = readCompatibilityTable(readText(tablePath));
  problems.push(...table.problems);
  if (existsSync(nvmrcPath)) {
    const nvmrc = displayVersion(readText(nvmrcPath).trim());
    const listed = table.rows.get('Node');
    if (!listed) {
      problems.push(
        `check-toolchain: docs/compatibility.md is missing a row for Node ${nvmrc}`
      );
    } else if (listed !== nvmrc) {
      problems.push(
        `check-toolchain: docs/compatibility.md lists Node ${listed} but .nvmrc pins ${nvmrc}`
      );
    }
  }
  if (pinnedPnpm) {
    const listed = table.rows.get('pnpm');
    if (!listed) {
      problems.push(
        `check-toolchain: docs/compatibility.md is missing a row for pnpm ${pinnedPnpm}`
      );
    } else if (listed !== pinnedPnpm) {
      problems.push(
        `check-toolchain: docs/compatibility.md lists pnpm ${listed} but packageManager pins ${pinnedPnpm}`
      );
    }
  }
  for (const [name, version] of catalog.entries) {
    const listed = table.rows.get(name);
    if (!listed) {
      problems.push(
        `check-toolchain: docs/compatibility.md is missing a row for ${name} ${version}`
      );
    } else if (listed !== version) {
      problems.push(
        `check-toolchain: docs/compatibility.md lists ${name} ${listed} but the catalog pins ${version}`
      );
    }
  }
  for (const [name, version] of table.rows) {
    if (name === 'Node' || name === 'pnpm' || catalog.entries.has(name)) {
      continue;
    }
    problems.push(
      `check-toolchain: docs/compatibility.md lists ${name} ${version} but the catalog has no entry for it`
    );
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const preinstall = args.includes('--preinstall');
  const positional = args.filter((arg) => arg !== '--preinstall');
  if (positional.length > 1) {
    process.stderr.write('check-toolchain: pass at most one workspace path\n');
    process.exit(1);
  }
  const root = path.resolve(positional[0] ?? process.cwd());
  const problems = preinstall ? checkPreinstall(root) : checkWorkspace(root);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
}

main();
