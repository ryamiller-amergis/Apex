/**
 * Which tools a project lets its skills use (azure-cli, and later others). The catalog of tool
 * names is `PLAYBOOK_SKILL_TOOLS`; this service stores which of them a project allows.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { projectPlaybookTools } from '../db/schema';
import { PLAYBOOK_SKILL_TOOLS, playbookSkillTool } from '../../shared/constants/playbookSkillTools';

export class PlaybookToolAllowListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookToolAllowListError';
  }
}

/** The tool ids this project allows. A tool the catalog no longer lists is dropped. */
export async function listAllowedPlaybookTools(project: string): Promise<string[]> {
  const rows = await db
    .select({ tool: projectPlaybookTools.tool })
    .from(projectPlaybookTools)
    .where(eq(projectPlaybookTools.project, project));
  return rows.map((row) => row.tool).filter((tool) => playbookSkillTool(tool)).sort();
}

/** Replaces the project's allowed tools with the given list. */
export async function setAllowedPlaybookTools(input: {
  project: string;
  tools: readonly string[];
  actorUserId: string;
}): Promise<string[]> {
  const unknown = input.tools.find((tool) => !playbookSkillTool(tool));
  if (unknown) {
    throw new PlaybookToolAllowListError(`"${unknown}" is not a tool Apex offers.`);
  }
  const tools = [...new Set(input.tools)].sort();
  await db.transaction(async (tx) => {
    await tx.delete(projectPlaybookTools).where(eq(projectPlaybookTools.project, input.project));
    if (tools.length > 0) {
      await tx.insert(projectPlaybookTools).values(
        tools.map((tool) => ({ project: input.project, tool, enabledBy: input.actorUserId })),
      );
    }
  });
  return tools;
}

/**
 * Throws when a skill names a tool that does not exist or that the project has not allowed.
 * Skills read the repository without naming anything, so a skill with no tools always passes.
 */
export async function assertSkillToolsAllowed(project: string, declared: readonly string[]): Promise<void> {
  if (declared.length === 0) return;
  const unknown = declared.find((tool) => !playbookSkillTool(tool));
  if (unknown) {
    const offered = PLAYBOOK_SKILL_TOOLS.map((tool) => tool.id).join(', ');
    throw new PlaybookToolAllowListError(
      `The skill names the tool "${unknown}", which Apex does not offer. Tools: ${offered}.`,
    );
  }
  const allowed = new Set(await listAllowedPlaybookTools(project));
  const refused = declared.filter((tool) => !allowed.has(tool));
  if (refused.length > 0) {
    const labels = refused.map((tool) => playbookSkillTool(tool)?.label ?? tool).join(', ');
    throw new PlaybookToolAllowListError(
      `${project} has not enabled ${labels} for skills. A platform admin can enable it in the skill library.`,
    );
  }
}
