/**
 * Pure rules for the Agent task's two modes: how a Skill selects one, what each mode requires of
 * the node at publish, which deadlines each allows, and how a parked row is told apart.
 */
jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  agentTaskModeOfSkill,
  agentTaskOutputKind,
  assertAgentTaskConfigForMode,
  assertAgentTasksFitTheirSkills,
} from '../services/playbookAgentTaskMode';
import { PlaybookGraphNodeRuleError } from '../services/playbookGuardService';
import {
  getStepTypeDescriptor,
  isInteractiveAgentTaskRow,
  resolveDeadlineMs,
  suspendReasonForStep,
  suspendReasonForStepType,
} from '../services/playbookSteps/registry';
import { agentTaskModeForSkillType, isInteractiveTaskDraft } from '../../shared/utils/playbookAgentTask';
import { declaredSkillType } from '../services/playbookSkillFrontmatter';
import type { PlaybookGraph } from '../../shared/types/playbook';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const skill = (metadata: string) =>
  `---\nname: s\ndescription: d\n${metadata ? `metadata:\n  apex:\n${metadata}` : ''}---\nBody`;

const draft = { threadId: 't-1', assigneeUserId: 'u-1' };

describe('how a Skill selects the mode', () => {
  it('chats only when the Skill declares interactive', () => {
    expect(agentTaskModeOfSkill(skill('    skill-type: interactive\n'))).toBe('interactive');
    expect(agentTaskModeOfSkill(skill('    skill-type: autonomous\n'))).toBe('autonomous');
  });

  it('runs on its own when the Skill declares nothing', () => {
    expect(agentTaskModeOfSkill(skill(''))).toBe('autonomous');
    expect(agentTaskModeForSkillType(null)).toBe('autonomous');
    expect(agentTaskModeForSkillType(undefined)).toBe('autonomous');
  });

  it('runs on its own when the frontmatter is missing or invalid', () => {
    expect(agentTaskModeOfSkill('# no frontmatter')).toBe('autonomous');
    expect(agentTaskModeOfSkill('---\nname: [unclosed\n---\n')).toBe('autonomous');
    expect(agentTaskModeOfSkill(skill('    skill-type: sideways\n'))).toBe('autonomous');
  });

  it('reads the declared type and output kind', () => {
    const text = skill('    skill-type: interactive\n    output-kind: scorecard@1\n');
    expect(declaredSkillType(text)).toBe('interactive');
    expect(agentTaskOutputKind(text)).toBe('scorecard@1');
    expect(declaredSkillType('# nothing')).toBeNull();
    expect(agentTaskOutputKind('# nothing')).toBeNull();
  });
});

describe('what each mode requires of the node at publish', () => {
  it('requires an assignee for an interactive task', () => {
    expect(() => assertAgentTaskConfigForMode('review', { prompt: 'p' }, 'interactive')).toThrow(
      PlaybookGraphNodeRuleError,
    );
    expect(() => assertAgentTaskConfigForMode('review', { assigneeEmail: '  ' }, 'interactive')).toThrow(
      /needs an assignee/,
    );
    expect(() => assertAgentTaskConfigForMode('review', undefined, 'interactive')).toThrow(/needs an assignee/);
  });

  it('accepts either assignee form', () => {
    expect(() => assertAgentTaskConfigForMode('r', { assigneeUserId: 'u-1' }, 'interactive')).not.toThrow();
    expect(() => assertAgentTaskConfigForMode('r', { assigneeEmail: 'a@b.co' }, 'interactive')).not.toThrow();
  });

  it('holds an interactive deadline to 1 hour through 14 days', () => {
    const base = { assigneeUserId: 'u-1' };
    expect(() => assertAgentTaskConfigForMode('r', { ...base, deadlineMs: HOUR }, 'interactive')).not.toThrow();
    expect(() => assertAgentTaskConfigForMode('r', { ...base, deadlineMs: 14 * DAY }, 'interactive')).not.toThrow();
    expect(() => assertAgentTaskConfigForMode('r', { ...base, deadlineMs: HOUR - 1 }, 'interactive')).toThrow(
      /1 hour through 14 days/,
    );
    expect(() => assertAgentTaskConfigForMode('r', { ...base, deadlineMs: 14 * DAY + 1 }, 'interactive')).toThrow(
      /1 hour through 14 days/,
    );
  });

  it('needs no assignee for a task that runs on its own', () => {
    expect(() => assertAgentTaskConfigForMode('r', { prompt: 'p' }, 'autonomous')).not.toThrow();
    expect(() => assertAgentTaskConfigForMode('r', undefined, 'autonomous')).not.toThrow();
  });

  it('holds a task that runs on its own to 60 minutes', () => {
    expect(() => assertAgentTaskConfigForMode('r', { deadlineMs: HOUR }, 'autonomous')).not.toThrow();
    expect(() => assertAgentTaskConfigForMode('r', { deadlineMs: 10 * 60 * 1000 }, 'autonomous')).not.toThrow();
    expect(() => assertAgentTaskConfigForMode('r', { deadlineMs: HOUR + 1 }, 'autonomous')).toThrow(
      /cannot exceed 60 minutes/,
    );
  });

  it('names the node in the error, so the author can find it', () => {
    try {
      assertAgentTaskConfigForMode('investigate-1', {}, 'interactive');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PlaybookGraphNodeRuleError);
      expect((error as PlaybookGraphNodeRuleError).message).toContain('investigate-1');
    }
  });

  const graph = (nodes: Array<{ id: string; stepType: string; config?: Record<string, unknown> }>) =>
    ({ nodes, edges: [] }) as unknown as PlaybookGraph;

  it('checks every Agent task in a graph against its own Skill and skips other step types', () => {
    const g = graph([
      { id: 'chat', stepType: 'cursor-agent', config: { assigneeUserId: 'u-1' } },
      { id: 'solo', stepType: 'cursor-agent', config: {} },
      { id: 'ping', stepType: 'notify', config: {} },
    ]);
    expect(() =>
      assertAgentTasksFitTheirSkills(g, [
        { nodeId: 'chat', mode: 'interactive' },
        { nodeId: 'solo', mode: 'autonomous' },
      ]),
    ).not.toThrow();
  });

  it('refuses a graph where one interactive task has no assignee', () => {
    const g = graph([
      { id: 'solo', stepType: 'cursor-agent', config: {} },
      { id: 'chat', stepType: 'cursor-agent', config: {} },
    ]);
    expect(() =>
      assertAgentTasksFitTheirSkills(g, [
        { nodeId: 'solo', mode: 'autonomous' },
        { nodeId: 'chat', mode: 'interactive' },
      ]),
    ).toThrow(/"chat".*assignee/);
  });

  it('treats a task with no resolved mode as running on its own', () => {
    const g = graph([{ id: 'x', stepType: 'cursor-agent', config: {} }]);
    expect(() => assertAgentTasksFitTheirSkills(g, [])).not.toThrow();
  });
});

describe('deadlines by mode', () => {
  it('defaults to 60 minutes on its own and 7 days in a chat', () => {
    expect(resolveDeadlineMs('cursor-agent')).toBe(HOUR);
    expect(resolveDeadlineMs('cursor-agent', undefined, { interactive: false })).toBe(HOUR);
    expect(resolveDeadlineMs('cursor-agent', undefined, { interactive: true })).toBe(7 * DAY);
  });

  it('allows a chat from 1 hour through 14 days and nothing outside it', () => {
    const chat = { interactive: true };
    expect(resolveDeadlineMs('cursor-agent', HOUR, chat)).toBe(HOUR);
    expect(resolveDeadlineMs('cursor-agent', 14 * DAY, chat)).toBe(14 * DAY);
    expect(() => resolveDeadlineMs('cursor-agent', HOUR - 1, chat)).toThrow(/1 hour through 14 days/);
    expect(() => resolveDeadlineMs('cursor-agent', 14 * DAY + 1, chat)).toThrow(/1 hour through 14 days/);
  });

  it('keeps a task that runs on its own from waiting longer than 60 minutes', () => {
    expect(() => resolveDeadlineMs('cursor-agent', 2 * HOUR)).toThrow(/not exceed/);
    expect(resolveDeadlineMs('cursor-agent', 5 * 60 * 1000)).toBe(5 * 60 * 1000);
  });

  it('leaves the other step types alone', () => {
    expect(resolveDeadlineMs('interview')).toBe(7 * DAY);
    expect(() => resolveDeadlineMs('interview', 15 * DAY)).toThrow(/1 hour through 14 days/);
    // The flag means nothing off the Agent task.
    expect(resolveDeadlineMs('approval-gate', undefined, { interactive: true })).toBe(48 * HOUR);
  });

  it('keeps the descriptor default at 60 minutes, since most tasks run on their own', () => {
    expect(getStepTypeDescriptor('cursor-agent').defaultDeadlineMs).toBe(HOUR);
  });
});

describe('the interactive-agent step type is gone', () => {
  it('is not a registered step type', () => {
    expect(() => getStepTypeDescriptor('interactive-agent')).toThrow(/interactive-agent/);
  });

  it('lets a cursor-agent config carry an assignee', () => {
    const parsed = getStepTypeDescriptor('cursor-agent').inputSchema.parse({
      prompt: 'p',
      assigneeUserId: 'u-1',
      deadlineMs: 3 * DAY,
    });
    expect(parsed).toMatchObject({ assigneeUserId: 'u-1', deadlineMs: 3 * DAY });
  });

  it('refuses an invalid assignee email and an outer-bound deadline', () => {
    const { inputSchema } = getStepTypeDescriptor('cursor-agent');
    expect(inputSchema.safeParse({ prompt: 'p', assigneeEmail: 'not-an-email' }).success).toBe(false);
    expect(inputSchema.safeParse({ prompt: 'p', deadlineMs: 15 * DAY }).success).toBe(false);
  });

  it('accepts the output of either mode', () => {
    const { outputSchema } = getStepTypeDescriptor('cursor-agent');
    const completedAt = '2026-11-23T10:00:00.000Z';
    // Autonomous: a run id and no approver.
    expect(outputSchema.safeParse({ agentRunId: 'run-1', completedAt }).success).toBe(true);
    // Chat: no single run id, an approver, and the approved text.
    expect(
      outputSchema.safeParse({ threadId: 't-1', approvedBy: 'u-1', completedAt, output: 'Approved text', outcome: 'ok' })
        .success,
    ).toBe(true);
  });
});

describe('telling a chat row from a run-on-its-own row', () => {
  it('reads a chat draft by its thread and assignee', () => {
    expect(isInteractiveTaskDraft(draft)).toBe(true);
    expect(isInteractiveTaskDraft({ threadId: 't-1' })).toBe(false);
    expect(isInteractiveTaskDraft({ assigneeUserId: 'u-1' })).toBe(false);
    expect(isInteractiveTaskDraft({ threadId: 1, assigneeUserId: 'u-1' })).toBe(false);
    expect(isInteractiveTaskDraft(null)).toBe(false);
    expect(isInteractiveTaskDraft(undefined)).toBe(false);
    expect(isInteractiveTaskDraft('draft')).toBe(false);
  });

  it('is a chat only for an Agent task with a draft', () => {
    expect(isInteractiveAgentTaskRow('cursor-agent', draft)).toBe(true);
    expect(isInteractiveAgentTaskRow('cursor-agent', null)).toBe(false);
    expect(isInteractiveAgentTaskRow('cursor-agent', { agentRunId: 'r' })).toBe(false);
    // Another step type that happens to hold the same shape is not a chat.
    expect(isInteractiveAgentTaskRow('interview', draft)).toBe(false);
    expect(isInteractiveAgentTaskRow('cloud-agent', draft)).toBe(false);
  });

  it('reports the wait as a person for a chat and as a machine for the rest', () => {
    expect(suspendReasonForStep('cursor-agent', draft)).toBe('interactive_agent');
    expect(suspendReasonForStep('cursor-agent', null)).toBe('agent_run');
    expect(suspendReasonForStep('approval-gate', null)).toBe(suspendReasonForStepType('approval-gate'));
    expect(suspendReasonForStep('interview', draft)).toBe(suspendReasonForStepType('interview'));
  });

  it('still renders a row saved under the removed step type', () => {
    expect(suspendReasonForStep('interactive-agent', draft)).toBe('agent_run');
  });
});
