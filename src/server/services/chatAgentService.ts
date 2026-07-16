import { Agent, CursorAgentError } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk/dist/cjs/agent.js';
import type { McpServerConfig } from '@cursor/sdk/dist/cjs/options.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type {
  ChatAttachment,
  ChatAttachmentMeta,
  ChatThread,
  ChatMessage,
  ChatThreadKickoff,
  SseEvent,
  SseErrorCode,
} from '../../shared/types/chat';
import { isAzureWwwroot, resolveDataRoot } from '../utils/dataDir';
import { recordAiUsage, estimateTokens, resolveFeatureFromKickoff } from './aiUsageService';
import {
  upsertThread as pgUpsertThread,
  insertMessage as pgInsertMessage,
  listThreadsByUser as pgListThreadsByUser,
  loadFullThread as pgLoadFullThread,
  deleteThread as pgDeleteThread,
} from './chatThreadRepository';
import { db } from '../db/drizzle';
import { and, eq, isNull, or } from 'drizzle-orm';
import { interviews, prds, designDocs, testCases, devSessions, agentRuns } from '../db/schema';
import { syncPrdContent } from './prdService';
import { notifyAiCompletion } from './aiCompletionNotifier';
import { syncDesignDocContent, syncValidationResult, syncPerFeatureDesignDocs } from './designDocService';
import { markTestCaseFailed, syncTestCaseOutput, triggerTestCaseGeneration } from './testCaseService';
import type { ValidationScorecard } from '../../shared/types/interview';
import type { ChatThreadSummary } from '../../shared/types/chat';
import { retryWithBackoff } from '../utils/retry';
import { trackAgentError, trackEvent } from './telemetry';
import { notifyRunEvent } from './pgNotifyService';
import { isMaxviewConfigured } from './maxviewAuthService';
import { isFeatureEnabled } from './featureFlagService';

// ── Configuration ─────────────────────────────────────────────────────────────

const DATA_ROOT = resolveDataRoot();
const WORKSPACE_BASE = process.env.AI_PILOT_WORKSPACE_DIR
  ? path.resolve(process.env.AI_PILOT_WORKSPACE_DIR)
  : isAzureWwwroot()
    ? path.join(DATA_ROOT, 'workspaces')
    : path.join(os.tmpdir(), 'ai-pilot-workspaces');
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const INTERVIEW_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// ── In-memory state ───────────────────────────────────────────────────────────

interface ThreadState {
  thread: ChatThread;
  /** SSE subscriber callbacks for this thread */
  subscribers: Set<(event: SseEvent) => void>;
  /** Live Cursor SDK agent — null between turns */
  agent: SDKAgent | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Cached flag — true when the thread backs an interview row (gets longer idle timeout) */
  isInterviewThread: boolean;
  /** True when the thread backs a dev-session (gets extended run timeout for sequential implementation) */
  isDevSession: boolean;
}

const threads = new Map<string, ThreadState>();

// ── Output file helpers ───────────────────────────────────────────────────────

/**
 * Returns the path of the first file in `dir` whose name matches `pattern`,
 * or null if not found / dir doesn't exist.
 */
function findOutputFile(dir: string, pattern: RegExp): string | null {
  const all = findAllOutputFiles(dir, pattern);
  return all.length > 0 ? all[0] : null;
}

/**
 * Returns all file paths in `dir` (recursively) whose names match `pattern`,
 * sorted alphabetically so multi-feature output is deterministic.
 */
function findAllOutputFiles(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && pattern.test(entry.name)) {
        results.push(path.join(dir, entry.name));
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push(...findAllOutputFiles(path.join(dir, entry.name), pattern));
      }
    }
    results.sort();
    return results;
  } catch {
    return [];
  }
}

// ── Persistence helpers ───────────────────────────────────────────────────────

function ensureDirs() {
  fs.mkdirSync(WORKSPACE_BASE, { recursive: true });
  cleanupStaleWorkspaces();
}

function persistThread(thread: ChatThread) {
  pgUpsertThread(thread).catch((err: Error) =>
    console.error('[chat] pg upsertThread failed:', err.message),
  );
}

async function loadThread(threadId: string): Promise<ChatThread | null> {
  return pgLoadFullThread(threadId);
}

// ── Workspace helpers ─────────────────────────────────────────────────────────

/**
 * Remove workspace dirs whose session.json is older than 2 hours.
 * Called at startup to clean up after server restarts mid-session.
 */
function logWorkspaceContents(workspaceDir: string, context: string): void {
  try {
    if (!fs.existsSync(workspaceDir)) {
      console.warn(`[chat] ${context}: workspace does not exist (${workspaceDir})`);
      return;
    }
    const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
    if (!fs.existsSync(outputDir)) {
      console.warn(`[chat] ${context}: output dir does not exist (${outputDir})`);
      const topLevel = fs.readdirSync(workspaceDir, { recursive: true }) as string[];
      console.warn(`[chat] ${context}: workspace files: ${topLevel.slice(0, 30).join(', ')}`);
      return;
    }
    const outputFiles = fs.readdirSync(outputDir, { recursive: true }) as string[];
    console.warn(`[chat] ${context}: output dir files (${outputFiles.length}): ${outputFiles.slice(0, 30).join(', ')}`);
  } catch {
    console.warn(`[chat] ${context}: failed to list workspace contents`);
  }
}

function cleanupStaleWorkspaces() {
  if (!fs.existsSync(WORKSPACE_BASE)) return;
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const dir of fs.readdirSync(WORKSPACE_BASE)) {
    const sessionFile = path.join(WORKSPACE_BASE, dir, '.ai-pilot', 'session.json');
    if (fs.existsSync(sessionFile)) {
      const stat = fs.statSync(sessionFile);
      if (stat.mtimeMs < twoHoursAgo) {
        fs.rmSync(path.join(WORKSPACE_BASE, dir), { recursive: true, force: true });
      }
    }
  }
}

function injectKickoffFiles(workspaceDir: string, kickoff: ChatThreadKickoff, threadId: string): void {
  const aiPilotDir = path.join(workspaceDir, '.ai-pilot');
  fs.mkdirSync(aiPilotDir, { recursive: true });
  fs.mkdirSync(path.join(aiPilotDir, 'output'), { recursive: true });

  if (kickoff.transcript) {
    fs.writeFileSync(
      path.join(aiPilotDir, 'kickoff-transcript.md'),
      kickoff.transcript,
      'utf-8',
    );
  }

  if (kickoff.freeformContext) {
    fs.writeFileSync(
      path.join(aiPilotDir, 'kickoff-context.md'),
      kickoff.freeformContext,
      'utf-8',
    );
  }

  // Write a session marker so the skill can reference provenance
  fs.writeFileSync(
    path.join(aiPilotDir, 'session.json'),
    JSON.stringify(
      {
        threadId,
        skillPath: kickoff.skillPath,
        project: kickoff.project,
        repo: kickoff.repo,
        branch: kickoff.branch,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf-8',
  );
}

function sanitizeAttachmentName(name: string, index: number): string {
  const fallback = `attachment-${index + 1}.txt`;
  const baseName = path.basename(name || fallback);
  const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return sanitized || fallback;
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mammoth = require('mammoth') as { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> };
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function writeMessageAttachments(
  workspaceDir: string,
  turnId: string,
  attachments: ChatAttachment[],
): Promise<ChatAttachmentMeta[]> {
  if (attachments.length === 0) return [];

  const attachmentsDir = path.join(workspaceDir, '.ai-pilot', 'attachments', turnId);
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const results: ChatAttachmentMeta[] = [];
  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index];
    const fileName = `${String(index + 1).padStart(2, '0')}-${sanitizeAttachmentName(attachment.name, index)}`;
    const absolutePath = path.join(attachmentsDir, fileName);
    if (attachment.encoding === 'base64') {
      fs.writeFileSync(absolutePath, Buffer.from(attachment.content, 'base64'));
    } else {
      fs.writeFileSync(absolutePath, attachment.content, 'utf-8');
    }

    const isDocx = attachment.name.toLowerCase().endsWith('.docx')
      || attachment.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    if (isDocx && attachment.encoding === 'base64') {
      try {
        const docxBuffer = Buffer.from(attachment.content, 'base64');
        const extractedText = await extractDocxText(docxBuffer);
        const txtFileName = fileName.replace(/\.docx$/i, '.txt');
        fs.writeFileSync(path.join(attachmentsDir, txtFileName), extractedText, 'utf-8');
        results.push({
          id: attachment.id,
          name: attachment.name.replace(/\.docx$/i, '.txt'),
          type: 'text/plain',
          size: Buffer.byteLength(extractedText, 'utf-8'),
          path: path.posix.join('.ai-pilot', 'attachments', turnId, txtFileName),
        });
        continue;
      } catch (err) {
        console.warn(`[chat] Failed to extract text from ${attachment.name}, falling back to raw file:`, err);
      }
    }

    results.push({
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      path: path.posix.join('.ai-pilot', 'attachments', turnId, fileName),
    });
  }
  return results;
}

function buildPromptWithAttachments(text: string, attachments: ChatAttachmentMeta[]): string {
  if (attachments.length === 0) return text;

  const messageText = text.trim() || 'Please use the uploaded files as additional context.';
  const attachmentLines = attachments.map((attachment) => {
    const isImage = attachment.type.startsWith('image/');
    const hint = isImage ? ' [IMAGE -- use the Read tool to view this file]' : '';
    return `- ${attachment.name} (${attachment.type || 'text/plain'}, ${attachment.size} bytes): \`${attachment.path}\`${hint}`;
  });

  return [
    messageText,
    '',
    '# Uploaded context files for this turn',
    'The user attached these files. They have been written into the local sandbox workspace; read them before responding when they are relevant.',
    ...attachmentLines,
  ].join('\n');
}

/**
 * Resolve a key/value map where values may reference environment variables.
 * Values matching "${VAR_NAME}" are replaced with process.env.VAR_NAME at runtime.
 */
function resolveEnvRefs(map: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    const match = value.match(/^\$\{([^}]+)\}$/);
    resolved[key] = match ? (process.env[match[1]] ?? '') : value;
  }
  return resolved;
}

/**
 * Build the mcpServers map for the Cursor SDK agent.
 * Always includes ado-skills; conditionally adds any MCP pill selected for this thread.
 * When `maxviewEnabled` is set, the always-on MaxView timecard-debug MCP proxy is
 * added (gated by the `maxview-mcp` feature flag + server config in the caller).
 * Supports both HTTP and stdio transport (matching the SDK's McpServerConfig union type).
 */
function buildMcpServers(
  kickoff: ChatThreadKickoff,
  adoSkillsUrl: string,
  options?: { maxviewEnabled?: boolean; calendarSessionId?: string },
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  const port = process.env.PORT ?? '3001';

  // Calendar assistant threads use a restricted MCP that only exposes the
  // propose_work_item_changes tool — never the general ado-skills MCP.
  if (kickoff.assistantType === 'calendar-work-item' && options?.calendarSessionId) {
    servers['calendar-assistant'] = {
      url: `http://localhost:${port}/mcp/calendar-assistant/${options.calendarSessionId}`,
    };
    return servers;
  }

  // GitHub-backed projects don't use the ado-skills MCP — skills are pre-fetched server-side
  if (kickoff.skillProvider !== 'github') {
    servers['ado-skills'] = { url: adoSkillsUrl };
  }

  if (kickoff.mcpPill) {
    const pill = kickoff.mcpPill;
    if (pill.transport === 'stdio') {
      servers[pill.mcpServerName] = {
        type: 'stdio',
        command: pill.command,
        ...(pill.args ? { args: pill.args } : {}),
        ...(pill.env ? { env: resolveEnvRefs(pill.env) } : {}),
      };
    } else {
      servers[pill.mcpServerName] = {
        url: pill.url,
        ...(pill.headers ? { headers: resolveEnvRefs(pill.headers) } : {}),
      };
    }
  }

  if (options?.maxviewEnabled) {
    servers['maxview'] = {
      url: `http://localhost:${process.env.PORT ?? 3001}/mcp/maxview`,
    };
  }

  return servers;
}

/**
 * Whether the always-on MaxView timecard-debug MCP should be wired into this
 * thread's agent. Requires both server-side config (env) and the `maxview-mcp`
 * feature flag being enabled for the user/project. Fails closed on any error.
 */
async function isMaxviewMcpEnabled(userId: string, project: string): Promise<boolean> {
  if (!isMaxviewConfigured()) return false;
  try {
    return await isFeatureEnabled('maxview-mcp', { userId, project });
  } catch (err) {
    console.error('[chat] maxview-mcp flag check failed:', (err as Error).message);
    return false;
  }
}

/** System-prompt guidance describing the MaxView timecard-debug MCP tools. */
function buildMaxviewPromptHint(): string {
  return [
    `# MaxView timecard debugging (via \`maxview\` MCP server)`,
    `You have access to the read-only \`maxview\` MCP server for debugging MaxView timecards. Use it whenever the user asks about a specific timecard, its RecruitCare integration, or its status history. All results are PHI/PII-masked and scoped to the service account's data visibility. Available tools:`,
    `- \`get_timecard_detail(timecardId)\` — a single timecard's masked detail (entries, status, hours, presence flags); returns null when not found`,
    `- \`search_timecards(employeeId?, worksiteId?, statusId?, startDate?, endDate?, page?, pageSize?)\` — search timecards (dates default to the last 3 months; pageSize capped at 100)`,
    `- \`get_timecard_integration(timecardId)\` — MaxView↔RecruitCare integration diagnostics (status, blocking reasons, scrubbed errors, field-level match/mismatch flags)`,
    `- \`get_timecard_history(timecardId)\` — status-change history (acting user masked; status, timestamp, comment-presence preserved)`,
    `Always call these tools instead of guessing timecard data. If a lookup returns null, tell the user the timecard was not found.`,
  ].join('\n');
}

function buildScopePolicyLines(kickoff: ChatThreadKickoff): string[] {
  if (kickoff.pillBypassScopePolicy) return [];
  const project = kickoff.project;
  return [
    ``,
    `# Scope policy — STRICTLY ENFORCED`,
    `This assistant exists exclusively to help the ${project} team with internal organisational and project work. You MUST NOT answer questions that have no connection to this project, its codebase, team processes, or org-level work.`,
    ``,
    `Allowed topics:`,
    `- This project's codebase, architecture, code review, or implementation questions`,
    `- Work items, sprint planning, ADO, team processes, and delivery workflows`,
    `- PRDs, design docs, technical specs, and decisions for this project`,
    `- Running or discussing skills from this project's repo`,
    `- Technical concepts directly relevant to the project's stack`,
    ``,
    `Out of scope — REFUSE THESE:`,
    `- General knowledge, trivia, entertainment, news, or public datasets (e.g. movie ratings, housing market trends, stock prices, weather, sports results)`,
    `- Any topic with no plausible connection to ${project} or the organisation`,
    ``,
    `When a question is out of scope, respond with this exact message and nothing else:`,
    `"I can't help with that here. This assistant is scoped to internal project and organisational questions for **${project}**. Please ask about the project codebase, work items, team processes, or technical documentation."`,
    ``,
    `You MAY draw on your training knowledge to give richer answers on in-scope topics (e.g. TypeScript patterns, REST design, testing strategies) — but only when the question is clearly related to this project's work.`,
  ];
}

function buildFreeChatPrompt(kickoff: ChatThreadKickoff): string {
  const branch = kickoff.skillBranch ?? kickoff.branch ?? 'main';
  const isGitHub = kickoff.skillProvider === 'github';
  const repoLabel = isGitHub ? 'GitHub repo' : 'ADO repo';
  const parts: string[] = [
    `# Sandbox workspace`,
    `You are running in an isolated sandbox. The current working directory contains only a \`.ai-pilot/\` scratch folder.`,
    `It is NOT a clone of the project repo. Project files live in the ${repoLabel} and must be fetched via MCP — never search the local filesystem for them.`,
    ``,
    `# Session context`,
    `  project: "${kickoff.project}"`,
    `  repo:    "${kickoff.repo}"`,
    `  branch:  "${branch}"`,
    `  provider: "${kickoff.skillProvider ?? 'ado'}"`,
    ``,
  ];

  if (isGitHub) {
    parts.push(
      `# Mode`,
      `You are the internal project assistant for the **${kickoff.project}** team.`,
      `Skills from this project's GitHub repo are pre-loaded into the conversation by the system when applicable.`,
      ...buildScopePolicyLines(kickoff),
    );
  } else {
    parts.push(
      `# Available MCP tools (via \`ado-skills\` server)`,
      `- \`get_skill\`       — load a SKILL.md from the repo`,
      `- \`list_repo_dir\`   — browse repo directory structure`,
      `- \`get_skill_file\`  — read any file from the repo`,
      `- \`search_repo_code\`— search code in the repo`,
      ``,
      `# Mode`,
      `You are the internal project assistant for the **${kickoff.project}** team.`,
      ``,
      `If the user asks you to run or load a skill (e.g. "run the PRD skill" or "load skill at \`.cursor/skills/to-prd/SKILL.md\`"), call \`get_skill\` with the path they provide and the project/repo/branch above, then follow the skill's procedure.`,
      ``,
      `If the user sends a message like "Run skill: <name> (<path>)", call \`get_skill\` with that path and proceed.`,
      ...buildScopePolicyLines(kickoff),
    );
  }

  if (kickoff.mcpPill) {
    const pill = kickoff.mcpPill;
    parts.push(
      ``,
      `# Additional MCP server: \`${pill.mcpServerName}\``,
      pill.systemPromptHint ?? `You have access to the \`${pill.mcpServerName}\` MCP server. Use its tools to help the user.`,
    );
  }

  if (kickoff.freeformContext) {
    if (kickoff.assistantType === 'prd') {
      // Extract prd_id and thread_id from the freeform context so the agent
      // has them directly in the system prompt — no file-read required.
      const prdIdMatch = kickoff.freeformContext.match(/^prd_id:\s*(\S+)/m);
      const threadIdMatch = kickoff.freeformContext.match(/^thread_id:\s*(\S+)/m);
      const prdId = prdIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
      const threadId = threadIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
      parts.push(
        ``,
        `# PRD session identifiers`,
        `Use these exact values when calling MCP tools — do not guess or substitute them:`,
        `  prd_id:    ${prdId}`,
        `  thread_id: ${threadId}`,
        ``,
        `# PRD context`,
        `The full PRD content, backlog, and review comments have been written to \`.ai-pilot/kickoff-context.md\`.`,
        `Read this file when you need the current PRD text or backlog to answer a question or produce an edit.`,
        ``,
        `# Applying edits — MANDATORY tool use`,
        `When the user asks you to change, update, rewrite, improve, add to, or fix anything in the PRD or backlog:`,
        `1. Read \`.ai-pilot/kickoff-context.md\` to get the current content.`,
        `2. Produce the full updated text for the changed section.`,
        `3. Call \`update_prd\` with the prd_id and thread_id above. Do NOT describe the change without calling the tool.`,
        `   - \`section="content"\` for the PRD narrative (full markdown)`,
        `   - \`section="backlog"\` for the backlog (full JSON string)`,
        `4. After the tool succeeds, confirm briefly what was changed.`,
        ``,
        `# User stories live in the backlog (single ownership)`,
        `User stories are OWNED by the backlog (the \`userStory\` object on each PBI). The PRD does NOT contain an authored "User Stories" section — the PRD view renders stories as a READ-ONLY projection of the backlog PBIs.`,
        `Therefore, to add, change, reword, or remove a user story you MUST call \`update_prd\` with \`section="backlog"\` (NOT \`section="content"\`) and edit the relevant PBI's \`userStory\` (\`persona\`/\`iWant\`/\`soThat\`).`,
        `Never write user stories into the PRD markdown via \`section="content"\` — they would not render and would duplicate the backlog.`,
        `Assumptions are the mirror case: the PRD's \`## Assumptions Made\` section OWNS assumptions; the backlog's \`assumptionsMade\` is just a copy of it.`,
        ``,
        `# Keep PRD content and backlog consistent`,
        `The PRD content (markdown) and the backlog (JSON with epics/features/PBIs) describe the SAME feature, but each field has a single owner — do not duplicate an owned field into the other artifact.`,
        `When a change crosses the ownership line, update the owning artifact:`,
        `- Adding/removing/rewording a user story → edit the backlog PBI's \`userStory\` (section="backlog"). Do NOT touch the PRD markdown for this.`,
        `- Changing narrative (problem, solution, implementation/testing decisions, security, NFRs, feature-flag behavior) → edit the PRD content (section="content").`,
        `- Changing structural detail (epics/features/PBIs/TBIs, acceptance criteria, business rules, dependencies, feature-flag name) → edit the backlog (section="backlog").`,
        `- Editing assumptions → edit the PRD \`## Assumptions Made\` (section="content"); if you also keep the backlog \`assumptionsMade\` in step, mirror the same text via section="backlog".`,
        `- \`userTypes\` / \`personaBehaviors\` belong on Features and PBIs only (for design prototypes). TBIs must NOT have these fields — remove them if present; never add them to TBIs.`,
        `Only call \`update_prd\` for the artifact(s) that actually own the changed field — often a single call is correct.`,
        ``,
        `- \`resolve_prd_comment\` — call this after addressing a review comment to mark it resolved.`,
        `  Pass the \`comment_id\` from the Review Comments section in \`.ai-pilot/kickoff-context.md\`.`,
        ``,
        `# Addressing review comments`,
        `When the user asks you to address comments: read the Review Comments section, revise the relevant content,`,
        `call \`update_prd\`, then call \`resolve_prd_comment\` for each comment addressed.`,
        `Confirm what was changed and which comments were resolved.`,
      );
    } else {
      const docIdMatch = kickoff.freeformContext.match(/^doc_id:\s*(\S+)/m);
      const docThreadIdMatch = kickoff.freeformContext.match(/^thread_id:\s*(\S+)/m);
      const docId = docIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
      const docThreadId = docThreadIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
      parts.push(
        ``,
        `# Design doc session identifiers`,
        `Use these exact values when calling MCP tools:`,
        `  doc_id:    ${docId}`,
        `  thread_id: ${docThreadId}`,
        ``,
        `# Design doc context`,
        `The full design doc content has been written to \`.ai-pilot/kickoff-context.md\`.`,
        `Read this file when you need the current document text to answer a question or produce an edit.`,
        ``,
        `# Applying edits — MANDATORY tool use`,
        `When the user asks you to change, update, rewrite, improve, add to, or fix anything in the document:`,
        `1. Read \`.ai-pilot/kickoff-context.md\` to get the current content.`,
        `2. Produce the full updated text for the changed section.`,
        `3. Call \`update_design_doc\` with the doc_id and thread_id above. Do NOT describe the change without calling the tool.`,
        `   - Call it once per section that needs updating.`,
        `4. After the tool succeeds, confirm briefly what was changed.`,
      );
    }
  }

  if (kickoff.transcript) {
    parts.push(
      ``,
      `# Kickoff transcript`,
      `A prior conversation transcript has been written to \`.ai-pilot/kickoff-transcript.md\`. Read it as additional context.`,
    );
  }

  return parts.join('\n');
}

function buildStandupParticipantPrompt(kickoff: ChatThreadKickoff): string {
  const parts: string[] = [
    `# Standup Ceremony — Participant Session`,
    `You are conducting a daily standup with a team member. Your goal is to help them report on their progress, plans, and blockers relative to upcoming release deadlines.`,
    ``,
    `# Session context`,
    `  project:       "${kickoff.project}"`,
    `  sessionId:     "${kickoff.standupSessionId}"`,
    `  participantId: "${kickoff.standupParticipantId}"`,
    `  teamMember:    "${kickoff.standupUserDisplayName ?? 'the team member'}"`,
    `  memberEmail:   "${kickoff.standupUserEmail ?? '(unknown)'}"`,
    `  threadId:      (use the threadId from .ai-pilot/session.json)`,
    ``,
    `# Available MCP tools`,
    `- \`query_work_items\` — query ADO work items via WIQL. Filter by assignee using their email (ADO uniqueName). Do NOT use @Me (that resolves to the service account, not the member). Do NOT filter by iteration/sprint — this team uses release target dates instead.`,
    `- \`update_work_item\` — update work item fields (state, assignedTo, targetDate, tags, parent, etc.) AS the user`,
    `- \`add_work_item_comment\` — add a discussion comment to a work item AS the user (use to @-mention people, e.g. QA)`,
    `- \`create_work_items\` — create new work items (tasks/bugs/PBIs) AS the user`,
    `- \`get_skill\` / \`get_skill_file\` — load skills/files from the repo`,
    ``,
    `# CRITICAL RULES`,
    `- NEVER delete work items. Only create, update, comment, tag, or re-parent.`,
    `- Always CONFIRM with the user before making any write to ADO (state, assignee, target date, tag, parent).`,
    `- All ADO writes are attributed to the logged-in user via their token.`,
    `- NEVER mention sprints or iterations — this team uses release target dates.`,
    `- Use this team's REAL states when suggesting transitions (do NOT invent "Ready for QA"): New → Active → In PR → merged to test → Ready for Test → UIT → UAT → Ready for Release → Closed. Bugs that fail testing regress to Active (back to the developer). "committed" = accepted but not yet started.`,
    ``,
    `# Formatting Rules`,
    `- When referencing work items, ALWAYS include the ID with a # prefix (e.g. #12345) — this renders as a clickable link in the UI.`,
    `- ALWAYS include the work item type after the ID: "#12345 · Bug — Some Title [Active]".`,
    `- ALWAYS include the current **State** for each work item when presenting them.`,
    `- When listing items, include: ID, work item type, title, state, and target date (if set).`,
    `- Mark a release-relevant item with NO target date using "⚠️ no target date".`,
    `- Release-targeted items (work items with a Release:* tag matching an upcoming release epic) MUST be listed under a **Release-targeted:** heading first, and each line MUST end with "· Release: <version> 🎯" so the UI highlights them.`,
    ``,
    `# Standup Procedure`,
  ];

  if (kickoff.standupSkillPath) {
    parts.push(
      `A custom standup skill has been configured. Load it first:`,
      `  Call \`get_skill\` with path: "${kickoff.standupSkillPath}", project: "${kickoff.project}", repo: "${kickoff.repo}"`,
      `Follow that skill's standup procedure instead of the default below.`,
    );
  } else {
    parts.push(
      `Follow this default standup procedure:`,
      ``,
      `1. **Ground in their work items**: Query all active work items assigned to the member (no sprint filter). Also query items they changed yesterday and release epics (tagged 'ReleaseVersion'). Cross-reference Release:* tags on work items against upcoming release versions.`,
      `   - WIQL for member items: SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.AssignedTo], [Microsoft.VSTS.Scheduling.TargetDate], [System.Tags] FROM WorkItems WHERE [System.AssignedTo] = '${kickoff.standupUserEmail ?? ''}' AND [System.State] <> 'Closed' AND [System.State] <> 'Done' AND [System.State] <> 'Removed' ORDER BY [Microsoft.VSTS.Scheduling.TargetDate] ASC, [Microsoft.VSTS.Common.Priority]`,
      `   - WIQL for yesterday: SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.ChangedDate], [System.AssignedTo], [Microsoft.VSTS.Scheduling.TargetDate], [System.Tags] FROM WorkItems WHERE [System.ChangedBy] = '${kickoff.standupUserEmail ?? ''}' AND [System.ChangedDate] >= @Today - 1 AND [System.ChangedDate] < @Today ORDER BY [System.ChangedDate] DESC`,
      `   - WIQL for releases: SELECT [System.Id], [System.Title], [Microsoft.VSTS.Scheduling.TargetDate], [System.State] FROM WorkItems WHERE [System.WorkItemType] = 'Epic' AND [System.Tags] CONTAINS 'ReleaseVersion' AND [System.State] <> 'Closed' AND [System.State] <> 'Done' ORDER BY [Microsoft.VSTS.Scheduling.TargetDate] ASC`,
      `   - Present yesterday's activity first (with work item type), then today's assignments grouped with release-targeted items first.`,
      `2. **Yesterday (verify, don't just list)**: Present what ADO shows from yesterday, then actively VERIFY the state is correct — a big part of this team's standup is catching items whose state no longer reflects reality. Proactively check for: (a) STALE state — an item sitting in an interim state (In PR, Active, Ready for Test) since yesterday or earlier ("is that still the right status?"); (b) PIPELINE-driven transitions — automated pipelines flip state when builds/tests pass, so if the member says work merged/passed but the state didn't advance, ask whether the pipeline ran and offer to set the state manually; (c) PR vs work-item mismatch — a merged PR but the item still Active/In PR. Offer to advance state using the team's real states.`,
      `3. **Today**: Present current assignments (release-targeted items first), then ask what they plan to work on. FLAG MISSING METADATA: if a release-relevant item has no target date, treat it as an actionable gap and offer to set one. Capture HANDOFFS (if work is moving to someone else, record who it goes to next and offer to update assignedTo). Capture CAPACITY/AVAILABILITY (no work / waiting on external dependency like design or access / available to pick up work; plus PTO or partial-day/off-Friday notes). Check alignment with release deadlines.`,
      `4. **Blockers & risks**: Ask about blockers, distinguishing types since they route differently — PIPELINE/BUILD failures (which pipeline + suspected cause; first-class blockers, not just "stuck"), waiting on a PERSON, waiting on an EXTERNAL dependency (design/access/env/other team), and PRODUCTION SUPPORT/incidents (top priority around a release; capture the item, note the expectation to explain root cause in the dev chat, and offer to create a bug/PBI if none exists). Flag anything that could affect a release target.`,
      `5. **Tagging & QA notification**: Offer team conventions where relevant — for a non-blocking bug that won't make the release, offer to add the deferral tag (e.g. "deferred"/"default") so the parent PBI can sign off, and ALWAYS @-mention QA in a comment when tagging/changing a bug's disposition so they aren't left assuming it's still being fixed. If a bug is really a missed requirement, offer to convert/re-parent it under a PBI (create PBI + update parent link). Confirm before tagging, re-parenting, or reassigning.`,
      `6. **Wrap up**: Summarize the update and confirm if they want any final ADO changes.`,
      ``,
      `After each answer, if the user mentions completing work or changing status, proactively suggest the ADO update and confirm.`,
      ``,
      `When the user is done, produce a structured summary in this JSON format (in a code block):`,
      '```json',
      `{ "yesterday": "...", "today": "...", "blockers": "...", "atRisk": "...", "handoffs": "...", "capacity": "..." }`,
      '```',
      `The "atRisk" field captures items that may miss their release target date (including release-relevant items with no target date or stuck in a stale state). "blockers" should include pipeline failures and production incidents. "handoffs" captures work reassigned to others; "capacity" captures availability/PTO. Leave a field as an empty string if it doesn't apply. This will be extracted by the system as the structured_update.`,
    );
  }

  return parts.join('\n');
}

function buildStandupFacilitatorPrompt(kickoff: ChatThreadKickoff): string {
  const parts: string[] = [
    `# Standup Ceremony — Facilitator`,
    `You are the standup facilitator. Your job is to read all participants' updates for today's session, identify cross-cutting themes, risks, and follow-ups, and produce a session summary.`,
    ``,
    `# Session context`,
    `  sessionId: "${kickoff.standupSessionId}"`,
    ``,
    `# Available MCP tools`,
    `- \`get_standup_session\` — read all participants' structured updates and transcripts`,
    `- \`create_standup_followup\` — create a follow-up item for involved participants`,
    `- \`complete_standup_session\` — finalize the session (persist summary, create follow-up threads, notify members)`,
    `- \`query_work_items\` — check ADO work item details if needed`,
    ``,
    `# Procedure`,
    `1. Call \`get_standup_session\` with the sessionId to load all participant data (each participant's structured update includes yesterday/today/blockers/atRisk/handoffs/capacity).`,
    `2. Analyze updates for these cross-cutting patterns (create a follow-up for each):`,
    `   - **Blockers affecting multiple people** — especially shared pipeline/build failures or a down environment (e.g. one person's dev pipeline failing likely impacts others on the same area).`,
    `   - **Production support / incidents** — these are TOP PRIORITY around a release. Surface them prominently and ensure an owner is identified; note the team expectation to explain the root cause in the dev chat.`,
    `   - **Collaboration & dependencies** — when one member mentions helping another, or work handed off between people (use the "handoffs" field), pair them in a follow-up so the dependency is tracked.`,
    `   - **Unowned / ambiguous items** — a bug or risk that surfaced in the standup but has no clear owner (e.g. "somebody take a look at this") or conflicting ownership. Create a follow-up tagging the candidate owners to resolve who takes it.`,
    `   - **At-risk release items** — items tied to an upcoming release that are stale, blocked, or missing a target date (use the "atRisk" field).`,
    `   - **Process / convention requests** — explicit asks like "tag me when a bug is deferred" or sign-off conventions. Capture these as follow-ups to the relevant people.`,
    `   - **Capacity / availability** — members with idle capacity or who are blocked-and-available, and anyone with PTO/partial days (use the "capacity" field); pair idle capacity with at-risk/unowned work where it makes sense.`,
    `3. For each cross-cutting concern, call \`create_standup_followup\` with the relevant participant user IDs (use the userId values from get_standup_session) and any related work item IDs.`,
    `4. Compose a markdown summary of the standup covering:`,
    `   - Team progress highlights`,
    `   - Production support / incidents (call out first if any — top priority around a release)`,
    `   - Release readiness: at-risk items (stale state, blocked, or missing target date)`,
    `   - Active blockers (including pipeline/build failures and shared environment issues)`,
    `   - Handoffs and collaboration in flight`,
    `   - Capacity / availability (idle capacity, PTO, partial days)`,
    `   - Follow-ups created`,
    `5. Call \`complete_standup_session\` exactly once with the sessionId and your markdown summary. This MUST be your final action — it closes out the session and notifies members.`,
    ``,
    `Also output the final summary as your last message.`,
  ];
  return parts.join('\n');
}

function buildStandupFollowupPrompt(kickoff: ChatThreadKickoff): string {
  const parts: string[] = [
    `# Standup Follow-up Discussion`,
    `This is a follow-up thread created from a standup ceremony. The participants in this thread have been identified as needing to discuss a cross-cutting concern.`,
    ``,
    `# Session context`,
    `  sessionId: "${kickoff.standupSessionId}"`,
    ``,
    `# Your role`,
    `Facilitate a focused discussion on the follow-up topic. Help the participants:`,
    `- Understand the concern identified by the facilitator`,
    `- Discuss potential solutions or next steps`,
    `- Agree on action items`,
    `- Update relevant ADO work items if needed`,
    ``,
    `# Available MCP tools`,
    `- \`query_work_items\` — check work item details`,
    `- \`update_work_item\` — update work items as the user (requires token sync)`,
    `- \`add_work_item_comment\` — comment on work items`,
    ``,
    `Be concise and action-oriented. Keep the discussion focused on resolving the follow-up.`,
  ];
  return parts.join('\n');
}

function buildCalendarWorkItemAssistantPrompt(kickoff: ChatThreadKickoff): string {
  const sessionId = kickoff.calendarAssistantSessionId ?? '(unknown)';
  const threadId = '(read from .ai-pilot/session.json)';
  const anchorId = kickoff.calendarAnchorWorkItemId ?? '(unknown)';
  const selectedIds = (kickoff.calendarSelectedWorkItemIds ?? []).join(', ') || '(none)';

  return [
    `# Calendar Work-Item Assistant`,
    ``,
    `You are an expert technical writer helping to improve Azure DevOps work items.`,
    `Your role is to propose changes to Description and/or Acceptance Criteria for the`,
    `selected work items below. You MUST use the \`propose_work_item_changes\` MCP tool`,
    `to stage your proposals — chat-only descriptions are NOT proposals and will not be applied.`,
    ``,
    `# Session identifiers — use these exact values when calling MCP tools`,
    `  session_id: ${sessionId}`,
    `  thread_id:  ${threadId}`,
    `  anchor_work_item_id: ${anchorId}`,
    `  selected_work_item_ids: [${selectedIds}]`,
    ``,
    `# Work-item context`,
    `The current content of all selected work items has been written to \`.ai-pilot/kickoff-context.md\`.`,
    `Read this file first to understand the current state before proposing any changes.`,
    ``,
    `# Editable fields`,
    `- **Description** — supported for Epic, Feature, PBI, and TBI`,
    `- **Acceptance Criteria** — supported for Epic, Feature, and PBI only`,
    ``,
    `# What you may propose`,
    `- Improve clarity, completeness, or consistency of Description and/or Acceptance Criteria`,
    `- Add missing Given/When/Then acceptance criteria for PBIs/Features`,
    `- Align child items with the parent Epic's updated description`,
    `- Only propose for work items in the selected_work_item_ids list above`,
    ``,
    `# What you must NOT do`,
    `- Do NOT claim that changes have been applied — they have not been written to ADO until the user reviews and confirms`,
    `- Do NOT propose changes to fields other than Description and Acceptance Criteria`,
    `- Do NOT call \`update_work_item\` — that tool is not available in this assistant`,
    `- Do NOT propose for work items outside the selected_work_item_ids list`,
    ``,
    `# Applying your proposals — MANDATORY tool use`,
    `When you have decided on changes for one or more items:`,
    `1. Read \`.ai-pilot/kickoff-context.md\` to confirm the current content.`,
    `2. Compose the full replacement text for each changed field (Markdown).`,
    `3. Call \`propose_work_item_changes\` with session_id and thread_id from above.`,
    `   Each item entry must include the work_item_id and an array of field changes.`,
    `4. After the tool succeeds, briefly tell the user which items were staged and`,
    `   that they will see a diff review panel to approve or reject each change.`,
    ``,
    `# Available MCP tool`,
    `- \`propose_work_item_changes\` — stage Description/AC proposals for review (no ADO writes)`,
    ``,
    `# Content constraints`,
    `- Write in clear, professional language suitable for an engineering team`,
    `- Use Markdown: bold (**text**), unordered lists (- item), inline code (\`text\`)`,
    `- For Acceptance Criteria use Given/When/Then format where appropriate`,
    `- Keep each field under 64 KB`,
    ...buildScopePolicyLines(kickoff),
  ].join('\n');
}

function buildInitialPrompt(kickoff: ChatThreadKickoff): string {
  if (kickoff.assistantType === 'calendar-work-item') {
    return buildCalendarWorkItemAssistantPrompt(kickoff);
  }
  if (kickoff.mode === 'standup-participant') {
    return buildStandupParticipantPrompt(kickoff);
  }
  if (kickoff.mode === 'standup-facilitator') {
    return buildStandupFacilitatorPrompt(kickoff);
  }
  if (kickoff.mode === 'standup-followup') {
    return buildStandupFollowupPrompt(kickoff);
  }
  if (kickoff.mode === 'development') {
    return buildDevelopmentPrompt(kickoff);
  }
  if (!kickoff.skillPath) {
    return buildFreeChatPrompt(kickoff);
  }

  const branch = kickoff.skillBranch ?? kickoff.branch ?? 'main';
  const isGitHub = kickoff.skillProvider === 'github';
  const parts: string[] = [
    `# Sandbox`,
    `You are running in an isolated sandbox workspace. The current working directory contains ONLY a \`.ai-pilot/\` scratch folder for kickoff inputs and final outputs.`,
    isGitHub
      ? `Repo files (CONTEXT.md, AGENTS.md, sibling skills, schemas, ADRs, etc.) are NOT on the local filesystem — they live in the GitHub repo.`
      : `Repo files (CONTEXT.md, AGENTS.md, sibling skills, schemas, ADRs, etc.) are NOT on the local filesystem — they live in the ADO repo and must be fetched via the \`ado-skills\` MCP server. Do not search the local filesystem for them.`,
    ``,
  ];

  if (isGitHub) {
    parts.push(
      ...buildScopePolicyLines(kickoff),
      ``,
      `# Your task`,
      `The skill content has been pre-loaded below. Follow its instructions exactly and completely.`,
    );
  } else {
    parts.push(
      `# MCP tools (ado-skills server)`,
      `- \`get_skill\`        — load a SKILL.md from the repo`,
      `- \`list_repo_dir\`    — browse repo directory structure`,
      `- \`get_skill_file\`   — read any file from the repo`,
      `- \`search_repo_code\` — search code in the repo`,
      ...buildScopePolicyLines(kickoff),
      ``,
      `# Your task`,
      `Call \`get_skill\` with the following parameters to load the skill:`,
      `  project: "${kickoff.project}"`,
      `  repo:    "${kickoff.repo}"`,
      `  path:    "${kickoff.skillPath}"`,
      `  branch:  "${branch}"`,
      ``,
    );
  }

  parts.push(
    ``,
    `Then follow the skill's instructions exactly and completely. The skill defines everything:`,
    `which repo files to load, how to interact with the user, what to produce, and when to produce it.`,
    `Do not add steps, skip steps, or modify the skill's behavior in any way.`,
    ``,
    `When the skill instructs you to write output files, write them to \`.ai-pilot/output/\``,
    `using the exact filenames the skill specifies.`,
    ``,
    `IMPORTANT: Always use the built-in file writing tool (Write / create_file) to create output files.`,
    `Do NOT use shell commands, Python scripts, echo/cat redirection, or any other indirect method to write files.`,
    `File writes via shell/Python may silently fail in this environment.`,
    ``,
    `# UI rendering — interactive questions`,
    `This chat has an interactive question UI. When you ask the user a multiple-choice question:`,
    ``,
    `1. Format each option as \`a. text\`, \`b. text\`, etc. on its own line — the UI renders these as clickable buttons the user can select.`,
    `2. **Ask only ONE question per message.** After presenting a question, STOP and wait for the user's answer before continuing. Do NOT batch multiple questions into a single response.`,
    `3. You may include context, analysis, or trade-offs BEFORE the question in the same message, but the message must end with exactly one set of options.`,
    `4. After receiving an answer, acknowledge it, incorporate it into your thinking, then ask the next question. The user's answers may change which questions you ask next.`,
    `5. You do NOT have an AskQuestion tool — format questions directly in your text output using the \`a. text\` pattern described above.`,
  );

  if (kickoff.transcript) {
    parts.push(
      ``,
      `# Kickoff transcript`,
      `A prior conversation transcript has been written to \`.ai-pilot/kickoff-transcript.md\`.`,
      `Read it as input context before executing the skill. Follow the skill's own instructions`,
      `for how to use prior context.`,
    );
  }

  if (kickoff.freeformContext) {
    parts.push(
      ``,
      `# Additional context`,
      `Additional user-provided context has been written to \`.ai-pilot/kickoff-context.md\`. Read it as well.`,
    );
  }

  if (kickoff.mcpPill) {
    const pill = kickoff.mcpPill;
    parts.push(
      ``,
      `# Additional MCP server: \`${pill.mcpServerName}\``,
      pill.systemPromptHint ?? `You have access to the \`${pill.mcpServerName}\` MCP server. Use its tools when helpful.`,
    );
  }

  return parts.join('\n');
}

function buildDevelopmentPrompt(kickoff: ChatThreadKickoff): string {
  const branch = kickoff.skillBranch ?? kickoff.branch ?? 'main';
  const isGitHub = kickoff.skillProvider === 'github';
  const hasApexPath = !!(kickoff as any).prdId; // Apex PRD-sourced session
  const parts: string[] = [
    `# Development workspace`,
    `You are running in a REAL repository checkout. The current working directory IS a git clone of the project repo. The feature branch has already been created and checked out — you are on it now.`,
    ``,
    `# Session context`,
    `  project: "${kickoff.project}"`,
    `  repo:    "${kickoff.repo}"`,
    `  branch:  "${branch}"`,
    `  provider: "${kickoff.skillProvider ?? 'ado'}"`,
    `  work item: ${kickoff.workItemId ?? '(none)'}`,
    ``,
  ];

  if (isGitHub) {
    parts.push(
      `# Repo access`,
      `Skills from this project's GitHub repo are pre-loaded into the conversation by the system when applicable.`,
      ``,
    );
  } else {
    parts.push(
      `# Available MCP tools (via \`ado-skills\` server)`,
      `- \`get_skill\`        — load a SKILL.md from the repo`,
      `- \`list_repo_dir\`    — browse repo directory structure`,
      `- \`get_skill_file\`   — read any file from the repo`,
      `- \`search_repo_code\` — search code in the repo`,
      `- \`query_work_items\` — query ADO work items`,
      ``,
    );
  }

  parts.push(...buildScopePolicyLines(kickoff), ``);

  if (hasApexPath) {
    // Apex PRD-sourced path: full design context injected by injectDevContextFiles
    parts.push(
      `# Pre-loaded design context`,
      `The following design artifacts have been injected into \`.ai-pilot/output/\` in this workspace:`,
      `- **PRD markdown** — \`{slug}.prd.md\``,
      `- **Backlog JSON** — \`{slug}.backlog.json\` (epics, features, PBIs, TBIs, dependsOn, parallelGroup)`,
      `- **Test cases** — \`{slug}.test-cases.json\` (verification targets per PBI)`,
      `- **Design spec** — \`{slug}-design-spec/{feature-slug}-design.md\``,
      `- **Tech spec** — \`{slug}-design-spec/{feature-slug}-tech-spec.md\``,
      `- **Assumptions** — \`{slug}-design-spec/{feature-slug}-assumptions.md\``,
      ``,
      `Read these files first — they define WHAT to build, architectural decisions, API contracts,`,
      `data models, component structures, and test expectations. The tech spec is your primary`,
      `implementation guide. Respect the dependency graph in the backlog (item \`dependsOn\` and`,
      `\`parallelGroup\` fields) to determine execution order.`,
      ``,
    );
  } else {
    // ADO path: design-doc attachments injected by injectAdoAttachments at session setup
    parts.push(
      `# Design context`,
      `The following design artifacts have been injected into \`.ai-pilot/output/\` in this workspace:`,
      `- **Design spec** — \`{slug}-design-spec/design.md\``,
      `- **Tech spec** — \`{slug}-design-spec/tech-spec.md\``,
      `- **Assumptions** — \`{slug}-design-spec/assumptions.md\``,
      `- **Prototype** — \`{slug}-design-spec/prototype.html\` (if present)`,
      `- **PRD placeholder** — \`{slug}.prd.md\``,
      `Read these first — they define the feature's scope, architecture, API contracts, and test targets.`,
      ``,
    );
  }

  if (kickoff.skillPath) {
    // Skill configured: hand off governance entirely to the project dev skill.
    parts.push(
      `# APEX → Project → APEX governance`,
      `APEX has already handled all git setup:`,
      `- Cloned the repo at \`${branch}\``,
      `- Created and checked out the feature branch (this is where you are now)`,
      `- Injected the design artifacts above`,
      ``,
      `Your role is to follow the project development skill exactly. Load it now, then follow ALL of its phases —`,
      `including scope confirmation (Phase 0.5), plan (Phase 1 — STOP for human approval), implement (Phase 2),`,
      `and code review (Step 5).`,
      ``,
      `CRITICAL: Do NOT write any source code until the human explicitly approves the Phase 1 plan.`,
      ``,
      `CRITICAL — APEX SDK file-write constraint: You are running inside the APEX Cursor SDK agent runtime.`,
      `ALL file edits MUST be made directly by you in the current working directory.`,
      `Do NOT use the Task tool to dispatch sub-agents for file writes — sub-agent file changes run in`,
      `isolated SDK processes that are NOT written to the session workspace, so they will be invisible to`,
      `APEX's diff, push, and PR flow. You may still use the execution lanes from the plan to structure`,
      `the implementation order, but work through each lane yourself, directly, one file at a time.`,
      `You MAY use Task sub-agents for read-only work (research, code review) — just not for writing files.`,
      ``,
      `APEX owns all git operations after you finish: committing, pushing, opening PRs, ADO state transitions.`,
      `You must NOT run git commit, git push, git branch, or open pull requests.`,
      ``,
      `# Development skill`,
      `Load it now:`,
    );
    if (isGitHub) {
      parts.push(`The skill content will be pre-loaded below by the system.`);
    } else {
      parts.push(
        `  Call \`get_skill\` with path: "${kickoff.skillPath}", project: "${kickoff.project}", repo: "${kickoff.repo}", branch: "${branch}"`,
      );
    }
    parts.push(`Follow the skill's instructions exactly, starting from Phase 0.`);
  } else {
    // No skill configured: minimal direct-implement fallback.
    parts.push(
      `# Your task`,
      `No development skill is configured for this project. Implement the feature using the design artifacts above.`,
      `Read the design spec and tech spec in \`.ai-pilot/output/\` first, then implement the required changes.`,
      ``,
      `# Important constraints`,
      `- This IS a real repo checkout — you can read any project file directly from disk.`,
      `- Do NOT run \`git push\`, \`git commit\`, create branches, or open pull requests — APEX owns those steps.`,
      `- Write clean, production-quality code. Follow existing project conventions in the codebase.`,
    );
  }

  return parts.join('\n');
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────

function broadcast(state: ThreadState, event: SseEvent) {
  for (const cb of state.subscribers) {
    try { cb(event); } catch { /* subscriber gone */ }
  }
}

// ── Idle cleanup ──────────────────────────────────────────────────────────────

function resetIdleTimer(state: ThreadState) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  // Don't start the idle timer while a run is active — the timer will be reset
  // in the run's finally block. Starting it now could fire closeThread mid-run.
  if (state.thread.status === 'running') return;
  const timeout = state.isInterviewThread ? INTERVIEW_IDLE_TIMEOUT_MS
    : state.isDevSession ? INTERVIEW_IDLE_TIMEOUT_MS  // dev sessions get 2-hour window
    : IDLE_TIMEOUT_MS;
  state.idleTimer = setTimeout(() => closeThread(state.thread.id), timeout);
}

async function checkIsInterviewThread(threadId: string): Promise<boolean> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, threadId),
    columns: { id: true },
  });
  return row !== undefined;
}

/**
 * Returns a label (e.g. "prd", "design_doc") if this thread is referenced by
 * a PRD or design doc row, or null if it's a standalone chat thread.
 *
 * Used by closeThread to avoid deleting the chat_threads row when an
 * ON DELETE CASCADE FK would silently destroy the parent document.
 */
async function threadBacksDocument(threadId: string): Promise<string | null> {
  const prdRow = await db.query.prds.findFirst({
    where: eq(prds.chatThreadId, threadId),
    columns: { id: true },
  });
  if (prdRow) return 'prd';

  const ddRow = await db.query.designDocs.findFirst({
    where: or(
      eq(designDocs.chatThreadId, threadId),
      eq(designDocs.docAssistantThreadId, threadId),
      eq(designDocs.validationThreadId, threadId),
    ),
    columns: { id: true },
  });
  if (ddRow) return 'design_doc';

  return null;
}

/**
 * Return live ThreadState from memory, or hydrate from Postgres (e.g. after server restart).
 */
async function ensureThreadState(threadId: string): Promise<ThreadState | null> {
  const existing = threads.get(threadId);
  if (existing) return existing;

  const thread = await loadThread(threadId);
  if (!thread) return null;

  // A thread persisted as 'running' means the server was killed mid-run.
  // Reset it to 'idle' so the client input isn't permanently locked out.
  if (thread.status === 'running') {
    thread.status = 'idle';
    thread.activeRunId = undefined;
  }

  // Recreate the sandbox workspace if it was wiped (e.g. OS temp cleanup on
  // reboot, or the stale-workspace cleanup pass). Without this, Agent.resume /
  // Agent.create would fail because its cwd no longer exists, and a resumed
  // interview would silently produce no agent output.
  if (thread.workspaceDir && !fs.existsSync(thread.workspaceDir)) {
    try {
      fs.mkdirSync(thread.workspaceDir, { recursive: true });
      injectKickoffFiles(thread.workspaceDir, thread.kickoff, thread.id);
    } catch (err) {
      console.error(
        '[chat] failed to recreate workspace for thread',
        threadId,
        ':',
        (err as Error).message,
      );
    }
  }

  const isInterview = await checkIsInterviewThread(threadId);

  const state: ThreadState = {
    thread,
    subscribers: new Set(),
    agent: null,
    idleTimer: null,
    isInterviewThread: isInterview,
    isDevSession: thread.kickoff?.mode === 'development',
  };
  threads.set(threadId, state);
  resetIdleTimer(state);
  return state;
}

/**
 * Load a thread into memory (from Postgres) so that resolveOutputDir and
 * readOutput* helpers can locate its workspace.  Used by startup recovery
 * to re-hydrate threads whose watchers were lost during a restart.
 */
export async function hydrateThread(threadId: string): Promise<boolean> {
  const state = await ensureThreadState(threadId);
  return state !== null;
}

/**
 * Returns true if the thread exists in memory and its agent is NOT running.
 * Used by startup recovery to decide whether to re-kick a dead agent.
 */
export function isThreadIdle(threadId: string): boolean {
  const state = threads.get(threadId);
  if (!state) return false;
  return state.thread.status !== 'running';
}

// ── Health stats ──────────────────────────────────────────────────────────────

export interface AgentHealthStats {
  status: 'ok';
  threads: {
    total: number;
    byStatus: Record<string, number>;
    withActiveAgent: number;
  };
  uptime: number;
}

export function getAgentHealthStats(): AgentHealthStats {
  let withActiveAgent = 0;
  const byStatus: Record<string, number> = {};

  for (const state of threads.values()) {
    const s = state.thread.status;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    if (state.agent !== null) withActiveAgent++;
  }

  return {
    status: 'ok',
    threads: {
      total: threads.size,
      byStatus,
      withActiveAgent,
    },
    uptime: Math.floor(process.uptime()),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createThread(
  userId: string,
  kickoff: ChatThreadKickoff,
  options?: { skipAutoKickoff?: boolean; kickoffMessage?: string; workspaceDirOverride?: string },
): Promise<ChatThread> {
  ensureDirs();

  const threadId = uuidv4();
  const workspaceDir = options?.workspaceDirOverride ?? path.join(WORKSPACE_BASE, threadId);

  // Resolve branch
  const branch = kickoff.branch ?? 'main';
  const resolvedKickoff = { ...kickoff, branch };

  if (!options?.workspaceDirOverride) {
    fs.mkdirSync(workspaceDir, { recursive: true });
    injectKickoffFiles(workspaceDir, resolvedKickoff, threadId);
  }

  const thread: ChatThread = {
    id: threadId,
    userId,
    kickoff: resolvedKickoff,
    messages: [],
    status: 'idle',
    workspaceDir,
    flagged: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };

  const state: ThreadState = {
    thread,
    subscribers: new Set(),
    agent: null,
    idleTimer: null,
    isInterviewThread: false,
    isDevSession: thread.kickoff?.mode === 'development',
  };

  threads.set(threadId, state);
  await pgUpsertThread(thread);
  resetIdleTimer(state);

  // Auto-kickoff: start the skill when the client will not send a first message right away
  // (e.g. skill slug only, or modal/panel open). If skipAutoKickoff is set, the client POSTs
  // the real first message next so the transcript shows the user request before the agent.
  if (!options?.skipAutoKickoff) {
    const msg = options?.kickoffMessage ?? 'Begin.';
    setImmediate(() => {
      console.log('[chat] auto-kickoff firing', { threadId, skillPath: kickoff.skillPath });
      sendMessage(threadId, msg, undefined, [], { hidden: true }).then(() => {
        console.log('[chat] auto-kickoff completed', { threadId });
      }).catch((err: Error) => {
        console.error('[chat] Auto-kickoff failed for thread', threadId, ':', err.message);
      });
    });
  }

  return thread;
}

/**
 * Replace the freeformContext stored in a thread's kickoff with an updated
 * version. Used by the PRD / design-doc assistant routes to swap out the
 * `__THREAD_ID__` placeholder that was passed to createThread (before the real
 * ID was known) with the actual thread UUID, so the system prompt contains the
 * correct thread_id when the agent first runs.
 */
export function updateThreadKickoffContext(threadId: string, freeformContext: string): void {
  const state = threads.get(threadId);
  if (!state) return;
  state.thread.kickoff = { ...state.thread.kickoff, freeformContext };
  persistThread(state.thread);
}

/**
 * Mark an in-memory thread as interview-backed, extending its idle timeout.
 * Call this after linking a thread to an interviews row so the longer timeout
 * takes effect immediately (without waiting for a server-restart hydration).
 */
export function markAsInterviewThread(threadId: string): void {
  const state = threads.get(threadId);
  if (!state || state.isInterviewThread) return;
  state.isInterviewThread = true;
  resetIdleTimer(state);
}

export async function getThread(threadId: string): Promise<ChatThread | null> {
  return (await ensureThreadState(threadId))?.thread ?? null;
}

/** Alias kept for backward compatibility with callers that imported the explicitly async name. */
export const getThreadAsync = getThread;

export async function listThreadSummaries(
  userId: string,
  opts?: { limit?: number; offset?: number; project?: string },
): Promise<ChatThreadSummary[]> {
  return pgListThreadsByUser(userId, opts);
}

export function listThreads(userId: string): ChatThread[] {
  return Array.from(threads.values())
    .map((s) => s.thread)
    .filter((t) => t.userId === userId)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

export function subscribeToThread(
  threadId: string,
  callback: (event: SseEvent) => void,
): () => void {
  // Only check the in-memory map (sync). The thread is guaranteed to be
  // loaded by requireThreadOwner middleware before this is called.
  const state = threads.get(threadId);
  if (!state) return () => {};
  state.subscribers.add(callback);
  return () => state.subscribers.delete(callback);
}

const DEFAULT_MODEL = 'composer-2';

function resolveModelId(model?: string): string {
  return model?.trim() || DEFAULT_MODEL;
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/**
 * Classify a run-level error string as fatal (no point resuming the agent)
 * vs recoverable (transient — keep cursorAgentId for Agent.resume next send).
 */
export function isFatalRunError(resultText: string): boolean {
  const lower = resultText.toLowerCase();
  return /\b(auth(entication|orization)?|unauthorized|forbidden|invalid.{0,20}(key|token|credential|config|agent)|agent.{0,10}not.found)\b/.test(lower);
}

/** Detect transient SDK / network errors worth retrying. */
export function isTransientSdkError(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('already has active run')) return false;

  const statusCode = (err as any)?.statusCode || (err as any)?.status;
  if (statusCode === 401 || statusCode === 403) return false;
  if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) return false;
  if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) return true;

  if (err instanceof Error) {
    const code = (err as any).code;
    if (typeof code === 'string' && /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|ECONNREFUSED)$/.test(code)) {
      return true;
    }
  }

  return false;
}

/** Detect recoverable errors: stale run, agent disposed, concurrent run conflicts. */
export function isRecoverableSdkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return /already has active run|stale.*run|agent.*disposed|run.*expired|agent.*not.*available/.test(msg);
}

/**
 * Detect fatal SDK errors: auth failures, invalid config, agent not found.
 * Unlike `isFatalRunError` which checks run result text, this checks thrown exceptions.
 */
export function isFatalSdkError(err: unknown): boolean {
  const statusCode = (err as any)?.statusCode || (err as any)?.status;
  if (statusCode === 401 || statusCode === 403) return true;

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return /\b(auth(entication|orization)?|unauthorized|forbidden|invalid.{0,20}(key|token|credential|config|agent)|agent.{0,10}not.found)\b/.test(msg);
  }
  return false;
}

export type ErrorTier = 'transient' | 'recoverable' | 'fatal';

export function classifyError(err: unknown): ErrorTier {
  if (isFatalSdkError(err)) return 'fatal';
  if (isRecoverableSdkError(err)) return 'recoverable';
  if (isTransientSdkError(err)) return 'transient';
  // After retries are exhausted, unclassified CursorAgentErrors default to fatal;
  // unknown errors default to transient (user can retry).
  if (err instanceof CursorAgentError) return 'fatal';
  return 'transient';
}

export function isRateLimitError(err: unknown): boolean {
  const statusCode = (err as any)?.statusCode || (err as any)?.status;
  if (statusCode === 429) return true;
  if (err instanceof Error) {
    return /rate.?limit|too many requests/i.test(err.message);
  }
  return false;
}

export function mapErrorCode(tier: ErrorTier, err: unknown): SseErrorCode {
  if (isRateLimitError(err)) return 'rate_limit';
  switch (tier) {
    case 'transient':
      return 'transient';
    case 'recoverable':
      return 'transient';
    case 'fatal':
      return isFatalSdkError(err) && isAuthError(err) ? 'auth' : 'fatal';
  }
}

export function isAuthError(err: unknown): boolean {
  const statusCode = (err as any)?.statusCode || (err as any)?.status;
  if (statusCode === 401 || statusCode === 403) return true;
  if (err instanceof Error) {
    return /\b(auth(entication|orization)?|unauthorized|forbidden)\b/i.test(err.message);
  }
  return false;
}

function logAgentError(threadId: string, err: unknown): void {
  if (err instanceof Error) {
    console.error(`[chat] Agent failed for thread ${threadId}:`, {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: (err as any).cause,
      retryable: (err as any).isRetryable,
    });
    trackAgentError(threadId, err);
    return;
  }

  console.error(`[chat] Agent failed for thread ${threadId}:`, err);
  trackAgentError(threadId, err);
}

/**
 * After an agent run completes, sync workspace output files directly to Postgres
 * by looking up which entity (PRD or design doc) owns this thread.
 */
async function syncOutputToDb(threadId: string, workspaceDir: string, agentText?: string): Promise<void> {
  let fullySynced = false;

  // Check if this thread belongs to a test-case generation run
  const testCaseRow = await db.query.testCases.findFirst({
    where: eq(testCases.chatThreadId, threadId),
  });
  if (testCaseRow) {
    const synced = await syncTestCaseOutput(testCaseRow.id, testCaseRow.prdId, threadId);
    if (!synced && testCaseRow.status === 'generating') {
      logWorkspaceContents(workspaceDir, `test-case no-output (testCaseId=${testCaseRow.id})`);
      if (agentText) {
        const preview = agentText.length > 5000 ? agentText.slice(0, 5000) + '…' : agentText;
        console.warn(`[chat] test-case agent response (${agentText.length} chars) preview (testCaseId=${testCaseRow.id}):\n${preview}`);
      }
      await markTestCaseFailed(testCaseRow.id, testCaseRow.prdId, threadId);
      console.warn(`[chat] post-run: test-case agent produced no output — marked failed (testCaseId=${testCaseRow.id})`);
    }
    return;
  }

  // Check if this thread belongs to a PRD
  const prdRow = await db.query.prds.findFirst({
    where: eq(prds.chatThreadId, threadId),
  });
  if (prdRow) {
    const content = readOutputPrd(threadId);
    const backlog = readOutputBacklog(threadId);
    if (content) {
      await syncPrdContent(prdRow.id, content, backlog ?? undefined);
      console.log(`[chat] post-run: synced PRD output to DB (prdId=${prdRow.id})`);
      notifyAiCompletion('prd_generated', prdRow.id, { title: prdRow.title }).catch(err =>
        console.error(`[chat] AI notification failed for prd_generated (prdId=${prdRow.id}):`, err),
      );
      fullySynced = content !== null && backlog !== null;
    } else if (prdRow.status === 'generating') {
      logWorkspaceContents(workspaceDir, `PRD no-output (prdId=${prdRow.id})`);
      await db.update(prds)
        .set({ status: 'draft', updatedAt: new Date().toISOString() })
        .where(and(eq(prds.id, prdRow.id), eq(prds.status, 'generating')));
      console.warn(`[chat] post-run: agent produced no PRD output — reset to draft (prdId=${prdRow.id})`);
    }
    if (fullySynced) {
      try {
        const testCaseStarted = await triggerTestCaseGeneration(prdRow.id, threadId);
        if (!testCaseStarted) {
          // If no test case skill, check if PRD validation can start
          try {
            const { arePrdValidationArtifactsReady, autoStartPrdValidation } = await import('./prdService');
            const ready = await arePrdValidationArtifactsReady(prdRow.id);
            if (ready) await autoStartPrdValidation(prdRow.id);
          } catch { /* non-fatal */ }
          cleanupWorkspaceDir(workspaceDir);
        }
      } catch (err) {
        console.error(`[chat] post-run: auto test-case generation failed (prdId=${prdRow.id})`, err);
        cleanupWorkspaceDir(workspaceDir);
      }
    }
    return;
  }

  // Check if this thread belongs to a design doc (generation thread)
  const ddGenRow = await db.query.designDocs.findFirst({
    where: eq(designDocs.chatThreadId, threadId),
    columns: { id: true, prdId: true, project: true, authorId: true, designPrototypeId: true },
  });
  if (ddGenRow) {
    if (ddGenRow.designPrototypeId) {
      // Prototype-linked single-feature doc — update the existing row. The watcher
      // may have already handled this; finalizeSingleFeatureDoc is idempotent.
      const { finalizeSingleFeatureDoc } = await import('./designDocService');
      await finalizeSingleFeatureDoc(ddGenRow.id, threadId, ddGenRow.project);
      console.log(`[chat] post-run: finalised prototype-linked design doc (designDocId=${ddGenRow.id})`);
    } else {
      // Legacy multi-feature or direct-from-PRD seed doc — fan out to child rows.
      await syncPerFeatureDesignDocs(ddGenRow.id, ddGenRow.prdId, ddGenRow.project, ddGenRow.authorId, threadId);
      console.log(`[chat] post-run: synced per-feature design docs to DB (prdId=${ddGenRow.prdId})`);
    }
    return;
  }

  // Fallback: the watcher may have nulled chatThreadId prematurely while the
  // agent was still running. If the workspace has feature triplets, look for
  // the seed doc in generating status (chatThreadId=NULL) and sync the features.
  const orphanFeatures = readAllOutputDesignDocFeatures(threadId);
  if (orphanFeatures.length > 0) {
    const seedRow = await db.query.designDocs.findFirst({
      where: and(eq(designDocs.status, 'generating'), isNull(designDocs.chatThreadId)),
      columns: { id: true, prdId: true, project: true, authorId: true },
    });
    if (seedRow) {
      await syncPerFeatureDesignDocs(seedRow.id, seedRow.prdId, seedRow.project, seedRow.authorId, threadId);
      console.log(`[chat] post-run: synced ${orphanFeatures.length} orphan features to DB (seedDocId=${seedRow.id})`);
      return;
    }
  }

  // Check if this thread is a validation thread
  const ddValRow = await db.query.designDocs.findFirst({
    where: eq(designDocs.validationThreadId, threadId),
  });
  if (ddValRow) {
    const scorecardRaw = readOutputValidationScorecard(threadId);
    if (scorecardRaw) {
      try {
        // Re-verify thread ownership — another validation may have started
        const freshDoc = await db.query.designDocs.findFirst({
          where: eq(designDocs.id, ddValRow.id),
          columns: { validationThreadId: true },
        });
        if (freshDoc?.validationThreadId !== threadId) {
          console.log(`[chat] post-run: discarded stale validation scorecard — thread ${threadId} no longer active (designDocId=${ddValRow.id})`);
          cleanupWorkspaceDir(workspaceDir);
          return;
        }
        const scorecard = JSON.parse(scorecardRaw) as ValidationScorecard;
        const reportMd = readOutputValidationScorecardMd(threadId) ?? undefined;
        await syncValidationResult(ddValRow.id, scorecard, reportMd);
        console.log(`[chat] post-run: synced validation scorecard to DB (designDocId=${ddValRow.id})`);
        fullySynced = true;
      } catch (err) {
        console.error(`[chat] post-run: failed to parse validation scorecard`, err);
      }
    } else {
      // Agent completed but wrote no scorecard file.
      // Keep the generated content accessible by moving to pending_review (matching the
      // watcher's own idle-without-scorecard path). The approval gate will still require a
      // valid validation score if a skill is configured — this just unblocks the author
      // from seeing and reviewing the content rather than hiding it in a Draft state.
      const freshDoc = await db.query.designDocs.findFirst({
        where: eq(designDocs.id, ddValRow.id),
        columns: { validationThreadId: true, status: true },
      });
      if (freshDoc?.validationThreadId === threadId && freshDoc?.status === 'validating') {
        await db.update(designDocs)
          .set({ status: 'pending_review', updatedAt: new Date().toISOString() })
          .where(eq(designDocs.id, ddValRow.id));
        console.warn(`[chat] post-run: validation agent wrote no scorecard — moved to pending_review (designDocId=${ddValRow.id})`);
      }
      fullySynced = true; // workspace can be cleaned
    }
    if (fullySynced) cleanupWorkspaceDir(workspaceDir);
    return;
  }

  // Check if this thread is a doc assistant thread (used by fix-validation and "Ask Apex")
  const ddAssistantRow = await db.query.designDocs.findFirst({
    where: eq(designDocs.docAssistantThreadId, threadId),
  });
  if (ddAssistantRow) {
    // The fix-validation flow uses MCP tool calls to save content in real-time,
    // but as a fallback, check if output workspace files exist and sync them.
    const design = readOutputDesignDoc(threadId);
    const techSpec = readOutputTechSpec(threadId);
    const assumptions = readOutputAssumptions(threadId);
    if (design || techSpec || assumptions) {
      const syncOpts: Parameters<typeof syncDesignDocContent>[1] = {};
      if (design) syncOpts.designContent = design;
      if (techSpec) syncOpts.techSpecContent = techSpec;
      if (assumptions) syncOpts.assumptionsContent = assumptions;
      await syncDesignDocContent(ddAssistantRow.id, syncOpts);
      console.log(`[chat] post-run: synced doc-assistant output to DB (designDocId=${ddAssistantRow.id})`);
    }
    return;
  }

  // Check if this thread is a PRD validation thread
  const prdValRow = await db.query.prds.findFirst({
    where: eq(prds.validationThreadId, threadId),
  });
  if (prdValRow) {
    const scorecardRaw = readOutputValidationScorecard(threadId);
    if (scorecardRaw) {
      try {
        const freshPrd = await db.query.prds.findFirst({
          where: eq(prds.id, prdValRow.id),
          columns: { validationThreadId: true },
        });
        if (freshPrd?.validationThreadId !== threadId) {
          console.log(`[chat] post-run: discarded stale PRD validation scorecard — thread ${threadId} no longer active (prdId=${prdValRow.id})`);
          cleanupWorkspaceDir(workspaceDir);
          return;
        }
        const scorecard = JSON.parse(scorecardRaw) as ValidationScorecard;
        const reportMd = readOutputValidationScorecardMd(threadId) ?? undefined;
        const { generateFallbackReport } = await import('./documentValidationService');
        const effectiveReportMd = reportMd ?? generateFallbackReport(scorecard);
        const newStatus = scorecard.is_ready ? 'pending_review' : 'draft';
        await db.update(prds)
          .set({
            validationScore: Math.round(scorecard.overall_score),
            validationScorecard: scorecard,
            validationPhase: scorecard.review_phase,
            validationReportMd: effectiveReportMd,
            status: newStatus,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(prds.id, prdValRow.id));
        console.log(`[chat] post-run: synced PRD validation scorecard to DB (prdId=${prdValRow.id})`);
        fullySynced = true;
      } catch (err) {
        console.error(`[chat] post-run: failed to parse PRD validation scorecard`, err);
      }
    } else {
      const freshPrd = await db.query.prds.findFirst({
        where: eq(prds.id, prdValRow.id),
        columns: { validationThreadId: true, status: true },
      });
      if (freshPrd?.validationThreadId === threadId && freshPrd?.status === 'validating') {
        await db.update(prds)
          .set({ status: 'draft', updatedAt: new Date().toISOString() })
          .where(eq(prds.id, prdValRow.id));
        console.warn(`[chat] post-run: PRD validation agent wrote no scorecard, reset to draft (prdId=${prdValRow.id})`);
      }
      fullySynced = true;
    }
    if (fullySynced) cleanupWorkspaceDir(workspaceDir);
    return;
  }

}

function cleanupWorkspaceDir(workspaceDir: string): void {
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    console.log(`[chat] post-run: cleaned up workspace ${workspaceDir}`);
  } catch { /* non-fatal */ }
}

/**
 * Reset any PRD or design doc stuck in 'generating' status for this thread
 * back to 'draft'. Called when the agent run throws before syncOutputToDb
 * can run, so the document doesn't stay in a generating limbo forever.
 */
async function failGeneratingDocuments(threadId: string): Promise<void> {
  const [prdResult] = await db.update(prds)
    .set({ status: 'draft', updatedAt: new Date().toISOString() })
    .where(and(eq(prds.chatThreadId, threadId), eq(prds.status, 'generating')))
    .returning({ id: prds.id });

  if (prdResult) {
    console.warn(`[chat] failGeneratingDocuments: reset PRD to draft (prdId=${prdResult.id}, threadId=${threadId})`);
  }

  const [ddResult] = await db.update(designDocs)
    .set({ status: 'generation_failed', generationError: 'Agent run failed before output was written', updatedAt: new Date().toISOString() })
    .where(and(eq(designDocs.chatThreadId, threadId), eq(designDocs.status, 'generating')))
    .returning({ id: designDocs.id });

  if (ddResult) {
    console.warn(`[chat] failGeneratingDocuments: marked design doc generation_failed (designDocId=${ddResult.id}, threadId=${threadId})`);
  }

  const [testCaseResult] = await db.update(testCases)
    .set({ status: 'failed', updatedAt: new Date().toISOString() })
    .where(and(eq(testCases.chatThreadId, threadId), eq(testCases.status, 'generating')))
    .returning({ id: testCases.id });

  if (testCaseResult) {
    console.warn(`[chat] failGeneratingDocuments: marked test cases failed (testCaseId=${testCaseResult.id}, threadId=${threadId})`);
  }
}

/**
 * After an agent run completes, check if the thread backs a dev session.
 * If so, commit any uncommitted changes and push the branch to remote
 * so the work survives ephemeral workspace loss (app restarts, scaling).
 * Also caches the diff in the DB for the changes panel.
 */
async function eagerPushDevSession(
  threadId: string,
  kickoff: ChatThreadKickoff,
): Promise<void> {
  const session = await db.query.devSessions.findFirst({
    where: eq(devSessions.chatThreadId, threadId),
  });
  if (!session || !session.branchName) return;
  if (session.branchPushed) return;
  if (session.status !== 'in_progress') return;

  const { computeDiff, pushBranch, getWorkspaceDir } = await import('./repoCheckoutService');
  const { resolveGitRemote } = await import('./repoCacheService');
  const workspaceDir = getWorkspaceDir(session.id);

  if (!fs.existsSync(workspaceDir)) return;

  const { diffText, changedFiles } = await computeDiff(workspaceDir);

  // Always cache the diff (even when empty) so UI doesn't show stale data
  await db
    .update(devSessions)
    .set({
      cachedDiffText: diffText,
      cachedChangedFiles: changedFiles,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(devSessions.id, session.id));

  if (changedFiles.length === 0) return;

  // Push branch to remote
  try {
    const remote = resolveGitRemote(
      kickoff.skillProvider ?? 'ado',
      kickoff.project,
      kickoff.repo,
    );
    await pushBranch(workspaceDir, session.branchName, remote);
    await db
      .update(devSessions)
      .set({ branchPushed: true, updatedAt: new Date().toISOString() })
      .where(eq(devSessions.id, session.id));
    console.log(`[chat] eager push succeeded for dev session ${session.id}, branch ${session.branchName}`);
  } catch (pushErr) {
    console.warn(`[chat] eager push to remote failed (non-fatal) for session ${session.id}:`, (pushErr as Error).message);
  }
}

export async function sendMessage(
  threadId: string,
  text: string,
  modelOverride?: string,
  attachments: ChatAttachment[] = [],
  options?: { hidden?: boolean },
): Promise<void> {
  const state = await ensureThreadState(threadId);
  if (!state) throw new Error(`Thread ${threadId} not found`);
  console.log('[chat] sendMessage', { threadId, status: state.thread.status });
  if (state.thread.status === 'running') throw new Error('Agent is already running');

  const baseApiKey = process.env.CURSOR_API_KEY;
  if (!baseApiKey) throw new Error('CURSOR_API_KEY is not set');

  // Resolve per-project service-account key if configured (shared fallback otherwise)
  let apiKey = baseApiKey;
  try {
    const { resolveSkillConfig } = await import('./projectSettingsService');
    const project = state.thread.kickoff?.project;
    if (project) {
      const cfg = await resolveSkillConfig({ project });
      const envRef = (cfg as any)?.cursorApiKeyEnvRef as string | null | undefined;
      if (envRef) {
        const match = envRef.match(/^\$\{([^}]+)\}$/);
        const resolved = match ? (process.env[match[1]] ?? '') : envRef;
        if (resolved) apiKey = resolved;
      }
    }
  } catch {
    // Non-fatal — fall back to shared key
  }

  // If the caller wants a different model, dispose the current agent so it
  // will be recreated (or resumed) with the new model on this turn.
  const resolvedModel = resolveModelId(modelOverride ?? state.thread.kickoff.model);
  if (state.thread.kickoff.model !== resolvedModel) {
    state.thread.kickoff.model = resolvedModel;
    if (state.agent) {
      await state.agent[Symbol.asyncDispose]().catch(() => {});
      state.agent = null;
    }
  }

  const mcpServerUrl = `http://localhost:${process.env.PORT ?? 3001}/mcp/ado-skills`;
  const maxviewEnabled = await isMaxviewMcpEnabled(state.thread.userId, state.thread.kickoff.project);
  const calendarSessionId = state.thread.kickoff.assistantType === 'calendar-work-item'
    ? (state.thread.kickoff.calendarAssistantSessionId ?? undefined)
    : undefined;
  const mcpServers = buildMcpServers(state.thread.kickoff, mcpServerUrl, { maxviewEnabled, calendarSessionId });
  console.log('[chat] MCP servers for turn:', Object.keys(mcpServers).join(', '), {
    maxviewEnabled,
    maxviewConfigured: isMaxviewConfigured(),
  });

  const turnId = uuidv4();
  const attachmentMeta = await writeMessageAttachments(state.thread.workspaceDir, turnId, attachments);
  const promptText = buildPromptWithAttachments(text, attachmentMeta);

  // Record the user message
  const userMsg: ChatMessage = {
    id: turnId,
    role: 'user',
    text: text.trim() || 'Uploaded files for context.',
    ts: new Date().toISOString(),
    attachments: attachmentMeta.length > 0 ? attachmentMeta : undefined,
    ...(options?.hidden ? { hidden: true } : {}),
  };
  state.thread.messages.push(userMsg);
  state.thread.lastActivityAt = userMsg.ts;
  broadcast(state, { type: 'message', message: userMsg });
  await pgInsertMessage(threadId, userMsg);

  // Update status
  state.thread.status = 'running';
  broadcast(state, { type: 'status', status: 'running' });
  persistThread(state.thread);
  resetIdleTimer(state);

  // Build initial prompt on first turn
  const isFirstTurn = !state.thread.cursorAgentId;
  let prompt: string;
  if (isFirstTurn) {
    let initialPrompt = buildInitialPrompt(state.thread.kickoff);

    // For GitHub-backed projects with a skill path, pre-fetch the skill content
    // and inject it directly into the system prompt (no MCP round-trip needed)
    if (state.thread.kickoff.skillProvider === 'github' && state.thread.kickoff.skillPath) {
      try {
        const { getSkillFile } = await import('./skillCatalogFacade');
        const resolvedSkillBranch = state.thread.kickoff.skillBranch ?? state.thread.kickoff.branch;
        const skillContent = await getSkillFile(
          state.thread.kickoff.project,
          state.thread.kickoff.repo,
          state.thread.kickoff.skillPath,
          resolvedSkillBranch,
          'github',
        );
        initialPrompt += `\n\n# Pre-loaded skill content (${state.thread.kickoff.skillPath})\n\n${skillContent}`;
      } catch (err) {
        console.error('[chat] Failed to pre-fetch GitHub skill:', (err as Error).message);
        initialPrompt += `\n\n# Skill pre-fetch failed\nCould not load skill from GitHub: ${(err as Error).message}. Inform the user.`;
      }
    }

    if (maxviewEnabled) {
      initialPrompt += `\n\n${buildMaxviewPromptHint()}`;
    }

    prompt = `${initialPrompt}\n\n---\n\n${promptText}`;
  } else {
    prompt = promptText;
  }

  let agentRunId: string | undefined;
  let backgroundHeartbeatId: ReturnType<typeof setInterval> | null = null;

  try {
    // Create or resume the agent (retry up to 3x on transient errors)
    const sdkRetryOpts = { maxRetries: 3, initialDelay: 1000, shouldRetry: isTransientSdkError, jitter: true } as const;

    const codeReviewerAgent = {
      description:
        'Rigorous MaxView code reviewer. Reviews changed files against MaxView layer boundaries, coding standards, existing-code protection rules, and the approved design spec. Every finding must cite a specific rule file, design-doc section, or repo path.',
      prompt:
        `You are a senior engineer reviewing a MaxView feature implementation. Your job:\n` +
        `1. Read the MaxView repo rules from .cursor/rules/ (especially backend-layer-boundaries.mdc, coding-standards.mdc, existing-code-protection.mdc, testing-standards.mdc, typescript-typecheck.mdc, ui-design-standards.mdc).\n` +
        `2. Read AGENTS.md and CONTEXT.md for project context.\n` +
        `3. Review the diff provided against those rules and the design docs in .ai-pilot/output/.\n` +
        `4. For every finding: cite the specific rule file / design-doc section / repo path. Do NOT produce generic advice.\n` +
        `5. Group findings by severity: Must-fix, Should-fix, Nice-to-have.\n` +
        `6. Format: [Severity] Title — File:lines — Snippet — Suggested change (as diff) — Reason.\n` +
        `Be thorough but only flag real violations. If no issues, say so explicitly.`,
      model: { id: 'claude-opus-4-6' },
    };

    if (!state.agent) {
      if (state.thread.cursorAgentId) {
        // Agent.resume accepts Partial<AgentOptions>, which includes agents.
        state.agent = await retryWithBackoff(
          () => Agent.resume(state.thread.cursorAgentId!, {
            apiKey,
            model: { id: resolvedModel },
            local: { cwd: state.thread.workspaceDir },
            mcpServers,
            agents: { 'code-reviewer': codeReviewerAgent },
          }),
          sdkRetryOpts,
        );
      } else {
        state.agent = await retryWithBackoff(
          () => Agent.create({
            apiKey,
            model: { id: resolvedModel },
            local: { cwd: state.thread.workspaceDir },
            mcpServers,
            agents: { 'code-reviewer': codeReviewerAgent },
          }),
          sdkRetryOpts,
        );
      }
    }

    const agent = state.agent;
    // Send the prompt (retry up to 2x on transient errors)
    const run = await retryWithBackoff(
      () => agent.send(prompt),
      { ...sdkRetryOpts, maxRetries: 2 },
    );

    trackEvent('agent.run.started', {
      threadId,
      model: resolvedModel,
      isInterview: String(state.isInterviewThread),
    });

    // Persist agent + run IDs immediately before streaming
    state.thread.cursorAgentId = agent.agentId ?? state.thread.cursorAgentId;
    state.thread.activeRunId = (run as any).id;
    persistThread(state.thread);

    // ── Insert agent_runs record as 'queued', then atomically claim it ──────
    const runTimeoutMs = state.isDevSession ? INTERVIEW_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
    const runTimeoutAt = new Date(Date.now() + runTimeoutMs).toISOString();
    agentRunId = state.thread.activeRunId ?? threadId;
    await db.insert(agentRuns).values({
      id: agentRunId,
      threadId,
      status: 'queued',
      timeoutAt: runTimeoutAt,
    }).onConflictDoNothing();

    // Atomic lease claim: only one worker transitions queued → running
    const [claimed] = await db.update(agentRuns)
      .set({
        status: 'running',
        ownerInstance: os.hostname(),
        heartbeatAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(agentRuns.id, agentRunId), eq(agentRuns.status, 'queued')))
      .returning({ id: agentRuns.id });

    if (!claimed) {
      // Another worker already claimed this run — do not double-execute.
      // The SSE route will pick up tokens via LISTEN/NOTIFY from the owner.
      console.log(`[chat] Run ${agentRunId} already claimed by another worker, skipping execution`);
      state.thread.status = 'running';
      state.thread.activeRunId = agentRunId;
      persistThread(state.thread);
      return;
    }

    const MAX_RUN_RETRIES = 2;
    let currentRun = run;
    let agentTextBuffer = '';
    let lastHeartbeatMs = Date.now();
    const HEARTBEAT_INTERVAL_MS = 10_000;

    // Shared heartbeat helper — call from any event handler that can run > 90s
    // without emitting text tokens (thinking phases, tool_use, long tool_call waits).
    // agentRunId is always assigned before this function is ever called.
    const bumpHeartbeat = async (): Promise<void> => {
      if (Date.now() - lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) return;
      lastHeartbeatMs = Date.now();
      const runId = agentRunId!;
      const [runRow] = await db.update(agentRuns)
        .set({ heartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
        .returning({ status: agentRuns.status });
      if (!runRow) {
        const cancelledRow = await db.query.agentRuns.findFirst({
          where: eq(agentRuns.id, runId),
          columns: { status: true },
        });
        if (cancelledRow?.status === 'cancelled') {
          console.log(`[chat] Run ${runId} cancelled by another worker, aborting stream`);
          throw Object.assign(new Error('Run cancelled'), { _cancelled: true });
        }
      }
    };

    // Background heartbeat — bumps every 30s unconditionally so long thinking
    // phases that emit no stream events don't trigger the reaper's expiry threshold.
    backgroundHeartbeatId = setInterval(() => {
      lastHeartbeatMs = 0; // force bumpHeartbeat to fire regardless of rate limit
      bumpHeartbeat().catch(() => {});
    }, 30_000);

    for (let attempt = 0; attempt <= MAX_RUN_RETRIES; attempt++) {
      agentTextBuffer = '';

      // Stream tokens and tool calls — wrapped in try/catch for stream-level failures
      if (currentRun.supports('stream')) {
        try {
          for await (const event of currentRun.stream()) {
            if (event.type === 'assistant') {
              for (const block of event.message.content) {
                if (block.type === 'text') {
                  agentTextBuffer += block.text;
                  broadcast(state, { type: 'token', text: block.text });
                  notifyRunEvent(threadId, { type: 'token', data: block.text }).catch(() => {});
                  await bumpHeartbeat();
                }
                if (block.type === 'tool_use') {
                  // Snapshot reasoning text accumulated before this tool call
                  if (agentTextBuffer.trim()) {
                    const reasoningMsg: ChatMessage = {
                      id: uuidv4(),
                      role: 'agent',
                      text: agentTextBuffer.trim(),
                      ts: new Date().toISOString(),
                      toolName: '_reasoning',
                    };
                    state.thread.messages.push(reasoningMsg);
                    broadcast(state, { type: 'message', message: reasoningMsg });
                    pgInsertMessage(threadId, reasoningMsg).catch(() => {});
                    agentTextBuffer = '';
                  }

                  const toolMsg: ChatMessage = {
                    id: uuidv4(),
                    role: 'tool',
                    text: `→ ${block.name}`,
                    toolName: block.name,
                    toolInput: block.input as Record<string, unknown>,
                    ts: new Date().toISOString(),
                  };
                  state.thread.messages.push(toolMsg);
                  broadcast(state, { type: 'tool_call', toolName: block.name, input: block.input });
                  broadcast(state, { type: 'message', message: toolMsg });
                  pgInsertMessage(threadId, toolMsg).catch(() => {});
                  notifyRunEvent(threadId, { type: 'tool_call', data: { toolName: block.name } }).catch(() => {});
                  await bumpHeartbeat();
                }
              }
            } else if (event.type === 'thinking') {
              const thinkingText = (event as any).text ?? '';
              if (thinkingText) {
                const thinkingMsg: ChatMessage = {
                  id: uuidv4(),
                  role: 'agent',
                  text: thinkingText,
                  ts: new Date().toISOString(),
                  toolName: '_thinking',
                };
                state.thread.messages.push(thinkingMsg);
                broadcast(state, { type: 'message', message: thinkingMsg });
                pgInsertMessage(threadId, thinkingMsg).catch(() => {});
              }
              broadcast(state, {
                type: 'thinking',
                text: thinkingText,
                durationMs: (event as any).thinking_duration_ms,
              });
              await bumpHeartbeat();
            } else if (event.type === 'tool_call') {
              const tc = event as any;
              broadcast(state, {
                type: 'tool_status',
                toolName: tc.name ?? '',
                callId: tc.call_id ?? '',
                status: tc.status ?? 'running',
                args: tc.args,
                result: typeof tc.result === 'string' ? tc.result?.slice(0, 500) : undefined,
              });
            }
          }
        } catch (streamErr) {
          if (attempt < MAX_RUN_RETRIES && isTransientSdkError(streamErr)) {
            console.warn(`[chat] Stream error on attempt ${attempt + 1}/${MAX_RUN_RETRIES + 1} for thread ${threadId}, retrying…`, describeError(streamErr));
            broadcast(state, { type: 'retrying', attempt: attempt + 1, maxAttempts: MAX_RUN_RETRIES + 1 });

            if (state.agent) {
              await state.agent[Symbol.asyncDispose]().catch(() => {});
              state.agent = null;
            }
            if (state.thread.cursorAgentId) {
              state.agent = await retryWithBackoff(
                () => Agent.resume(state.thread.cursorAgentId!, {
                  apiKey,
                  model: { id: resolvedModel },
                  local: { cwd: state.thread.workspaceDir },
                  mcpServers,
                }),
                sdkRetryOpts,
              );
              currentRun = await state.agent.send(prompt);
              state.thread.activeRunId = (currentRun as any).id;
              continue;
            }
          }
          throw streamErr;
        }
      }

      const result = await currentRun.wait();

      if (result.status === 'error') {
        const reason = result.result?.trim() || 'Agent run failed — you can retry your last message.';

        if (attempt < MAX_RUN_RETRIES && !isFatalRunError(reason)) {
          console.warn(`[chat] Run error on attempt ${attempt + 1}/${MAX_RUN_RETRIES + 1} for thread ${threadId}, retrying…`, reason);
          broadcast(state, { type: 'retrying', attempt: attempt + 1, maxAttempts: MAX_RUN_RETRIES + 1 });

          if (state.agent) {
            await state.agent[Symbol.asyncDispose]().catch(() => {});
            state.agent = null;
          }
          if (state.thread.cursorAgentId) {
            state.agent = await retryWithBackoff(
              () => Agent.resume(state.thread.cursorAgentId!, {
                apiKey,
                model: { id: resolvedModel },
                local: { cwd: state.thread.workspaceDir },
                mcpServers,
              }),
              sdkRetryOpts,
            );
            currentRun = await state.agent.send(prompt);
            state.thread.activeRunId = (currentRun as any).id;
            continue;
          }
        }

        console.error(`[chat] Agent run returned error status for thread ${threadId}:`, result.result ?? '(no detail)', { model: state.thread.kickoff.model });
        trackAgentError(threadId, new Error(reason), { model: state.thread.kickoff?.model ?? 'unknown' });
        state.thread.lastError = reason;
        // Mark agent run as failed in Postgres
        await db.update(agentRuns)
          .set({ status: 'failed', lastError: reason?.slice(0, 2000), updatedAt: new Date().toISOString() })
          .where(eq(agentRuns.id, agentRunId))
          .execute()
          .catch((e) => console.error('[chat] Failed to mark agent run failed (in-loop):', e));
        broadcast(state, { type: 'error', error: reason });
        if (state.agent) {
          await state.agent[Symbol.asyncDispose]().catch(() => {});
          state.agent = null;
        }
        if (isFatalRunError(reason)) {
          state.thread.cursorAgentId = undefined;
        }
        state.thread.activeRunId = undefined;
        state.thread.status = 'idle';
        broadcast(state, { type: 'status', status: 'idle' });
        break;
      }

      // Run succeeded
      if (agentTextBuffer) {
        const agentMsg: ChatMessage = {
          id: uuidv4(),
          role: 'agent',
          text: agentTextBuffer,
          ts: new Date().toISOString(),
        };
        state.thread.messages.push(agentMsg);
        broadcast(state, { type: 'message', message: agentMsg });
        await pgInsertMessage(threadId, agentMsg);
      } else if (state.thread.kickoff?.mode === 'development') {
        const fallbackMsg: ChatMessage = {
          id: uuidv4(),
          role: 'agent',
          text: 'Agent run completed. Review the diff panel to see what changed — if more work is needed, send a follow-up message.',
          ts: new Date().toISOString(),
        };
        state.thread.messages.push(fallbackMsg);
        broadcast(state, { type: 'message', message: fallbackMsg });
        await pgInsertMessage(threadId, fallbackMsg);
      }

      state.thread.status = 'idle';
      broadcast(state, { type: 'status', status: 'idle' });
      trackEvent('agent.run.completed', { threadId, model: resolvedModel });

      // Record usage event (fire-and-forget, never blocks)
      {
        const kickoff = state.thread.kickoff ?? {} as import('../../shared/types/chat').ChatThreadKickoff;
        const inputEst = estimateTokens(text ?? '');
        const outputEst = estimateTokens(agentTextBuffer ?? '');
        recordAiUsage({
          provider: 'cursor',
          modelId: resolvedModel,
          feature: resolveFeatureFromKickoff(kickoff),
          project: kickoff.project ?? 'unknown',
          skillPath: kickoff.skillPath ?? undefined,
          threadId,
          runId: agentRunId ?? undefined,
          workItemId: kickoff.workItemId != null ? String(kickoff.workItemId) : undefined,
          userId: state.thread.userId ?? undefined,
          inputTokens: inputEst,
          outputTokens: outputEst,
          tokenSource: 'estimated',
          costUsd: 0,
          costSource: 'estimated',
          status: 'success',
        });
      }

      break;
    }

    const prdContent = readOutputPrd(threadId);
    const backlogContent = readOutputBacklog(threadId);
    const prdReady = prdContent !== null;
    const backlogReady = backlogContent !== null;

    // Sync output artifacts directly to Postgres
    try {
      await syncOutputToDb(threadId, state.thread.workspaceDir, agentTextBuffer);
    } catch (err) {
      console.error(`[chat] post-run DB sync failed for thread ${threadId}:`, err);
    }

    // Eagerly push dev-session branches to remote so they survive workspace loss
    try {
      await eagerPushDevSession(threadId, state.thread.kickoff);
    } catch (err) {
      console.warn(`[chat] eager dev-session push failed (non-fatal) for thread ${threadId}:`, (err as Error).message);
    }

    // Mark agent run as completed in Postgres BEFORE broadcasting done
    await db.update(agentRuns)
      .set({ status: 'completed', updatedAt: new Date().toISOString() })
      .where(eq(agentRuns.id, agentRunId))
      .execute()
      .catch((e) => console.error('[chat] Failed to mark agent run completed:', e));

    broadcast(state, { type: 'done', runId: state.thread.activeRunId, prdReady, backlogReady });
    notifyRunEvent(threadId, { type: 'done', data: { status: 'completed', prdReady, backlogReady } }).catch(() => {});
    state.thread.activeRunId = undefined;
  } catch (err: any) {
    // Handle cross-worker cancellation without treating it as an error
    if (err?._cancelled) {
      if (state.agent) {
        await state.agent[Symbol.asyncDispose]().catch(() => {});
        state.agent = null;
      }
      state.thread.status = 'idle';
      state.thread.activeRunId = undefined;
      broadcast(state, { type: 'status', status: 'idle' });
      broadcast(state, { type: 'done' });
      persistThread(state.thread);
      return;
    }

    logAgentError(threadId, err);

    const tier = classifyError(err);
    const rawMsg = describeError(err);
    console.error(`[chat] Error tier=${tier} for thread ${threadId}:`, rawMsg);
    trackAgentError(threadId, err, { tier, model: state.thread.kickoff?.model ?? 'unknown' });

    if (state.agent) {
      await state.agent[Symbol.asyncDispose]().catch(() => {});
      state.agent = null;
    }

    switch (tier) {
      case 'transient': {
        // Retries exhausted — let user retry manually. Keep cursorAgentId for Agent.resume.
        state.thread.lastError = rawMsg;
        state.thread.activeRunId = undefined;
        state.thread.status = 'idle';
        break;
      }
      case 'recoverable': {
        // Stale run / agent disposed / concurrent run — clear run state, keep cursorAgentId
        // unless it's a stale-run conflict (agent still owns a run we can't cancel).
        const isStaleRun = err instanceof Error && err.message.includes('already has active run');
        state.thread.lastError = isStaleRun
          ? 'A previous run is still active on the agent. Please try again.'
          : rawMsg;
        if (isStaleRun) {
          state.thread.cursorAgentId = undefined;
        }
        state.thread.activeRunId = undefined;
        state.thread.status = 'idle';
        break;
      }
      case 'fatal': {
        // Auth / config / agent-not-found — require user/admin action.
        state.thread.lastError = rawMsg;
        state.thread.cursorAgentId = undefined;
        state.thread.activeRunId = undefined;
        state.thread.status = 'error';
        break;
      }
    }

    const errorCode = mapErrorCode(tier, err);
    trackEvent('agent.run.errored', { threadId, errorTier: tier, errorCode, model: resolvedModel });

    // Record error usage event (fire-and-forget)
    {
      const kickoff = state.thread?.kickoff ?? {} as import('../../shared/types/chat').ChatThreadKickoff;
      recordAiUsage({
        provider: 'cursor',
        modelId: resolvedModel,
        feature: resolveFeatureFromKickoff(kickoff),
        project: kickoff.project ?? 'unknown',
        skillPath: kickoff.skillPath ?? undefined,
        threadId,
        runId: agentRunId ?? undefined,
        userId: state.thread?.userId ?? undefined,
        inputTokens: 0,
        outputTokens: 0,
        tokenSource: 'estimated',
        costUsd: 0,
        costSource: 'estimated',
        status: 'error',
      });
    }

    // Mark agent run as failed in Postgres BEFORE broadcasting error
    if (agentRunId) {
      await db.update(agentRuns)
        .set({ status: 'failed', lastError: rawMsg?.slice(0, 2000), updatedAt: new Date().toISOString() })
        .where(eq(agentRuns.id, agentRunId))
        .execute()
        .catch((e) => console.error('[chat] Failed to mark agent run failed:', e));
    }

    broadcast(state, { type: 'error', error: state.thread.lastError ?? 'Unknown error', errorCode });
    broadcast(state, { type: 'done' });
    notifyRunEvent(threadId, { type: 'done', data: { status: 'failed', error: state.thread.lastError } }).catch(() => {});

    try {
      await failGeneratingDocuments(threadId);
    } catch (fgErr) {
      console.error(`[chat] failGeneratingDocuments failed for thread ${threadId}:`, fgErr);
    }
  } finally {
    if (backgroundHeartbeatId !== null) {
      clearInterval(backgroundHeartbeatId);
      backgroundHeartbeatId = null;
    }
    state.thread.lastActivityAt = new Date().toISOString();
    persistThread(state.thread);
    resetIdleTimer(state);
  }
}

export async function cancelRun(threadId: string): Promise<void> {
  const state = await ensureThreadState(threadId);
  if (!state) return;

  const activeRunId = state.thread.activeRunId;
  if (!activeRunId) return;

  // Mark cancelled in Postgres — works from any worker
  await db.update(agentRuns)
    .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
    .where(eq(agentRuns.id, activeRunId))
    .execute()
    .catch((e) => console.error('[chat] Failed to mark agent run cancelled:', e));

  // NOTIFY all workers (the owner will check for cancel and abort its loop)
  notifyRunEvent(threadId, { type: 'cancel' }).catch(() => {});

  // If this IS the owner worker, cancel the SDK run directly
  if (state.agent) {
    try {
      const run = await (Agent as any).getRun(activeRunId, { runtime: 'local', cwd: state.thread.workspaceDir });
      if (run.supports('cancel')) await run.cancel();
    } catch {
      // Best-effort cancel
    }
  }

  state.thread.status = 'idle';
  state.thread.activeRunId = undefined;
  broadcast(state, { type: 'status', status: 'idle' });
  broadcast(state, { type: 'done' });
  persistThread(state.thread);
}

export async function closeThread(threadId: string): Promise<void> {
  const state = await ensureThreadState(threadId);
  if (!state) return;

  if (state.idleTimer) clearTimeout(state.idleTimer);

  if (state.agent) {
    await state.agent[Symbol.asyncDispose]().catch(() => {});
    state.agent = null;
  }

  // For dev sessions with unpushed changes: evict from memory (free resources)
  // but leave the thread status as-is (idle) and preserve the workspace.
  // This lets users log out, navigate away, or hit the idle timeout and then
  // return to find their session intact and the textarea still enabled.
  if (state.thread.kickoff?.mode === 'development') {
    const session = await db.query.devSessions.findFirst({
      where: eq(devSessions.chatThreadId, threadId),
      columns: { status: true, branchPushed: true },
    });
    if (session) {
      const isActive = session.status === 'in_progress' || session.status === 'setting_up' || session.status === 'conflict';
      const hasUnpushed = !session.branchPushed;
      if (isActive || hasUnpushed) {
        console.log(`[chat] Dev session thread ${threadId}: evicting from memory (idle timeout), keeping workspace and thread status intact (unpushed changes)`);
        threads.delete(threadId);
        return;
      }
    }
  }

  // Persist status=closed so history survives idle eviction and server restarts.
  state.thread.status = 'closed';
  await pgUpsertThread(state.thread);

  threads.delete(threadId);

  try {
    fs.rmSync(state.thread.workspaceDir, { recursive: true, force: true });
  } catch { /* non-fatal */ }
}

/**
 * Permanently delete a thread from memory, workspace, AND PostgreSQL.
 * Only used for explicit user-initiated deletion (DELETE route).
 */
export async function permanentlyDeleteThread(threadId: string): Promise<void> {
  const state = await ensureThreadState(threadId);

  if (state) {
    if (state.idleTimer) clearTimeout(state.idleTimer);

    if (state.agent) {
      await state.agent[Symbol.asyncDispose]().catch(() => {});
      state.agent = null;
    }

    threads.delete(threadId);

    try {
      fs.rmSync(state.thread.workspaceDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }

  await pgDeleteThread(threadId);
}

function resolveOutputDir(threadId: string): string | null {
  const state = threads.get(threadId);
  if (state) return path.join(state.thread.workspaceDir, '.ai-pilot', 'output');
  return null;
}

/**
 * Read the output PRD from the ephemeral workspace.
 */
export function readOutputPrd(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const named = findOutputFile(outputDir, /\.prd\.md$/i);
  if (named) return fs.readFileSync(named, 'utf-8');
  const legacy = path.join(outputDir, 'PRD.md');
  return fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf-8') : null;
}

/**
 * Returns true if a PRD output file exists in the ephemeral workspace.
 * Cheaper than readOutputPrd — does not read file contents.
 */
export function isPrdReady(threadId: string): boolean {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return false;
  const named = findOutputFile(outputDir, /\.prd\.md$/i);
  if (named) return true;
  return fs.existsSync(path.join(outputDir, 'PRD.md'));
}

/**
 * Read the output backlog JSON from the ephemeral workspace.
 */
export function readOutputBacklog(threadId: string): unknown | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /\.backlog\.json$/i);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}


/**
 * Read the main design doc output ({feature-slug}-design.md) from the ephemeral workspace.
 * Returns the first matching file (used by Q&A / validation threads which operate on a single doc).
 */
export function readOutputDesignDoc(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /[-.]design\.md$/i);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

/**
 * Read the tech spec output ({feature-slug}-tech-spec.md) from the ephemeral workspace.
 * Returns the first matching file (used by Q&A / validation threads which operate on a single doc).
 */
export function readOutputTechSpec(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /[-.]tech-spec\.md$/i);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

/**
 * Read the assumptions output ({feature-slug}-assumptions.md) from the ephemeral workspace.
 * Returns the first matching file (used by Q&A / validation threads which operate on a single doc).
 */
export function readOutputAssumptions(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /[-.]assumptions\.md$/i);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

/**
 * Read all per-feature design doc output sets from the ephemeral workspace.
 * Returns one entry per feature for which all three files (design, tech-spec, assumptions)
 * are present. Results are sorted alphabetically by slug.
 */
export function readAllOutputDesignDocFeatures(
  threadId: string,
): Array<{ slug: string; design: string; techSpec: string; assumptions: string }> {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return [];

  const designFiles = findAllOutputFiles(outputDir, /[-.]design\.md$/i);
  const results: Array<{ slug: string; design: string; techSpec: string; assumptions: string }> = [];

  for (const designFile of designFiles) {
    const slug = path.basename(designFile).replace(/[-.]design\.md$/i, '');
    const techSpecFile = designFile.replace(/[-.]design\.md$/i, '-tech-spec.md');
    const assumptionsFile = designFile.replace(/[-.]design\.md$/i, '-assumptions.md');

    if (!fs.existsSync(techSpecFile) || !fs.existsSync(assumptionsFile)) continue;

    try {
      results.push({
        slug,
        design: fs.readFileSync(designFile, 'utf-8').trim(),
        techSpec: fs.readFileSync(techSpecFile, 'utf-8').trim(),
        assumptions: fs.readFileSync(assumptionsFile, 'utf-8').trim(),
      });
    } catch { /* skip unreadable files */ }
  }

  return results;
}

/**
 * Read the human-readable validation scorecard (review-scorecard.md) from the ephemeral workspace.
 */
export function readOutputValidationScorecardMd(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const found = findOutputFile(outputDir, /review-scorecard\.md$/);
  return found ? fs.readFileSync(found, 'utf-8') : null;
}

/**
 * Read the validation scorecard (review-scorecard.json) from the ephemeral workspace.
 */
export function readOutputValidationScorecard(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const found = findOutputFile(outputDir, /review-scorecard\.json$/);
  return found ? fs.readFileSync(found, 'utf-8') : null;
}
