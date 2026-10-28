import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const networkCalls = vi.hoisted(() => ({ count: 0 }));

function throwingModule() {
  const fail = () => {
    networkCalls.count += 1;
    throw new Error('docs:check must not open a network connection');
  };
  const handler = { get: () => fail };
  const stub = new Proxy({}, handler);
  return { default: stub, request: fail, get: fail, connect: fail };
}

vi.mock('node:http', () => throwingModule());
vi.mock('node:https', () => throwingModule());
vi.mock('node:net', () => throwingModule());

const { checkDocs, formatReport } = await import('./check-docs.mjs');

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const templateRoot = path.resolve(scriptsDir, '..');
const script = path.join(scriptsDir, 'check-docs.mjs');

const RUNBOOK_HEADINGS = [
  'Purpose',
  'Prerequisites',
  'Steps',
  'Verify',
  'Troubleshooting',
];

const baseConfig = {
  entryPoint: 'AGENTS.md',
  index: 'docs/agent-index.txt',
  documents: ['AGENTS.md', 'docs/**/*.md'],
  requiredDocuments: [
    'docs/architecture.md',
    'docs/module-map.md',
    'docs/runbooks/local-setup.md',
  ],
  requiredSections: [
    { match: 'docs/runbooks/*.md', headings: RUNBOOK_HEADINGS },
    {
      match: 'AGENTS.md',
      headings: ['Start here', 'Documentation map', 'Skills', 'Scripts'],
    },
  ],
  moduleMap: {
    file: 'docs/module-map.md',
    workspaceFile: 'pnpm-workspace.yaml',
    fields: ['Responsibility', 'Public interface'],
  },
  ignorePaths: ['dist/**', 'node_modules/**', '.env', 'coverage/**'],
  forbiddenTerms: ['Apex', 'Amergis', 'ai-pilot'],
  originHeading: 'Template origin',
};

function runbook(skip = []) {
  return RUNBOOK_HEADINGS.filter((heading) => !skip.includes(heading))
    .map((heading) => `## ${heading}\n\nText.\n`)
    .join('\n');
}

function baseFiles() {
  return {
    'package.json': '{}\n',
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'packages/ui/package.json': '{}\n',
    'packages/ui/src/index.ts': 'export {};\n',
    'AGENTS.md': [
      '# Agents',
      '',
      '## Start here',
      '',
      'Read [the architecture](docs/architecture.md) first.',
      '',
      '## Documentation map',
      '',
      '- [Module map](docs/module-map.md)',
      '- [Local setup runbook](docs/runbooks/local-setup.md)',
      '- [Agent index](docs/agent-index.txt)',
      '',
      '## Skills',
      '',
      'None yet.',
      '',
      '## Scripts',
      '',
      'Run `pnpm docs:check`.',
      '',
    ].join('\n'),
    'docs/agent-index.txt': [
      '# path  summary',
      'AGENTS.md  Entry point',
      'docs/architecture.md  Architecture',
      'docs/module-map.md  Module map',
      'docs/runbooks/local-setup.md  Local setup',
      '',
    ].join('\n'),
    'docs/architecture.md': [
      '# Architecture',
      '',
      'The UI entry is `packages/ui/src/index.ts`.',
      '',
      '## Template origin',
      '',
      'This template began inside Apex.',
      '',
    ].join('\n'),
    'docs/module-map.md': [
      '# Module map',
      '',
      '### `packages/ui`',
      '',
      '**Responsibility:** Design system.',
      '',
      '**Public interface:** `packages/ui/src/index.ts`',
      '',
    ].join('\n'),
    'docs/runbooks/local-setup.md': `# Local setup\n\n${runbook()}`,
    'docs/docs-check.config.json': `${JSON.stringify(baseConfig, null, 2)}\n`,
  };
}

const roots = [];

function fixture(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-check-'));
  roots.push(root);
  const files = { ...baseFiles(), ...overrides };
  for (const [relative, content] of Object.entries(files)) {
    if (content === null) {
      continue;
    }
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function configWith(patch) {
  return `${JSON.stringify({ ...baseConfig, ...patch }, null, 2)}\n`;
}

function cli(root, extra = []) {
  const result = spawnSync(
    process.execPath,
    [script, '--root', root, ...extra],
    { encoding: 'utf8', windowsHide: true }
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    lines: result.stdout.split('\n').filter((line) => line !== ''),
  };
}

function findingLines(run) {
  return run.lines.filter((line) => !line.startsWith('docs:check:'));
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe('docs:check clean tree', () => {
  it('VT-05 PBI-031 AC-0: a consistent tree exits 0 and reports the document count', () => {
    const run = cli(fixture());
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.lines).toEqual(['docs:check: 0 problems in 4 documents']);
  });

  it('VT-05 the pure core returns no findings and the document count', () => {
    const root = fixture();
    const config = JSON.parse(baseFiles()['docs/docs-check.config.json']);
    const result = checkDocs({ root, config });
    expect(result.findings).toEqual([]);
    expect(result.documentCount).toBe(4);
    expect(formatReport(result)).toBe('docs:check: 0 problems in 4 documents');
  });
});

describe('docs:check links', () => {
  it('VT-02 PBI-030 AC-1 TBI-034 DoD-0: a missing entry-point link target is reported with its line', () => {
    const files = baseFiles();
    const agents = files['AGENTS.md'].replace(
      '- [Agent index]',
      '- [Missing runbook](docs/runbooks/missing.md)\n- [Agent index]'
    );
    const run = cli(fixture({ 'AGENTS.md': agents }));
    expect(run.status).toBe(1);
    const line =
      agents
        .split('\n')
        .indexOf('- [Missing runbook](docs/runbooks/missing.md)') + 1;
    expect(run.lines).toContain(
      `broken-link AGENTS.md:${line} docs/runbooks/missing.md`
    );
    expect(run.lines.at(-1)).toBe('docs:check: 1 problems in 4 documents');
  });

  it('VT-10 BR-008: a link outside the root and a case-mismatched link are both broken', () => {
    const architecture = [
      '# Architecture',
      '',
      'See [server](../../src/server/x.ts).',
      'See [module map](Module-Map.md).',
      '',
    ].join('\n');
    const run = cli(fixture({ 'docs/architecture.md': architecture }));
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual([
      'broken-link docs/architecture.md:3 outside template root',
      'broken-link docs/architecture.md:4 Module-Map.md',
    ]);
  });

  it('VT-08 PBI-031 AC-3: external links are skipped and never fetched', () => {
    const architecture = [
      '# Architecture',
      '',
      'Read [the spec](https://example.com/x), [plain](http://example.com),',
      'mail [the team](mailto:team@example.test) or [call](tel:+10000000000).',
      'Jump to [a section](#overview) or [a file section](module-map.md#top).',
      '',
    ].join('\n');
    const root = fixture({ 'docs/architecture.md': architecture });
    networkCalls.count = 0;
    const config = JSON.parse(baseFiles()['docs/docs-check.config.json']);
    const result = checkDocs({ root, config });
    expect(result.findings).toEqual([]);
    expect(networkCalls.count).toBe(0);
    const run = cli(root);
    expect(run.status).toBe(0);
  });

  it('VT-08 the validator source imports no network module', () => {
    const source = readFileSync(script, 'utf8');
    expect(source).not.toMatch(/node:(http|https|net|dns|tls)\b/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/child_process/);
  });

  it('VT-12 PBI-031 security NFR: output names the link target and never the surrounding text', () => {
    const architecture = [
      '# Architecture',
      '',
      'password=hunter2 see [gone](docs/gone.md)',
      '',
    ].join('\n');
    const run = cli(fixture({ 'docs/architecture.md': architecture }));
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('docs/gone.md');
    expect(run.stdout).not.toContain('hunter2');
    expect(run.stdout).not.toContain('password');
  });

  it('checks reference-style link definitions and images', () => {
    const architecture = [
      '# Architecture',
      '',
      '![diagram](img/missing.png)',
      'See [the map][map].',
      '',
      '[map]: ./absent.md',
      '',
    ].join('\n');
    const run = cli(fixture({ 'docs/architecture.md': architecture }));
    expect(findingLines(run)).toEqual([
      'broken-link docs/architecture.md:3 img/missing.png',
      'broken-link docs/architecture.md:6 ./absent.md',
    ]);
  });

  it('resolves a leading slash from the template root', () => {
    const architecture = '# Architecture\n\nSee [map](/docs/module-map.md).\n';
    const run = cli(fixture({ 'docs/architecture.md': architecture }));
    expect(run.status).toBe(0);
  });
});

describe('docs:check stale paths', () => {
  it('VT-06 PBI-031 AC-1 TBI-034 DoD-2: a renamed path exits 1 and names the document and the path', () => {
    const api = [
      '# API',
      '',
      'The entry is `packages/ui/src/index.ts`.',
      'It used to be `packages/old-name/src/index.ts`.',
      '',
    ].join('\n');
    const files = baseFiles();
    const run = cli(
      fixture({
        'docs/api.md': api,
        'docs/agent-index.txt': `${files['docs/agent-index.txt']}docs/api.md  API\n`,
        'AGENTS.md': `${files['AGENTS.md']}\n[API](docs/api.md)\n`,
      })
    );
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual([
      'stale-path docs/api.md:4 packages/old-name/src/index.ts',
    ]);
  });

  it.each([
    ['a glob', '`packages/*/src/index.ts`'],
    ['a placeholder', '`packages/{name}/src/index.ts`'],
    ['an angle placeholder', '`packages/<name>/index.ts`'],
    ['a variable', '`$HOME/notes.md`'],
    ['a URL', '`https://example.com/a.md`'],
    ['an ignored path', '`dist/index.js`'],
    ['an unknown first segment', '`elsewhere/file.md`'],
    ['a command with spaces', '`node packages/gone/x.mjs`'],
    ['a span with no extension', '`packages/gone`'],
  ])('VT-11 skips %s', (_label, span) => {
    const architecture = `# Architecture\n\nSee ${span} here.\n`;
    const run = cli(fixture({ 'docs/architecture.md': architecture }));
    expect(findingLines(run)).toEqual([]);
  });

  it('VT-11 TBI-034: CRLF, fenced blocks, ignorePaths, the exempt comment, and line suffixes give no stale-path', () => {
    const lines = [
      '# Architecture',
      '',
      '```sh',
      'cat `packages/fenced/gone.ts`',
      '```',
      '',
      '~~~',
      '`packages/tilde/gone.ts`',
      '~~~',
      '',
      'Built output is `dist/assets/app.js` and `coverage/lcov.info`.',
      '<!-- docs-check-exempt -->',
      'Example: `packages/example/new-file.ts`.',
      'Inline `packages/inline/gone.ts` <!-- docs-check-exempt -->',
      'Range `docs/module-map.md:22-30` and line `docs/module-map.md:3`.',
      '',
    ];
    const builtOutput = {
      'dist/keep.txt': 'x\n',
      'coverage/keep.txt': 'x\n',
    };
    const lf = cli(
      fixture({ ...builtOutput, 'docs/architecture.md': lines.join('\n') })
    );
    const crlf = cli(
      fixture({ ...builtOutput, 'docs/architecture.md': lines.join('\r\n') })
    );
    expect(lf.status).toBe(0);
    expect(findingLines(lf)).toEqual([]);
    expect(crlf.lines).toEqual(lf.lines);
  });

  it('a trailing slash must name a directory, and ./ resolves from the document', () => {
    const architecture = [
      '# Architecture',
      '',
      'Folders: `packages/ui/` and `packages/missing/`.',
      'Sibling: `./module-map.md` and `./nope.md`.',
      '',
    ].join('\n');
    const run = cli(fixture({ 'docs/architecture.md': architecture }));
    expect(findingLines(run)).toEqual([
      'stale-path docs/architecture.md:3 packages/missing/',
      'stale-path docs/architecture.md:4 ./nope.md',
    ]);
  });

  it('a case mismatch in a path is stale on every operating system', () => {
    const architecture = '# Architecture\n\nSee `packages/UI/src/index.ts`.\n';
    const run = cli(fixture({ 'docs/architecture.md': architecture }));
    expect(findingLines(run)).toEqual([
      'stale-path docs/architecture.md:3 packages/UI/src/index.ts',
    ]);
  });
});

describe('docs:check sections', () => {
  it('VT-07 PBI-031 AC-2 TBI-034 DoD-1: a runbook missing Troubleshooting names the runbook and the section', () => {
    const run = cli(
      fixture({
        'docs/runbooks/local-setup.md': `# Local setup\n\n${runbook(['Troubleshooting'])}`,
      })
    );
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual([
      'missing-section docs/runbooks/local-setup.md Troubleshooting',
    ]);
  });

  it('matches level-2 headings trimmed and case-insensitively, and ignores other levels', () => {
    const body = runbook()
      .replace('## Verify', '##   verify  ')
      .replace('## Steps', '### Steps');
    const run = cli(
      fixture({ 'docs/runbooks/local-setup.md': `# Local setup\n\n${body}` })
    );
    expect(findingLines(run)).toEqual([
      'missing-section docs/runbooks/local-setup.md Steps',
    ]);
  });

  it('a heading inside a fenced block does not count', () => {
    const body = runbook(['Verify']) + '\n```md\n## Verify\n```\n';
    const run = cli(
      fixture({ 'docs/runbooks/local-setup.md': `# Local setup\n\n${body}` })
    );
    expect(findingLines(run)).toEqual([
      'missing-section docs/runbooks/local-setup.md Verify',
    ]);
  });
});

describe('docs:check index and entry point', () => {
  it('VT-09 TBI-034 DoD-3 TBI-033: index-missing, index-stale, and required-missing each name their path', () => {
    const files = baseFiles();
    const run = cli(
      fixture({
        'docs/testing.md': '# Testing\n',
        'AGENTS.md': `${files['AGENTS.md']}\n[Testing](docs/testing.md)\n`,
        'docs/agent-index.txt': `${files['docs/agent-index.txt']}docs/old.md  Removed\n`,
        'docs/docs-check.config.json': configWith({
          requiredDocuments: [
            ...baseConfig.requiredDocuments,
            'docs/runbooks/common-failures.md',
          ],
        }),
      })
    );
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual([
      'index-stale docs/agent-index.txt:6 docs/old.md',
      'required-missing docs/runbooks/common-failures.md',
      'index-missing docs/testing.md',
    ]);
  });

  it('VT-13 PBI-030 AC-0 TBI-033 DoD-0: a listed document that AGENTS.md does not link is entry-unlinked only', () => {
    const files = baseFiles();
    const run = cli(
      fixture({
        'docs/testing.md': '# Testing\n',
        'docs/agent-index.txt': `${files['docs/agent-index.txt']}docs/testing.md  Testing\n`,
      })
    );
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(['entry-unlinked docs/testing.md']);
  });

  it('TBI-033 DoD-0: the entry point must link the agent index', () => {
    const agents = baseFiles()['AGENTS.md'].replace(
      '- [Agent index](docs/agent-index.txt)\n',
      ''
    );
    const run = cli(fixture({ 'AGENTS.md': agents }));
    expect(findingLines(run)).toEqual(['entry-unlinked docs/agent-index.txt']);
  });

  it('ignores comments and blank lines in the index', () => {
    const files = baseFiles();
    const run = cli(
      fixture({
        'docs/agent-index.txt': `\n# comment docs/nothing.md\n\n${files['docs/agent-index.txt']}`,
      })
    );
    expect(run.status).toBe(0);
  });
});

describe('docs:check module map', () => {
  it('VT-03 PBI-030 AC-2 TBI-033 DoD-1: an unmapped member and an incomplete entry are reported', () => {
    const moduleMap = [
      '# Module map',
      '',
      '### `packages/ui`',
      '',
      '**Responsibility:** Design system.',
      '',
      '**Public interface:**',
      '',
    ].join('\n');
    const run = cli(
      fixture({
        'packages/new-mod/package.json': '{}\n',
        'packages/not-a-member/readme.txt': 'no package.json\n',
        'docs/module-map.md': moduleMap,
      })
    );
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual([
      'module-unmapped packages/new-mod',
      'module-incomplete packages/ui Public interface',
    ]);
  });

  it('reads literal workspace entries as well as dir/* entries', () => {
    const run = cli(
      fixture({
        'pnpm-workspace.yaml':
          'packages:\n  - "packages/*"\n  - tools/cli\n\ncatalog:\n  zod: 1.0.0\n',
        'tools/cli/package.json': '{}\n',
      })
    );
    expect(findingLines(run)).toEqual(['module-unmapped tools/cli']);
  });
});

describe('docs:check origin terms', () => {
  it('VT-04 PBI-030 AC-3 BR-008: a term in the body is reported and the origin section is exempt', () => {
    const architecture = [
      '# Architecture',
      '',
      'Copied from apex last year.',
      '',
      '## Template origin',
      '',
      'This template began inside Apex.',
      '',
      '### Detail',
      '',
      'Still part of the Apex origin note.',
      '',
      '## Next',
      '',
      'See .ai-pilot/notes for nothing.',
      '',
    ].join('\n');
    const run = cli(fixture({ 'docs/architecture.md': architecture }));
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual([
      'origin-term docs/architecture.md:3 Apex',
      'origin-term docs/architecture.md:15 ai-pilot',
    ]);
  });

  it('matches whole words only', () => {
    const architecture =
      '# Architecture\n\nThe apexes and Apexian words pass.\n';
    const run = cli(fixture({ 'docs/architecture.md': architecture }));
    expect(findingLines(run)).toEqual([]);
  });
});

describe('docs:check invocation errors', () => {
  it('VT-14 exits 2 when the config file is missing and names the file', () => {
    const run = cli(fixture({ 'docs/docs-check.config.json': null }));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('docs/docs-check.config.json');
    expect(run.stdout).toBe('');
  });

  it('VT-14 exits 2 when the config has no entryPoint and names the key', () => {
    const config = { ...baseConfig };
    delete config.entryPoint;
    const run = cli(
      fixture({
        'docs/docs-check.config.json': `${JSON.stringify(config)}\n`,
      })
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('entryPoint');
  });

  it('VT-14 exits 2 when the entry point file is absent and names it', () => {
    const run = cli(fixture({ 'AGENTS.md': null }));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('AGENTS.md');
  });

  it('exits 2 for invalid JSON, a missing index, an unreadable root, and an unknown flag', () => {
    const badJson = cli(fixture({ 'docs/docs-check.config.json': '{ nope' }));
    expect(badJson.status).toBe(2);
    expect(badJson.stderr).toContain('docs/docs-check.config.json');

    const noIndex = cli(fixture({ 'docs/agent-index.txt': null }));
    expect(noIndex.status).toBe(2);
    expect(noIndex.stderr).toContain('docs/agent-index.txt');

    const noRoot = cli(path.join(tmpdir(), 'docs-check-does-not-exist'));
    expect(noRoot.status).toBe(2);
    expect(noRoot.stderr).toContain('docs-check-does-not-exist');

    const flag = cli(fixture(), ['--colour']);
    expect(flag.status).toBe(2);
    expect(flag.stderr).toContain('--colour');
  });

  it('exits 2 when a config key has the wrong type', () => {
    const run = cli(
      fixture({ 'docs/docs-check.config.json': configWith({ documents: 'x' }) })
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('documents');
  });

  it('accepts --config relative to the working directory', () => {
    const root = fixture();
    const moved = path.join(root, 'elsewhere.json');
    renameSync(path.join(root, 'docs/docs-check.config.json'), moved);
    const run = cli(root, ['--config', moved]);
    expect(run.status).toBe(0);
  });

  it('runs its built-in self-test', () => {
    const result = spawnSync(process.execPath, [script, '--self-test'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('self-test passed');
  });
});

describe('docs:check output order', () => {
  it('sorts findings by document, then line, then rule', () => {
    const architecture = [
      '# Architecture',
      '',
      'Apex [gone](gone.md) `packages/gone/a.ts`',
      '',
    ].join('\n');
    const run = cli(fixture({ 'docs/architecture.md': architecture }));
    expect(findingLines(run)).toEqual([
      'broken-link docs/architecture.md:3 gone.md',
      'origin-term docs/architecture.md:3 Apex',
      'stale-path docs/architecture.md:3 packages/gone/a.ts',
    ]);
    expect(run.lines.at(-1)).toBe('docs:check: 3 problems in 4 documents');
  });
});

describe('docs:check on the committed knowledge base', () => {
  function copyKnowledgeBase() {
    const root = mkdtempSync(path.join(tmpdir(), 'docs-check-real-'));
    roots.push(root);
    for (const entry of [
      'AGENTS.md',
      'README.md',
      'docs',
      'pnpm-workspace.yaml',
    ]) {
      cpSync(path.join(templateRoot, entry), path.join(root, entry), {
        recursive: true,
      });
    }
    return root;
  }

  it('VT-01 mutation: renaming one referenced runbook adds findings that name only that runbook', () => {
    const baseline = cli(copyKnowledgeBase());
    const root = copyKnowledgeBase();
    renameSync(
      path.join(root, 'docs/runbooks/common-failures.md'),
      path.join(root, 'docs/runbooks/renamed-failures.md')
    );
    const mutated = cli(root);
    const before = new Set(findingLines(baseline));
    const added = findingLines(mutated).filter((line) => !before.has(line));
    expect(mutated.status).toBe(1);
    expect(added.length).toBeGreaterThan(0);
    expect(added).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^broken-link AGENTS\.md:\d+ docs\/runbooks\/common-failures\.md$/
        ),
      ])
    );
    for (const line of added) {
      expect(line).toMatch(/(common|renamed)-failures\.md/);
    }
  });
});
