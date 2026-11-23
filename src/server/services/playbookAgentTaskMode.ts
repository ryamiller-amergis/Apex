/**
 * An Agent task is one step type (`cursor-agent`). The Skill it runs decides how it behaves:
 *
 * - `interactive` in the Skill's frontmatter: the step chats with an assignee and resumes only
 *   when that person approves a result.
 * - anything else, including no declaration and no Skill: the agent runs on its own and the step
 *   resumes when the run ends.
 *
 * The mode is read from the Skill bytes the policy already pinned, so a published Playbook cannot
 * change mode unless it is republished against different bytes.
 */
import type { PlaybookGraph } from '../../shared/types/playbook';
import {
  agentTaskModeForSkillType,
  type AgentTaskMode,
} from '../../shared/utils/playbookAgentTask';
import { PlaybookGraphNodeRuleError } from './playbookGuardService';
import { declaredSkillType, parsePlaybookSkillFrontmatter } from './playbookSkillFrontmatter';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const AUTONOMOUS_MAX_DEADLINE_MS = HOUR_MS;
const INTERACTIVE_MIN_DEADLINE_MS = HOUR_MS;
const INTERACTIVE_MAX_DEADLINE_MS = 14 * DAY_MS;

/** The mode a Skill's text selects. Unreadable frontmatter runs on its own, as no declaration does. */
export function agentTaskModeOfSkill(skillContent: string): AgentTaskMode {
  return agentTaskModeForSkillType(declaredSkillType(skillContent));
}

/** The outcome-bearing kind a Skill declares, or null. Used to check an interactive proposal. */
export function agentTaskOutputKind(skillContent: string): string | null {
  try {
    return parsePlaybookSkillFrontmatter(skillContent).outputKind;
  } catch {
    return null;
  }
}

/** Throws when a node's config does not fit the mode its Skill selects. */
export function assertAgentTaskConfigForMode(
  nodeId: string,
  config: Record<string, unknown> | undefined,
  mode: AgentTaskMode,
): void {
  const deadline = config?.deadlineMs;
  if (mode === 'interactive') {
    const hasAssignee = [config?.assigneeUserId, config?.assigneeEmail]
      .some((value) => typeof value === 'string' && value.trim().length > 0);
    if (!hasAssignee) {
      throw new PlaybookGraphNodeRuleError(
        nodeId,
        `Agent task "${nodeId}" uses an interactive Skill, so it needs an assignee to chat with the agent and approve its result.`,
      );
    }
    if (
      typeof deadline === 'number'
      && (deadline < INTERACTIVE_MIN_DEADLINE_MS || deadline > INTERACTIVE_MAX_DEADLINE_MS)
    ) {
      throw new PlaybookGraphNodeRuleError(
        nodeId,
        `Agent task "${nodeId}" uses an interactive Skill, so its deadline must be from 1 hour through 14 days.`,
      );
    }
    return;
  }
  if (typeof deadline === 'number' && deadline > AUTONOMOUS_MAX_DEADLINE_MS) {
    throw new PlaybookGraphNodeRuleError(
      nodeId,
      `Agent task "${nodeId}" runs on its own, so its deadline cannot exceed 60 minutes. ` +
        'Pick an interactive Skill for a longer wait, or shorten the deadline.',
    );
  }
}

/** Publish check: every Agent task's config fits the mode its pinned Skill selects. */
export function assertAgentTasksFitTheirSkills(
  graph: PlaybookGraph,
  modes: ReadonlyArray<{ nodeId: string; mode: AgentTaskMode }>,
): void {
  const modeByNode = new Map(modes.map(({ nodeId, mode }) => [nodeId, mode]));
  for (const node of graph.nodes) {
    if (node.stepType !== 'cursor-agent') continue;
    assertAgentTaskConfigForMode(node.id, node.config, modeByNode.get(node.id) ?? 'autonomous');
  }
}
