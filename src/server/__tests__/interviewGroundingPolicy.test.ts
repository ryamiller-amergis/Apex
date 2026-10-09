import fs from 'fs';
import os from 'os';
import path from 'path';
import type { LocalAgentOptions, McpServerConfig } from '@cursor/sdk/dist/cjs/options.js';
import type { RepoReader } from '../../shared/types/repoReader';
import {
  applyGuidedInterviewRuntime,
  guidedInterviewNeedsFreshAgent,
  interviewRepositoryPhase,
  markGuidedInterviewGrounding,
  wrapGuidedInterviewPrompt,
} from '../services/interviewGroundingPolicy';

function reader(): jest.Mocked<RepoReader> {
  return {
    identity: { provider: 'github', project: 'Apex', repo: 'Apex', sha: 'abc' },
    readFile: jest.fn().mockResolvedValue('file'),
    listDir: jest.fn().mockResolvedValue([]),
    searchCode: jest.fn().mockResolvedValue([]),
  };
}

describe('interview grounding policy', () => {
  it('keeps Discovery and Delivery on the product brief', () => {
    const messages = [
      { role: 'agent', text: '[[interview-phase:discovery:3:6]]\nWho uses it?' },
      { role: 'user', text: 'Anyone with Home access' },
    ];

    expect(interviewRepositoryPhase('/.cursor/skills/grill-with-docs/SKILL.md', messages)).toBe('product');
    expect(interviewRepositoryPhase('/.cursor/skills/grill-design/SKILL.md', messages)).toBeNull();
  });

  it('opens repository reads only after the person continues to Technical', () => {
    const waiting = [
      { role: 'agent', text: '[[interview-phase:delivery:done]]\n\na. Continue to technical decisions\nb. Generate the PRD' },
      { role: 'user', text: 'b. Generate the PRD' },
    ];
    const continuing = [
      { role: 'agent', text: '[[interview-phase:delivery:done]]\n\na. Continue to technical decisions\nb. Generate the PRD' },
      { role: 'user', text: 'a. Continue to technical decisions' },
    ];

    expect(interviewRepositoryPhase('grill-with-docs', waiting)).toBe('product');
    expect(interviewRepositoryPhase('grill-with-docs', continuing)).toBe('technical');
  });

  it('tells the model the brief replaces repository search', () => {
    const prompt = wrapGuidedInterviewPrompt('Q3: A', 'product', '## What is Apex?\n\nApex is the product.');

    expect(prompt).toContain('Repository search is closed');
    expect(prompt).toContain('## What is Apex?');
    expect(prompt).toContain('Q3: A');
  });

  it('closes repository servers and search during Discovery', async () => {
    const repoReader = reader();
    const local: LocalAgentOptions = { cwd: '/tmp/interview' };
    const mcpServers: Record<string, McpServerConfig> = {
      'github-repo': { url: 'http://localhost/mcp/github-repo' },
      maxview: { url: 'http://localhost/mcp/maxview' },
    };
    const runtime = applyGuidedInterviewRuntime(
      { local, mcpServers, repoReader },
      'product',
    );

    expect(runtime.mcpServers['github-repo']).toBeUndefined();
    expect(runtime.mcpServers.maxview).toBeDefined();
    expect(runtime.local.sandboxOptions).toEqual({ enabled: true });
    const result = await runtime.local.customTools?.search_repo_code.execute({ query: 'home' }, {});
    expect(result).toMatchObject({ isError: true });
    expect(repoReader.searchCode).not.toHaveBeenCalled();
  });

  it('records that a guided interview agent was created with the brief policy', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-grounding-'));
    expect(guidedInterviewNeedsFreshAgent(workspace)).toBe(true);
    markGuidedInterviewGrounding(workspace);
    expect(guidedInterviewNeedsFreshAgent(workspace)).toBe(false);
  });
});
