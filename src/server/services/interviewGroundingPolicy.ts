import fs from 'fs';
import path from 'path';
import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import type { LocalAgentOptions, McpServerConfig } from '@cursor/sdk/dist/cjs/options.js';
import type { RepoReader } from '../../shared/types/repoReader';
import { createNativeReadTools } from './nativeReadToolAdapter';

export type InterviewRepositoryPhase = 'product' | 'technical';

const MARKER_RE = /\[\[interview-phase:(discovery|delivery|technical):(done|stopped|skipped|\d+)(?::\d+)?\]\]/g;
const CLOSED_TOOL_TEXT = 'Repository tools are closed during Discovery and Delivery. Use the application brief in this message. If it does not cover the question, ask the person or record the gap as unresolved.';
const TECHNICAL_SEARCH_TEXT = 'Repository search is closed. Read at most two known files with get_skill_file, or ask the person.';

export function usesGuidedInterview(skillPath: string | null | undefined): boolean {
  if (!skillPath) return false;
  return skillPath.replace(/\\/g, '/').toLowerCase().includes('grill-with-docs');
}

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

export function wrapGuidedInterviewPrompt(
  promptText: string,
  phase: InterviewRepositoryPhase,
  brief: string,
): string {
  const rules = phase === 'product'
    ? [
        '# Application brief',
        'This brief is the application context for Discovery and Delivery. It was prepared before this turn.',
        'Repository search is closed. Do not call grep, glob, read, search_repo_code, get_skill_file, or list_repo_dir.',
        'If the brief does not cover the question, ask the person or record the gap as unresolved.',
      ]
    : [
        '# Technical phase',
        'Repository search is closed. You may read at most two known files with get_skill_file.',
        'Do not call grep, glob, or search_repo_code.',
        'The application brief below is the product language for this interview.',
      ];
  return [...rules, '', brief, '', '# Continue the interview', promptText].join('\n');
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
      sandboxOptions: { enabled: true },
      customTools: phase === 'product'
        ? closedRepositoryTools()
        : technicalRepositoryTools(runtime.repoReader),
    },
  };
}

export function guidedGroundingMarkerPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.ai-pilot', 'product-grounding-v1');
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
