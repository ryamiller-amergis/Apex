import { enrichKickoffForAtsBoardWebResearch } from '../services/playbookAtsWebResearchService';
import { ATS_BOARD_PUBLIC_WEB_MCP_PROFILE } from '../../shared/atsBoardMcp';

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn(),
}));

const { getSkillConfig } = jest.requireMock('../services/projectSettingsService');

describe('playbookAtsWebResearchService', () => {
  it('leaves non-ATS profiles unchanged', async () => {
    const kickoff = {
      project: 'Apex',
      repo: 'Apex',
      playbookMcpProfile: 'repository-read-only',
    };
    await expect(enrichKickoffForAtsBoardWebResearch(kickoff)).resolves.toBe(kickoff);
  });

  it('wires interview web MCP for the public-web profile', async () => {
    getSkillConfig.mockResolvedValue({
      interviewWebMcp: {
        transport: 'http',
        label: 'Web',
        mcpServerName: 'web-search',
        url: 'http://localhost:9999/mcp/web',
      },
    });
    const enriched = await enrichKickoffForAtsBoardWebResearch({
      project: 'Apex',
      repo: 'Apex',
      playbookMcpProfile: ATS_BOARD_PUBLIC_WEB_MCP_PROFILE,
    });
    expect(enriched.webResearchEnabled).toBe(true);
    expect(enriched.playbookAtsWebResearch).toBe(true);
    expect(enriched.mcpPill?.transport === 'http' && enriched.mcpPill.url).toBe(
      'http://localhost:9999/mcp/web',
    );
  });

  it('refuses dispatch when interview web MCP is missing', async () => {
    getSkillConfig.mockResolvedValue({});
    await expect(
      enrichKickoffForAtsBoardWebResearch({
        project: 'Apex',
        repo: 'Apex',
        playbookMcpProfile: ATS_BOARD_PUBLIC_WEB_MCP_PROFILE,
      }),
    ).rejects.toThrow(/Interview web MCP/);
  });
});
