/**
 * Tools a project skill may ask for, beyond reading the repository.
 *
 * A skill names its tools in one frontmatter line: `playbook-capabilities: [azure-cli]`. This list is
 * the only place that says which names exist, what to call them, and what they allow. The skill
 * editor builds its picker from it, and the server refuses any other name.
 *
 * To add a tool (for example `aws-cli`):
 * 1. Add its id to PLAYBOOK_CAPABILITIES in `../types/playbookExecutionCapability.ts`.
 * 2. Add an entry here.
 * 3. Make the agent worker able to run it. The worker needs the CLI installed and its credentials;
 *    naming the tool here does not give a run either of those.
 */
import type { PlaybookCapability } from '../types/playbookExecutionCapability';

export interface PlaybookSkillTool {
  id: PlaybookCapability;
  label: string;
  description: string;
}

export const PLAYBOOK_SKILL_TOOLS: readonly PlaybookSkillTool[] = [
  {
    id: 'azure-cli',
    label: 'Azure CLI',
    description: 'Run az commands in the agent shell, for example to query App Insights.',
  },
];

export function playbookSkillTool(id: string): PlaybookSkillTool | undefined {
  return PLAYBOOK_SKILL_TOOLS.find((tool) => tool.id === id);
}

export const PLAYBOOK_SKILL_TOOL_IDS: readonly PlaybookCapability[] = PLAYBOOK_SKILL_TOOLS.map((tool) => tool.id);
