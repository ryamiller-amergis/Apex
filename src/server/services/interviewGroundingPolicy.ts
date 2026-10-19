import fs from 'fs';
import path from 'path';
import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import type { LocalAgentOptions, McpServerConfig } from '@cursor/sdk/dist/cjs/options.js';
import type { InterviewRepositoryPhase } from '../../shared/types/interview';
import type { RepoReader } from '../../shared/types/repoReader';
import { createNativeReadTools } from './nativeReadToolAdapter';
import { usesGuidedInterview } from './guidedInterviewState';

export type { InterviewRepositoryPhase };
export { usesGuidedInterview, wrapGuidedInterviewPrompt } from './guidedInterviewState';

const MARKER_RE = /\[\[interview-phase:(discovery|delivery|technical):(done|stopped|skipped|wrapup|\d+)(?::\d+)?(?::followup)?\]\]/g;
const CLOSED_TOOL_TEXT = 'Repository tools are closed during Discovery and Delivery. Use the application brief in this message. If it does not cover the question, ask the person or record the gap as unresolved.';
const TECHNICAL_SEARCH_TEXT = 'Repository search is closed. Read at most two known files with get_skill_file, or ask the person.';

function userChoseTechnical(userText: string): boolean {
  const text = userText.trim().toLowerCase();
  if (!text) return false;
  if (text.includes('generate the prd') || text.includes('generate prd')) return false;
  if (/^b\b/.test(text)) return false;
  return /\btechnical\b/.test(text) || /^a\b/.test(text);
}

/**
 * Discovery and Delivery stay on the application brief.
 * Repository reads open on the turn that enters Technical.
 */
export function interviewRepositoryPhase(
  skillPath: string | null | undefined,
  messages: Array<{ role: string; text: string }>,
): InterviewRepositoryPhase | null {
  if (!usesGuidedInterview(skillPath)) return null;

  let last: { phase: string; token: string } | null = null;
  for (const message of messages) {
    if (message.role !== 'agent') continue;
    for (const match of message.text.matchAll(MARKER_RE)) {
      last = { phase: match[1], token: match[2] };
    }
  }

  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  if (last?.phase === 'technical' && last.token !== 'skipped') return 'technical';
  if (last?.phase === 'delivery' && last.token === 'done' && userChoseTechnical(latestUser?.text ?? '')) {
    return 'technical';
  }
  return 'product';
}

function closedTool(description: string, text: string): SDKCustomTool {
  const inputSchema: Record<string, SDKJsonValue> = {
    type: 'object',
    additionalProperties: true,
  };
  return {
    description,
    inputSchema,
    execute: async () => ({
      content: [{ type: 'text', text }],
      isError: true,
    }),
  };
}

export function closedRepositoryTools(): Record<string, SDKCustomTool> {
  return {
    get_skill_file: closedTool('Closed during Discovery and Delivery.', CLOSED_TOOL_TEXT),
    list_repo_dir: closedTool('Closed during Discovery and Delivery.', CLOSED_TOOL_TEXT),
    search_repo_code: closedTool('Closed during Discovery and Delivery.', CLOSED_TOOL_TEXT),
  };
}

export function technicalRepositoryTools(
  repoReader: RepoReader | undefined,
): Record<string, SDKCustomTool> {
  const search = closedTool('Closed. Read a known path instead.', TECHNICAL_SEARCH_TEXT);
  if (!repoReader) return { ...closedRepositoryTools(), search_repo_code: search };
  const reads = createNativeReadTools(repoReader, { allowSearch: false });
  return { ...reads, search_repo_code: search };
}

export function guidedInterviewRepositoryTools(
  phase: InterviewRepositoryPhase,
  repoReader: RepoReader | undefined,
): Record<string, SDKCustomTool> {
  return phase === 'product'
    ? closedRepositoryTools()
    : technicalRepositoryTools(repoReader);
}

export interface GuidedRuntime {
  local: LocalAgentOptions;
  mcpServers: Record<string, McpServerConfig>;
  repoReader?: RepoReader;
}

export function applyGuidedInterviewRuntime<T extends GuidedRuntime>(
  runtime: T,
  phase: InterviewRepositoryPhase,
): T {
  const mcpServers = { ...runtime.mcpServers };
  if (phase === 'product') {
    delete mcpServers['github-repo'];
    delete mcpServers['ado-skills'];
  }
  return {
    ...runtime,
    mcpServers,
    local: {
      ...runtime.local,
      settingSources: [],
      // This environment has no local sandbox. enabled: false also overrides
      // ~/.cursor/sandbox.json, which otherwise requests sandboxing and fails the turn.
      sandboxOptions: { enabled: false },
      customTools: guidedInterviewRepositoryTools(phase, runtime.repoReader),
    },
  };
}

export function guidedGroundingMarkerPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.ai-pilot', 'product-grounding-v3');
}

export function guidedInterviewNeedsFreshAgent(workspaceDir: string): boolean {
  return !fs.existsSync(guidedGroundingMarkerPath(workspaceDir));
}

export function markGuidedInterviewGrounding(workspaceDir: string): void {
  const marker = guidedGroundingMarkerPath(workspaceDir);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, 'ba-brief\n');
}

export function isInterviewSandboxUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('sandboxing is not supported');
}

export function writeInterviewBaBriefFile(workspaceDir: string, brief: string): void {
  const file = path.join(workspaceDir, '.ai-pilot', 'ba-application-brief.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === brief) return;
  fs.writeFileSync(file, brief);
}
