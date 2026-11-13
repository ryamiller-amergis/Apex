import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SkillReplayError,
  buildReplayGenerationSpec,
  parseReplayThreadId,
  readReplayOutput,
  replayThreadId,
} from '../services/skillReplaySpec';

function original(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const skillContent = '# Current to-prd skill';
  return {
    workloadLane: 'document',
    prompt: 'Generate the PRD',
    model: 'claude-4',
    effort: null,
    skillPath: '.cursor/skills/to-prd/SKILL.md',
    skillContent,
    skillSha256: createHash('sha256').update(skillContent).digest('hex'),
    workflowClass: 'prd',
    projectId: 'Apex',
    threadId: 'thread-1',
    deadlineMs: 60 * 60_000,
    groundedSha: 'abc123',
    repository: 'apex',
    provider: 'ado',
    scratchInputs: [{ path: '.ai-pilot/kickoff-transcript.md', content: '# Transcript' }],
    ...overrides,
  };
}

describe('skill replay threads', () => {
  it('round-trips a run id and stage', () => {
    expect(parseReplayThreadId(replayThreadId('run-9', 'judge'))).toEqual({ runId: 'run-9', stage: 'judge' });
  });

  it('ignores ordinary and malformed thread ids', () => {
    expect(parseReplayThreadId('thread-1')).toBeNull();
    expect(parseReplayThreadId('skill-replay:run-9:other')).toBeNull();
    expect(parseReplayThreadId('skill-replay:run-9:judge:extra')).toBeNull();
  });
});

describe('buildReplayGenerationSpec', () => {
  it('swaps only the Skill and thread, keeping the frozen inputs', () => {
    const spec = buildReplayGenerationSpec(original(), {
      subjectType: 'prd',
      skillContent: '# Better skill',
      threadId: 'skill-replay:r1:generate',
    });
    expect(spec.skillContent).toBe('# Better skill');
    expect(spec.skillSha256).toBe(createHash('sha256').update('# Better skill').digest('hex'));
    expect(spec.threadId).toBe('skill-replay:r1:generate');
    expect(spec.prompt).toBe('Generate the PRD');
    expect(spec.groundedSha).toBe('abc123');
    expect(spec.scratchInputs).toEqual([{ path: '.ai-pilot/kickoff-transcript.md', content: '# Transcript' }]);
  });

  it('refuses a run of the wrong kind or an incomplete snapshot', () => {
    const input = { subjectType: 'design_doc' as const, skillContent: '# x', threadId: 't' };
    expect(() => buildReplayGenerationSpec(original(), input)).toThrow(SkillReplayError);
    expect(() => buildReplayGenerationSpec({ prompt: 'only' }, input)).toThrow(SkillReplayError);
  });

  it('refuses an empty Skill', () => {
    expect(() => buildReplayGenerationSpec(original(), { subjectType: 'prd', skillContent: '  ', threadId: 't' }))
      .toThrow(SkillReplayError);
  });
});

describe('readReplayOutput', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-replay-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a PRD and its backlog', async () => {
    await fs.writeFile(path.join(dir, 'feature.prd.md'), '# PRD');
    await fs.writeFile(path.join(dir, 'feature.backlog.json'), '{"epics":[]}');
    await expect(readReplayOutput('prd', dir)).resolves.toEqual({ kind: 'prd', markdown: '# PRD', backlog: { epics: [] } });
  });

  it('reads design doc files one folder deep', async () => {
    await fs.mkdir(path.join(dir, 'specs'));
    await fs.writeFile(path.join(dir, 'specs', 'login-design.md'), '# Design');
    await fs.writeFile(path.join(dir, 'specs', 'login-tech-spec.md'), '# Tech');
    await expect(readReplayOutput('design_doc', dir)).resolves.toEqual({
      kind: 'design_doc',
      designContent: '# Design',
      techSpecContent: '# Tech',
      assumptionsContent: '',
    });
  });

  it('returns null when the run wrote nothing usable', async () => {
    await expect(readReplayOutput('prd', dir)).resolves.toBeNull();
    await expect(readReplayOutput('design_doc', path.join(dir, 'missing'))).resolves.toBeNull();
  });
});
