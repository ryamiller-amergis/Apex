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

const { checkDocs, formatReport, loadConfig } =
  await import('./check-docs.mjs');

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
      '.cursor',
      'quality',
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

  it('VT-01 removing Inputs from the planner skill names that heading', () => {
    const root = copyKnowledgeBase();
    const skillPath = path.join(root, '.cursor/skills/planner/SKILL.md');
    const skill = readFileSync(skillPath, 'utf8').replace('## Inputs\n', '');
    writeFileSync(skillPath, skill);
    const run = cli(root);
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(
      expect.arrayContaining([
        'missing-section .cursor/skills/planner/SKILL.md Inputs',
      ])
    );
  });

  it('VT-04 an unknown id in the developer Gates column names the skill and the id', () => {
    const root = copyKnowledgeBase();
    const skillPath = path.join(root, '.cursor/skills/developer/SKILL.md');
    const skill = readFileSync(skillPath, 'utf8').replace(
      'openapi-drift',
      'not-a-gate'
    );
    writeFileSync(skillPath, skill);
    const run = cli(root);
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^role-gates \.cursor\/skills\/developer\/SKILL\.md:\d+ not-a-gate$/
        ),
      ])
    );
  });
});

const SKILL_HEADINGS = [
  'When to use',
  'Required references',
  'Rules',
  'Review checklist',
  'Stop conditions',
];

function skillDocument(ruleRows) {
  const table = [
    '| ID | Rule | Enforced by |',
    '| --- | --- | --- |',
    ...ruleRows,
  ].join('\n');
  return [
    '# Skill',
    '',
    ...SKILL_HEADINGS.flatMap((heading) => [
      `## ${heading}`,
      '',
      heading === 'Rules' ? table : 'Text.',
      '',
    ]),
  ].join('\n');
}

function skillFixture(
  skillBody,
  { indexLine = true, manifestGates = ['openapi-drift', 'lint'] } = {}
) {
  const agents = baseFiles()['AGENTS.md'].replace(
    'None yet.',
    'None yet.\n\n- [API contract](.cursor/skills/api-contract/SKILL.md)'
  );
  const index = [
    baseFiles()['docs/agent-index.txt'].trimEnd(),
    indexLine ? '.cursor/skills/api-contract/SKILL.md  API contract skill' : '',
    '',
  ].join('\n');
  return fixture({
    'docs/docs-check.config.json': configWith({
      documents: ['AGENTS.md', 'docs/**/*.md', '.cursor/skills/**/SKILL.md'],
      requiredSections: [
        ...baseConfig.requiredSections,
        {
          match: '.cursor/skills/**/SKILL.md',
          headings: SKILL_HEADINGS,
        },
      ],
    }),
    'AGENTS.md': agents,
    'docs/agent-index.txt': index,
    '.cursor/skills/api-contract/SKILL.md': skillBody,
    'quality/quality-manifest.json': `${JSON.stringify({
      gates: manifestGates.map((id) => ({ id })),
    })}\n`,
  });
}

describe('docs:check skill rule table', () => {
  it('VT-03 a skill whose Enforced by cells are gate ids or Review exits 0', () => {
    const root = skillFixture(
      skillDocument([
        '| API-R01 | Declare the route. | openapi-drift |',
        '| API-R02 | Review the name. | Review |',
      ])
    );
    const run = cli(root);
    expect(run.status).toBe(0);
    expect(findingLines(run)).toEqual([]);
  });

  it('VT-03 a blank Enforced by cell and an unknown gate name the skill and rule id', () => {
    const root = skillFixture(
      skillDocument([
        '| API-R01 | Declare the route. |  |',
        '| API-R02 | Name a missing gate. | not-a-gate |',
      ])
    );
    const run = cli(root);
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^rule-table \.cursor\/skills\/api-contract\/SKILL\.md:\d+ API-R01$/
        ),
        expect.stringMatching(
          /^rule-table \.cursor\/skills\/api-contract\/SKILL\.md:\d+ API-R02$/
        ),
      ])
    );
  });

  it('VT-02 removing a skill from the agent index names that skill', () => {
    const root = skillFixture(
      skillDocument(['| API-R01 | Declare the route. | Review |']),
      { indexLine: false, manifestGates: [] }
    );
    const run = cli(root);
    expect(run.status).toBe(1);
    expect(findingLines(run)).toContain(
      'index-missing .cursor/skills/api-contract/SKILL.md'
    );
  });

  it('VT-04 a renamed path cited by a skill names the skill and the path', () => {
    const body = skillDocument([
      '| API-R01 | Declare the route. | Review |',
    ]).replace('Text.', 'See `docs/missing-reference.md`.');
    const root = skillFixture(body, { manifestGates: [] });
    const run = cli(root);
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^stale-path \.cursor\/skills\/api-contract\/SKILL\.md:\d+ docs\/missing-reference\.md$/
        ),
      ])
    );
  });
});

describe('docs:check role skill gate column', () => {
  function roleGateFixture(gatesCell, manifestGates = ['build', 'type-check']) {
    const agents = baseFiles()['AGENTS.md'].replace(
      'None yet.',
      'None yet.\n\n- [Planner](.cursor/skills/planner/SKILL.md)'
    );
    const index = [
      baseFiles()['docs/agent-index.txt'].trimEnd(),
      '.cursor/skills/planner/SKILL.md  Planner skill',
      '',
    ].join('\n');
    const body = [
      '# Planner',
      '',
      '## Rules',
      '',
      '| ID | Rule | Enforced by |',
      '| --- | --- | --- |',
      '| PLN-R01 | Read the manifest. | Review |',
      '',
      '| Change | Gates |',
      '| --- | --- |',
      `| Endpoint | ${gatesCell} |`,
      '',
    ].join('\n');
    return fixture({
      'docs/docs-check.config.json': configWith({
        documents: ['AGENTS.md', 'docs/**/*.md', '.cursor/skills/**/SKILL.md'],
        requiredSections: [
          ...baseConfig.requiredSections,
          {
            match: '.cursor/skills/**/SKILL.md',
            headings: ['Rules'],
          },
        ],
      }),
      'AGENTS.md': agents,
      'docs/agent-index.txt': index,
      '.cursor/skills/planner/SKILL.md': body,
      'quality/quality-manifest.json': `${JSON.stringify({
        gates: manifestGates.map((id) => ({ id })),
      })}\n`,
    });
  }

  it('VT-04 known gate ids in a Gates column exit 0', () => {
    const run = cli(roleGateFixture('build, type-check'));
    expect(run.status).toBe(0);
    expect(findingLines(run)).toEqual([]);
  });

  it('VT-04 an unknown gate id in a Gates column names the skill and the id', () => {
    const run = cli(roleGateFixture('build, not-a-gate'));
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^role-gates \.cursor\/skills\/planner\/SKILL\.md:\d+ not-a-gate$/
        ),
      ])
    );
  });
});

describe('committed api-contract and ui-standards skills', () => {
  const skillPaths = [
    '.cursor/skills/api-contract/SKILL.md',
    '.cursor/skills/ui-standards/SKILL.md',
  ];

  function readSkill(relative) {
    return readFileSync(path.join(templateRoot, relative), 'utf8');
  }

  it('VT-01 TBI-035 DoD-3 TBI-036 DoD-3 both skills pass docs:check and are linked', () => {
    const config = loadConfig(templateRoot);
    const result = checkDocs({ root: templateRoot, config });
    expect(result.findings).toEqual([]);
    expect(result.documentCount).toBe(30);
    const agents = readSkill('AGENTS.md');
    const index = readSkill('docs/agent-index.txt');
    for (const skillPath of skillPaths) {
      expect(agents).toContain(`](${skillPath})`);
      expect(index).toContain(skillPath);
    }
  });

  it('TBI-035 DoD-0 DoD-1 DoD-2 the api-contract skill lists rules, steps, and the profile identifier ban', () => {
    const skill = readSkill('.cursor/skills/api-contract/SKILL.md');
    expect(skill).toMatch(/^## Adding an endpoint$/m);
    for (let index = 1; index <= 15; index += 1) {
      expect(skill).toContain(`API-R${String(index).padStart(2, '0')}`);
    }
    expect(skill).toMatch(/Enforced by/);
    expect(skill).toMatch(/pnpm routes:check/);
    expect(skill).toMatch(/is registered but has no contract/);
    expect(skill).toMatch(/default(?:s)? to 20/);
    expect(skill).toMatch(/100/);
    expect(skill).toMatch(/400 Problem Details/);
    expect(skill).toMatch(/another person's identifier/);
    expect(skill).toMatch(/z\.strictObject/);
    expect(skill).toMatch(/stack trace/);
    expect(skill).toMatch(/pnpm test:contract/);
    expect(skill).toMatch(/pnpm openapi:generate/);
  });

  it('TBI-036 DoD-0 DoD-1 DoD-2 PBI-034 the ui-standards skill lists rules, screen steps, and the profile patterns', () => {
    const skill = readSkill('.cursor/skills/ui-standards/SKILL.md');
    expect(skill).toMatch(/^## Adding a screen$/m);
    for (let index = 1; index <= 12; index += 1) {
      expect(skill).toContain(`UI-R${String(index).padStart(2, '0')}`);
    }
    expect(skill).toMatch(/profileTestIds/);
    expect(skill).toMatch(/updateProfileBodySchema/);
    expect(skill).toMatch(/useUpdateProfileMutation/);
    expect(skill).toMatch(/invalidate/);
    expect(skill).toMatch(/createAppQueryClient/);
    expect(skill).toMatch(/design-tokens\/no-hardcoded-color/);
    expect(skill).toMatch(/loading, empty, error, and loaded/i);
    expect(skill).toMatch(/unlabeled field/);
    expect(skill).toMatch(/hard-coded colour/);
    expect(skill).toMatch(/catalog addition or replacement/);
    expect(skill).toMatch(/missing empty or error state is a failure/i);
    expect(skill).toMatch(/narrowest supported width/);
    expect(skill).toMatch(/widest/);
    expect(skill).toMatch(/focus order/);
    expect(skill).toMatch(/below 600 px/);
    expect(skill).toMatch(/1536 px/);
  });

  it('VT-18 skill files do not name the host product, a real identity, or host auth helpers', () => {
    const banned = [
      /Apex/i,
      /Amergis/i,
      /ai-pilot/i,
      /ensureAuthenticated/,
      /@[A-Za-z0-9._%+-]+\.[A-Za-z]{2,}/,
    ];
    for (const skillPath of skillPaths) {
      const skill = readSkill(skillPath);
      for (const pattern of banned) {
        expect(skill).not.toMatch(pattern);
      }
    }
  });
});

describe('committed role skills', () => {
  const roleSkills = [
    '.cursor/skills/orchestrator/SKILL.md',
    '.cursor/skills/planner/SKILL.md',
    '.cursor/skills/ui/SKILL.md',
    '.cursor/skills/developer/SKILL.md',
    '.cursor/skills/qa/SKILL.md',
    '.cursor/skills/integration/SKILL.md',
  ];

  function readSkill(relative) {
    return readFileSync(path.join(templateRoot, relative), 'utf8');
  }

  it('VT-02 TBI-037 to TBI-041 DoD-3 each role skill is linked from the entry point and the index', () => {
    const agents = readSkill('AGENTS.md');
    const index = readSkill('docs/agent-index.txt');
    for (const skillPath of roleSkills) {
      expect(agents).toContain(`](${skillPath})`);
      expect(index).toContain(skillPath);
    }
    expect(agents).toContain('](docs/handoff.md)');
    expect(index).toContain('docs/handoff.md');
  });

  it('VT-06 TBI-037 DoD-0 DoD-1 DoD-2 PBI-036 the planner skill states inputs, gates, NFR evidence, and stop conditions', () => {
    const skill = readSkill('.cursor/skills/planner/SKILL.md');
    expect(skill).toMatch(/^name: planner$/m);
    expect(skill).toMatch(/^## Inputs$/m);
    expect(skill).toMatch(/^## Outputs$/m);
    expect(skill).toMatch(/^## Stop conditions$/m);
    expect(skill).toMatch(/applicable gates/i);
    expect(skill).toContain('quality/quality-manifest.json');
    expect(skill).toMatch(/NFR evidence/);
    expect(skill).toContain('quality/nfr-manifest.json');
    expect(skill).toMatch(/real targets are missing/);
    expect(skill).toMatch(/illustrative/);
    expect(skill).toMatch(/Excluded work/);
    expect(skill).toMatch(/owned by Platform Engineering/);
    expect(skill).toMatch(/do not invent a role model/i);
    expect(skill).toContain(
      'docs/adr/0002-no-roles-or-permissions-in-the-template.md'
    );
    expect(skill).toMatch(/produces no plan|Produce no plan/);
    expect(skill).toMatch(/handoff document is not linked from AGENTS.md/);
    expect(skill).not.toMatch(/@[A-Za-z0-9._%+-]+\.[A-Za-z]{2,}/);
  });

  it('VT-10 TBI-038 DoD-0 DoD-1 DoD-2 PBI-039 the UI role skill reads UI standards first and requires state evidence', () => {
    const skill = readSkill('.cursor/skills/ui/SKILL.md');
    expect(skill).toMatch(/^name: ui$/m);
    expect(skill).toMatch(/^## Inputs$/m);
    expect(skill).toMatch(/^## Outputs$/m);
    expect(skill).toMatch(/^## Stop conditions$/m);
    expect(skill).toMatch(/Read the UI standards skill first/);
    expect(skill).toContain('.cursor/skills/ui-standards/SKILL.md');
    expect(skill).toContain('docs/design-system.md');
    expect(skill).toContain('docs/component-catalog.md');
    expect(skill).toMatch(/Catalog components reused/);
    expect(skill).toMatch(/Theme tokens used/);
    expect(skill).toMatch(/loading, empty, error, and loaded/);
    expect(skill).toMatch(/accessibility test/i);
    expect(skill).toMatch(/catalog addition/);
    expect(skill).toMatch(/one-off styled component/);
    expect(skill).toMatch(/do not report the screen as done/i);
    expect(skill).toMatch(/Name the state/);
    expect(skill).toMatch(/missing reference/i);
  });

  it('VT-07 TBI-039 DoD-0 DoD-1 DoD-2 PBI-035 the developer skill loads the right skills and stops on a missing reference', () => {
    const skill = readSkill('.cursor/skills/developer/SKILL.md');
    expect(skill).toMatch(/^name: developer$/m);
    expect(skill).toMatch(/before any code is written/);
    expect(skill).toContain('.cursor/skills/api-contract/SKILL.md');
    expect(skill).toContain('.cursor/skills/ui-standards/SKILL.md');
    expect(skill).toMatch(
      /does not require the API contract skill or the UI standards skill/
    );
    expect(skill).toMatch(/applicable quality gates|applicable gates/i);
    expect(skill).toMatch(
      /stop and report the missing reference instead of guessing/i
    );
    expect(skill).toMatch(/reviewed SQL migration/);
    expect(skill).toContain('migration-validation');
    expect(skill).toMatch(/hard-coded secret/);
    expect(skill).toMatch(/synthetic value or an environment variable/);
    expect(skill).toMatch(/^## Stop conditions$/m);
  });

  it('VT-08 TBI-040 DoD-0 DoD-1 DoD-2 PBI-037 the QA skill reports evidence and does not treat a deferral as passed', () => {
    const skill = readSkill('.cursor/skills/qa/SKILL.md');
    expect(skill).toMatch(/^name: qa$/m);
    expect(skill).toMatch(/^## Inputs$/m);
    expect(skill).toMatch(/^## Outputs$/m);
    expect(skill).toMatch(/^## Stop conditions$/m);
    expect(skill).toContain('quality/quality-manifest.json');
    expect(skill).toContain('quality/nfr-manifest.json');
    expect(skill).toMatch(/passed, failed, not verified, or manifest error/);
    expect(skill).toMatch(/not verified/);
    expect(skill).toMatch(/reason and the owner|Reason and owner/);
    expect(skill).toMatch(/Never record it as passed/);
    expect(skill).toMatch(
      /verdict is verified only when every gate is passed|The verdict is `verified` only when every gate is `passed`/
    );
    expect(skill).toMatch(/manifest error/);
    expect(skill).toMatch(/no target supplied/);
    expect(skill).toMatch(/illustrative/);
    expect(skill).not.toMatch(/@[A-Za-z0-9._%+-]+\.[A-Za-z]{2,}/);
  });

  it('VT-09 TBI-041 DoD-0 DoD-1 DoD-2 PBI-038 the integration skill reports ready only with evidence', () => {
    const skill = readSkill('.cursor/skills/integration/SKILL.md');
    expect(skill).toMatch(/^name: integration$/m);
    expect(skill).toMatch(/^## Inputs$/m);
    expect(skill).toMatch(/^## Outputs$/m);
    expect(skill).toMatch(/^## Stop conditions$/m);
    expect(skill).toMatch(/ready/);
    expect(skill).toMatch(/not ready/);
    expect(skill).toMatch(/deferr/);
    expect(skill).toMatch(/no evidence/);
    expect(skill).toMatch(
      /Do not claim readiness when any required gate lacks evidence/
    );
    expect(skill).toContain('AUTH_MODE');
    expect(skill).toContain('NODE_ENV');
    expect(skill).toMatch(/development adapter/);
    expect(skill).toContain(
      'docs/adr/0002-no-roles-or-permissions-in-the-template.md'
    );
    expect(skill).toMatch(/handoff document is not linked from AGENTS.md/);
    expect(skill).toMatch(/Do not invent a handoff path/);
    expect(skill).toMatch(/Do not run the pipeline/);
    expect(skill).toMatch(/do not deploy/i);
    expect(skill).not.toMatch(/@[A-Za-z0-9._%+-]+\.[A-Za-z]{2,}/);
  });

  it('the orchestrator skill asks the recorded questions and shows the integration verdict', () => {
    const skill = readSkill('.cursor/skills/orchestrator/SKILL.md');
    const questions = readSkill('docs/plans/README.md');
    expect(skill).toMatch(/^name: orchestrator$/m);
    expect(skill).toContain('docs/plans/README.md');
    expect(skill).toContain('docs/feature-slices.md');
    expect(skill).toContain('quality/evidence/README.md');
    expect(skill).toMatch(/approv/i);
    expect(skill).toMatch(/readiness report/i);
    expect(questions).toMatch(
      /Stay on the caller's own data, or pause until an authorization model is decided\?/
    );
    expect(questions).toMatch(
      /Keep the development adapter for local runs, or pause until a production identity provider is chosen\?/
    );
    expect(questions).toMatch(
      /Supply real targets, or leave load-test evidence out of this plan\?/
    );
    expect(skill).not.toMatch(/@[A-Za-z0-9._%+-]+\.[A-Za-z]{2,}/);
  });
});

const {
  HANDOFF_DOCUMENT,
  readEnvExampleKeys,
  parseEndpointIdentifier,
  openApiHasOperation,
  resolveHandoffContract,
} = await import('./handoff-check.mjs');

const HANDOFF_HEADINGS = [
  'What the Template Provides',
  'Ownership',
  'Contracts Platform Engineering Consumes',
  'Replacement Placeholders',
  'Unresolved Decision Register',
];

function minimalHandoffFixture(overrides = {}) {
  const ownership = [
    '| Area | Owner | What the template ships | What Platform Engineering does |',
    '| --- | --- | --- | --- |',
    '| AWS infrastructure | Platform Engineering | None | Owns cloud |',
    '| CI/CD pipelines | Platform Engineering | Scripts only | Owns pipelines |',
    '| Migration execution | Platform Engineering | Migrations | Runs in deploy |',
    '| Deployment packaging — container definition | Template | Dockerfile | Consumes image |',
    '| Deployment packaging — image publishing and deployment stages | Platform Engineering | None | Publishes |',
    '| Repository governance | Platform Engineering | None | Adds governance |',
  ].join('\n');
  const contracts = [
    '| Kind | Identifier | Purpose | Source in the template |',
    '| --- | --- | --- | --- |',
    '| script | setup | Install | package.json |',
    '| manifest | quality/quality-manifest.json | Gates | quality/ |',
    '| endpoint | GET /health/live | Live | OpenAPI |',
    '| env | NODE_ENV | Env | .env.example |',
    '| container | Dockerfile | Image | root |',
  ].join('\n');
  const placeholders = [
    '| Placeholder | Meaning | Where it appears |',
    '| --- | --- | --- |',
    '| project-name | Name | README |',
    '| @project-scope | Scope | package.json |',
    '| project-service | Service | README |',
    '| project_db | Database | compose.yaml |',
  ].join('\n');
  const register = [
    '| Decision | Extension point | Template behavior until decided | Decision needed from Platform Engineering |',
    '| --- | --- | --- | --- |',
    '| Production identity provider | `apps/api/src/identity/adapter.ts` | Dev adapter | Choose IdP |',
    '| RBAC | `apps/api/src/identity/authMiddleware.ts` | Auth only | Define RBAC |',
    '| Data classification | `apps/api/src/persistence/schema.ts` | Unresolved classification; synthetic fixtures and identity redaction are engineering practice, not a classification | Assign level |',
    '| NFR targets and test execution policy | `quality/nfr-manifest.json` | Illustrative targets | Set policy |',
    '| Feature-flag provider | `apps/api/src/feature-flags/flag-evaluator.ts` | Local map | Choose provider |',
  ].join('\n');
  const handoff = [
    '# Handoff',
    '',
    ...HANDOFF_HEADINGS.flatMap((heading) => {
      if (heading === 'Ownership') {
        return [`## ${heading}`, '', ownership, ''];
      }
      if (heading === 'Contracts Platform Engineering Consumes') {
        return [`## ${heading}`, '', contracts, ''];
      }
      if (heading === 'Replacement Placeholders') {
        return [`## ${heading}`, '', placeholders, ''];
      }
      if (heading === 'Unresolved Decision Register') {
        return [`## ${heading}`, '', register, ''];
      }
      return [`## ${heading}`, '', 'Bullets.', ''];
    }),
  ].join('\n');
  return fixture({
    'docs/handoff.md': handoff,
    'package.json': '{"scripts":{"setup":"x"}}\n',
    '.env.example': 'NODE_ENV=development\n',
    'quality/quality-manifest.json': '{"gates":[]}\n',
    Dockerfile: 'FROM scratch\n',
    'packages/contracts/openapi/openapi.json':
      '{"paths":{"/health/live":{"get":{}}}}\n',
    'apps/api/src/identity/adapter.ts': 'export {}\n',
    'apps/api/src/identity/authMiddleware.ts': 'export {}\n',
    'apps/api/src/persistence/schema.ts': 'export {}\n',
    'apps/api/src/feature-flags/flag-evaluator.ts': 'export {}\n',
    'quality/nfr-manifest.json': '{}\n',
    'docs/docs-check.config.json': configWith({
      documents: ['AGENTS.md', 'docs/**/*.md'],
      requiredDocuments: [...baseConfig.requiredDocuments, 'docs/handoff.md'],
      requiredSections: [
        ...baseConfig.requiredSections,
        { match: 'docs/handoff.md', headings: HANDOFF_HEADINGS },
      ],
    }),
    'docs/agent-index.txt': `${baseFiles()['docs/agent-index.txt'].trimEnd()}\ndocs/handoff.md  Handoff\n`,
    'AGENTS.md': `${baseFiles()['AGENTS.md']}\n[Handoff](docs/handoff.md)\n`,
    ...overrides,
  });
}

describe('handoff contract resolver', () => {
  it('VT-04 resolves each contract kind and rejects a missing script', () => {
    const fsView = {
      exists: (path) =>
        path === 'Dockerfile' || path === 'quality/quality-manifest.json',
    };
    const ctx = {
      fsView,
      scripts: { setup: 'x' },
      envKeys: new Set(['NODE_ENV']),
      openApi: { paths: { '/health/live': { get: {} } } },
    };
    expect(
      resolveHandoffContract({ kind: 'script', identifier: 'setup', ...ctx })
    ).toBe(true);
    expect(
      resolveHandoffContract({
        kind: 'script',
        identifier: 'no-such-script',
        ...ctx,
      })
    ).toBe(false);
    expect(
      resolveHandoffContract({
        kind: 'manifest',
        identifier: 'quality/quality-manifest.json',
        ...ctx,
      })
    ).toBe(true);
    expect(
      resolveHandoffContract({
        kind: 'container',
        identifier: 'Dockerfile',
        ...ctx,
      })
    ).toBe(true);
    expect(
      resolveHandoffContract({ kind: 'env', identifier: 'NODE_ENV', ...ctx })
    ).toBe(true);
    const parsed = parseEndpointIdentifier('GET /health/live');
    expect(parsed).toEqual({ method: 'GET', path: '/health/live' });
    expect(openApiHasOperation(ctx.openApi, parsed.method, parsed.path)).toBe(
      true
    );
  });

  it('readEnvExampleKeys ignores comments and blank lines', () => {
    const keys = readEnvExampleKeys(
      '# comment\n\nPORT=1\nAUTH_MODE=development\n'
    );
    expect(keys).toEqual(new Set(['PORT', 'AUTH_MODE']));
  });
});

describe('docs:check handoff fixtures', () => {
  it('VT-01 VT-04 VT-07 VT-08 VT-09 a minimal handoff fixture exits 0', () => {
    const run = cli(minimalHandoffFixture());
    expect(run.status).toBe(0);
    expect(findingLines(run)).toEqual([]);
  });

  it('VT-05 PBI-040 (b): a stale script identifier is reported', () => {
    const root = minimalHandoffFixture();
    const handoff = readFileSync(
      path.join(root, HANDOFF_DOCUMENT),
      'utf8'
    ).replace('| script | setup |', '| script | no-such-script |');
    writeFileSync(path.join(root, HANDOFF_DOCUMENT), handoff);
    const run = cli(root);
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^handoff-contract docs\/handoff\.md:\d+ no-such-script$/
        ),
      ])
    );
  });

  it('VT-06 PBI-040 (d): empty and invalid owners are reported', () => {
    const root = minimalHandoffFixture();
    let handoff = readFileSync(path.join(root, HANDOFF_DOCUMENT), 'utf8');
    handoff = handoff.replace(
      '| AWS infrastructure | Platform Engineering |',
      '| AWS infrastructure |  |'
    );
    handoff = handoff.replace(
      '| CI/CD pipelines | Platform Engineering |',
      '| CI/CD pipelines | Someone |'
    );
    writeFileSync(path.join(root, HANDOFF_DOCUMENT), handoff);
    const run = cli(root);
    expect(run.status).toBe(1);
    const lines = findingLines(run).filter((line) =>
      line.startsWith('handoff-owner')
    );
    expect(lines.length).toBe(2);
  });

  it('VT-10 PBI-041 (b): a missing extension-point file is reported', () => {
    const root = minimalHandoffFixture();
    const handoff = readFileSync(
      path.join(root, HANDOFF_DOCUMENT),
      'utf8'
    ).replace(
      '`apps/api/src/identity/adapter.ts`',
      '`apps/api/src/identity/missing.ts`'
    );
    writeFileSync(path.join(root, HANDOFF_DOCUMENT), handoff);
    const run = cli(root);
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^handoff-extension docs\/handoff\.md:\d+/),
      ])
    );
  });

  it('VT-11 PBI-041 (d): an empty extension point is reported', () => {
    const root = minimalHandoffFixture();
    const handoff = readFileSync(
      path.join(root, HANDOFF_DOCUMENT),
      'utf8'
    ).replace(
      '| RBAC | `apps/api/src/identity/authMiddleware.ts` |',
      '| RBAC |  |'
    );
    writeFileSync(path.join(root, HANDOFF_DOCUMENT), handoff);
    const run = cli(root);
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^handoff-register docs\/handoff\.md:\d+ RBAC$/),
      ])
    );
  });

  it('VT-12 PBI-040 security NFR: a disallowed absolute host is reported', () => {
    const root = minimalHandoffFixture();
    const handoff = readFileSync(
      path.join(root, HANDOFF_DOCUMENT),
      'utf8'
    ).replace('Bullets.', 'See https://git.internal.corp/x for nothing.');
    writeFileSync(path.join(root, HANDOFF_DOCUMENT), handoff);
    const run = cli(root);
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^handoff-url docs\/handoff\.md:\d+ git\.internal\.corp$/
        ),
      ])
    );
  });

  it('VT-14 PBI-040 (b): a missing required heading is reported', () => {
    const root = minimalHandoffFixture();
    const handoff = readFileSync(
      path.join(root, HANDOFF_DOCUMENT),
      'utf8'
    ).replace('## Ownership', '## Owns');
    writeFileSync(path.join(root, HANDOFF_DOCUMENT), handoff);
    const run = cli(root);
    expect(run.status).toBe(1);
    expect(findingLines(run)).toEqual(
      expect.arrayContaining(['missing-section docs/handoff.md Ownership'])
    );
  });
});

describe('committed handoff document', () => {
  it('VT-02 VT-03 VT-04 VT-07 VT-08 VT-09 the real handoff matches README placeholders and passes docs:check', () => {
    const config = loadConfig(templateRoot);
    const result = checkDocs({ root: templateRoot, config });
    expect(result.findings).toEqual([]);
    const handoff = readFileSync(
      path.join(templateRoot, HANDOFF_DOCUMENT),
      'utf8'
    );
    const readme = readFileSync(path.join(templateRoot, 'README.md'), 'utf8');
    for (const token of [
      'project-name',
      '@project-scope',
      'project-service',
      'project_db',
    ]) {
      expect(handoff).toContain(token);
      expect(readme).toContain(token);
    }
    for (const area of [
      'AWS infrastructure',
      'CI/CD pipelines',
      'Migration execution',
      'Deployment packaging',
      'Repository governance',
    ]) {
      expect(handoff).toContain(area);
    }
    for (const decision of [
      'Production identity provider',
      'RBAC',
      'Data classification',
      'NFR targets and test execution policy',
      'Feature-flag provider',
    ]) {
      expect(handoff).toContain(decision);
    }
    expect(handoff).toMatch(
      /synthetic fixtures and identity redaction.*engineering practice, not a data classification/i
    );
    expect(handoff).not.toMatch(/classified as/i);
  });
});
