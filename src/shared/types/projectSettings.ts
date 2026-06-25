import type { ApprovalMode } from './approvals';
import type { GroupWithMembers } from './groups';

/**
 * Configuration for a Quick MCP Pill — a home-page shortcut that wires an
 * external MCP server into the chat agent for the duration of a thread.
 *
 * Supports both transport types that the Cursor SDK accepts:
 *   - "http"  — a hosted MCP endpoint reachable via URL (e.g. mcp.twilio.com)
 *   - "stdio" — a local/installed CLI package spawned as a child process (e.g. npx sendgrid-mcp)
 *
 * For stdio, env values stored here are the raw values (not references); the
 * server resolves them from process.env at runtime so secrets stay out of the DB.
 * Use "${VAR_NAME}" syntax and the server will substitute process.env.VAR_NAME.
 */
export type QuickMcpPill = QuickMcpPillHttp | QuickMcpPillStdio;

interface QuickMcpPillBase {
  label: string;
  description?: string | null;
  /** Unique key used as the MCP server name in the Cursor SDK mcpServers map */
  mcpServerName: string;
  model?: string | null;
  /** Injected into the agent system prompt so the agent knows what the MCP is for */
  systemPromptHint?: string | null;
}

export interface QuickMcpPillHttp extends QuickMcpPillBase {
  transport: 'http';
  /** HTTP endpoint for the MCP server, e.g. "https://mcp.twilio.com/docs" */
  url: string;
  /**
   * Optional HTTP headers. Values matching "${VAR_NAME}" are resolved from
   * process.env at runtime so secrets are never stored in the database.
   */
  headers?: Record<string, string> | null;
}

export interface QuickMcpPillStdio extends QuickMcpPillBase {
  transport: 'stdio';
  /** Executable to run, e.g. "npx" */
  command: string;
  /** Arguments, e.g. ["-y", "sendgrid-mcp"] */
  args?: string[] | null;
  /**
   * Environment variables passed to the child process. Values matching
   * "${VAR_NAME}" are resolved from process.env at runtime.
   */
  env?: Record<string, string> | null;
}

export interface QuickSkillPill {
  label: string;
  skillPath: string;
  model?: string | null;
  /** Plain-English description shown to users when the pill is selected */
  description?: string | null;
}

export interface ProjectSkillConfig {
  id: string;
  project: string;
  friendlyName: string;
  isDefault: boolean;
  skillRepo: string;
  skillBranch: string;
  updatedBy?: string | null;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  designDocSkillPath?: string | null;
  designDocAssistantSkillPath?: string | null;
  designPrototypeSkillPath?: string | null;
  testCaseSkillPath?: string | null;
  designDocValidationSkillPath?: string | null;
  prdValidationSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  designDocModel?: string | null;
  designDocAssistantModel?: string | null;
  designPrototypeModel?: string | null;
  testCaseModel?: string | null;
  designDocValidationModel?: string | null;
  prdAssistantSkillPath?: string | null;
  prdAssistantModel?: string | null;
  prdValidationModel?: string | null;
  defaultModel?: string | null;
  prdReviewBedrockModelId?: string | null;
  prdReviewBedrockMaxTokens?: number | null;
  designPrototypeBedrockModelId?: string | null;
  designPrototypeBedrockMaxTokens?: number | null;
  designPrototypeBedrockTimeoutMs?: number | null;
  designPrototypeRegenBedrockModelId?: string | null;
  designPrototypeRegenBedrockMaxTokens?: number | null;
  designPlanBedrockModelId?: string | null;
  designPlanBedrockMaxTokens?: number | null;
  prdValidationScoreThreshold?: number | null;
  developmentSkillPath?: string | null;
  developmentModel?: string | null;
  quickSkillPills?: QuickSkillPill[] | null;
  quickMcpPills?: QuickMcpPill[] | null;
  approvalMode?: ApprovalMode;
  designDocApproverCount?: number;
  prdApproverCount?: number;
  designPrototypeApproverCount?: number;
  testCaseApproverCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Lightweight per-repo config summary for the project repo selector / header switcher.
 * Returned by `GET /api/skill-configs?project=`.
 */
export interface ProjectRepoConfigSummary {
  id: string;
  skillRepo: string;
  skillBranch: string;
  friendlyName: string;
  isDefault: boolean;
}

export interface UpsertProjectSkillConfigRequest {
  friendlyName: string;
  isDefault?: boolean;
  skillRepo: string;
  skillBranch: string;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  designDocSkillPath?: string | null;
  designDocAssistantSkillPath?: string | null;
  designPrototypeSkillPath?: string | null;
  testCaseSkillPath?: string | null;
  designDocValidationSkillPath?: string | null;
  prdValidationSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  designDocModel?: string | null;
  designDocAssistantModel?: string | null;
  designPrototypeModel?: string | null;
  testCaseModel?: string | null;
  designDocValidationModel?: string | null;
  prdAssistantSkillPath?: string | null;
  prdAssistantModel?: string | null;
  prdValidationModel?: string | null;
  defaultModel?: string | null;
  prdReviewBedrockModelId?: string | null;
  prdReviewBedrockMaxTokens?: number | null;
  designPrototypeBedrockModelId?: string | null;
  designPrototypeBedrockMaxTokens?: number | null;
  designPrototypeBedrockTimeoutMs?: number | null;
  designPrototypeRegenBedrockModelId?: string | null;
  designPrototypeRegenBedrockMaxTokens?: number | null;
  designPlanBedrockModelId?: string | null;
  designPlanBedrockMaxTokens?: number | null;
  prdValidationScoreThreshold?: number | null;
  developmentSkillPath?: string | null;
  developmentModel?: string | null;
  quickSkillPills?: QuickSkillPill[] | null;
  quickMcpPills?: QuickMcpPill[] | null;
  approvalMode?: ApprovalMode;
}

export interface ProjectApprover {
  id: string;
  settingsId: string;
  userId: string;
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case';
  displayName: string | null;
  email: string | null;
  assignedBy: string | null;
  assignedAt: string;
}

export interface SetApproversRequest {
  settingsId: string;
  /** Individual approver user OIDs. */
  designDocApprovers: string[];
  prdApprovers: string[];
  /** Live group references (group IDs); expanded to members at read time. */
  designDocApproverGroups?: string[];
  prdApproverGroups?: string[];
  designPrototypeApprovers: string[];
  designPrototypeApproverGroups?: string[];
  testCaseApprovers: string[];
  testCaseApproverGroups?: string[];
}

export interface ApproverPoolResponse {
  individuals: ProjectApprover[];
  groups: Array<GroupWithMembers & { documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case' }>;
}

export interface ProjectSkillConfigResponse {
  id: string;
  project: string;
  friendlyName: string;
  isDefault: boolean;
  skillRepo: string;
  skillBranch: string;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  designDocSkillPath?: string | null;
  designDocAssistantSkillPath?: string | null;
  designPrototypeSkillPath?: string | null;
  testCaseSkillPath?: string | null;
  designDocValidationSkillPath?: string | null;
  prdValidationSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  designDocModel?: string | null;
  designDocAssistantModel?: string | null;
  designPrototypeModel?: string | null;
  testCaseModel?: string | null;
  designDocValidationModel?: string | null;
  prdAssistantSkillPath?: string | null;
  prdAssistantModel?: string | null;
  prdValidationModel?: string | null;
  defaultModel?: string | null;
  developmentSkillPath?: string | null;
  developmentModel?: string | null;
  quickSkillPills?: QuickSkillPill[] | null;
  quickMcpPills?: QuickMcpPill[] | null;
  approvalMode?: ApprovalMode;
}

export interface ProjectRepoConfigSummary {
  id: string;
  project: string;
  skillRepo: string;
  skillBranch: string;
  friendlyName: string;
  isDefault: boolean;
}
