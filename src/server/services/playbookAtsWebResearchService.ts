import type { ChatThreadKickoff } from '../../shared/types/chat';
import { ATS_BOARD_PUBLIC_WEB_MCP_PROFILE } from '../../shared/atsBoardMcp';
import { getSkillConfig } from './projectSettingsService';

export class PlaybookAtsWebResearchNotConfiguredError extends Error {
  constructor() {
    super(
      'ATS board public web research requires Interview web MCP in project skill settings.',
    );
    this.name = 'PlaybookAtsWebResearchNotConfiguredError';
  }
}

/**
 * Wires charter-bound public web research for ATS specialist playbook steps.
 * The web-search MCP comes only from project skill settings — never from Agent Home pills.
 */
export async function enrichKickoffForAtsBoardWebResearch(
  kickoff: ChatThreadKickoff,
): Promise<ChatThreadKickoff> {
  if (kickoff.playbookMcpProfile !== ATS_BOARD_PUBLIC_WEB_MCP_PROFILE) {
    return kickoff;
  }
  if (!kickoff.project?.trim()) return kickoff;

  const cfg = await getSkillConfig(kickoff.project);
  if (!cfg?.interviewWebMcp) {
    throw new PlaybookAtsWebResearchNotConfiguredError();
  }

  return {
    ...kickoff,
    webResearchEnabled: true,
    playbookAtsWebResearch: true,
    mcpPill: cfg.interviewWebMcp,
  };
}
