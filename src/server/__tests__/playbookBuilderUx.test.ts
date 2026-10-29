jest.mock('../services/chatAgentService', () => ({ getThread: jest.fn() }));
jest.mock('../services/playbookRunProjectionService', () => ({ getRun: jest.fn() }));

import { recommendPlaybookSteps } from '../services/playbookRecommenderService';
import { ancestorsNearestFirst } from '../services/playbookSteps/cloudAgentAdapter';
import { describePlaybookSkill } from '../services/playbookSkillCatalogService';
import { threadActivityEntries } from '../services/playbookStepActivityService';
import { getStepTypeDescriptor } from '../services/playbookSteps/registry';

describe('recommendPlaybookSteps', () => {
  it('orders steps as the goal names them and puts an approval before work that leaves Apex', () => {
    const plan = recommendPlaybookSteps('Investigate production errors, file a bug, and fix it');
    expect(plan.kind).toBe('suggestions');
    if (plan.kind !== 'suggestions') return;
    expect(plan.suggestions.map((item) => item.stepType)).toEqual([
      'cursor-agent',
      'approval-gate',
      'apex-action',
      'cloud-agent',
    ]);
    for (const suggestion of plan.suggestions) {
      expect(getStepTypeDescriptor(suggestion.stepType).inputSchema.safeParse(suggestion.config).success)
        .toBe(true);
    }
  });

  it('returns a gap with examples when nothing fits', () => {
    const plan = recommendPlaybookSteps('xyzzy');
    expect(plan.kind).toBe('gap');
  });
});

describe('cloud-agent input', () => {
  it('accepts a step with no work item fields so it can infer them', () => {
    expect(getStepTypeDescriptor('cloud-agent').inputSchema.safeParse({}).success).toBe(true);
  });

  it('walks earlier steps nearest first, past an approval', () => {
    const graph = {
      nodes: [
        { id: 'scan', stepType: 'cursor-agent' },
        { id: 'approve', stepType: 'approval-gate' },
        { id: 'file', stepType: 'apex-action' },
        { id: 'fix', stepType: 'cloud-agent' },
      ],
      edges: [
        { from: 'scan', to: 'approve' },
        { from: 'approve', to: 'file' },
        { from: 'file', to: 'fix' },
      ],
    };
    expect(ancestorsNearestFirst(graph, 'fix')).toEqual(['file', 'approve', 'scan']);
    expect(ancestorsNearestFirst(graph, 'fix#2')).toEqual(['file', 'approve', 'scan']);
  });
});

describe('describePlaybookSkill', () => {
  it('reads name, folded description, and capabilities', () => {
    const skill = describePlaybookSkill(
      '.cursor/skills/scan/SKILL.md',
      '---\nname: scan\ndescription: >\n  Looks for\n  problems.\nplaybook-capabilities: [repository-read]\n---\nBody',
    );
    expect(skill).toEqual({
      path: '.cursor/skills/scan/SKILL.md',
      name: 'scan',
      description: 'Looks for problems.',
      capabilities: ['repository-read'],
      runnable: true,
    });
  });

  it('marks a Skill without playbook-capabilities as not runnable', () => {
    const skill = describePlaybookSkill('.cursor/skills/x/SKILL.md', '---\nname: x\ndescription: Y\n---\n');
    expect(skill.runnable).toBe(false);
    expect(skill.unavailableReason).toMatch(/playbook-capabilities/);
  });
});

describe('threadActivityEntries', () => {
  it('turns thread messages into log lines and skips hidden prompts', () => {
    const entries = threadActivityEntries([
      { id: '1', role: 'user', text: 'Skill body', ts: 't0', hidden: true },
      { id: '2', role: 'user', text: 'Scan the logs', ts: 't1' },
      { id: '3', role: 'tool', text: '→ read', toolName: 'read', toolInput: { path: 'a.ts' }, ts: 't2' },
      { id: '4', role: 'agent', text: 'Hmm', toolName: '_reasoning', ts: 't3' },
      { id: '5', role: 'agent', text: 'Found two errors.', ts: 't4' },
    ]);
    expect(entries.map((entry) => [entry.kind, entry.title, entry.detail])).toEqual([
      ['prompt', 'Prompt', 'Scan the logs'],
      ['tool', 'read', 'a.ts'],
      ['thinking', 'Thinking', 'Hmm'],
      ['message', 'Agent', 'Found two errors.'],
    ]);
  });
});
