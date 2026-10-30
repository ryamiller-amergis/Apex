/**
 * FEAT-003 TBI-008 — where a Brainstorm artifact can go.
 *
 * One entry per action. Each entry states which artifact types it serves, the
 * permission, group and menu it needs, what the artifact must contain, what the
 * preview shows, and how to create the target record. A new target is one entry.
 */
import { AGENT_SKILL_ROOT, skillPathFor } from '../../shared/skillPaths';
import {
  BRAINSTORM_ARTIFACT_TYPE_LABELS,
  type BrainstormActionId,
  type BrainstormActionKind,
  type BrainstormArtifactType,
  type BrainstormResultRef,
  type BrainstormTargetModule,
} from '../../shared/types/brainstormArtifact';
import type { BrainstormCitationDto } from '../../shared/types/brainstormSources';

/** Groups the Interview route requires through `requireGroupMembership`. */
export const INTERVIEW_GROUPS = ['BA', 'Manager', 'Product-Owner'] as const;

export interface ProjectRepository {
  repo: string;
  branch: string;
  provider: 'github' | 'ado' | null;
  settingsId: string | null;
  interviewSkillPath: string | null;
}

/** What the creator may do in the project, loaded once per request. */
export interface HandoffCapabilities {
  isSuperAdmin: boolean;
  permissions: ReadonlySet<string>;
  groups: readonly string[];
  enabledMenus: ReadonlySet<string>;
  repository: ProjectRepository | null;
}

// ── Markdown structure ────────────────────────────────────────────────────────

export interface ArtifactOutline {
  title: string | null;
  /** Level-2 sections by lower-cased heading, body trimmed. */
  sections: Map<string, string>;
  /** Level-2 headings as written, in order. */
  headings: string[];
  /** Non-empty prose after the title. */
  hasBody: boolean;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');
}

/** Headings and section bodies, ignoring anything inside fenced code. */
export function outlineArtifact(markdown: string): ArtifactOutline {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  let title: string | null = null;
  const sections = new Map<string, string>();
  const headings: string[] = [];
  let current: string | null = null;
  let buffer: string[] = [];
  let fence: string | null = null;
  let body = false;

  const flush = () => {
    if (current !== null && !sections.has(current)) sections.set(current, buffer.join('\n').trim());
    buffer = [];
  };

  for (const line of lines) {
    const marker = line.match(FENCE)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      buffer.push(line);
      if (title !== null && line.trim()) body = true;
      continue;
    }
    if (marker) {
      fence = marker;
      buffer.push(line);
      if (title !== null) body = true;
      continue;
    }
    const h1 = line.match(/^ {0,3}#[ \t]+(.+?)[ \t#]*$/);
    if (h1 && title === null) {
      title = h1[1].trim();
      continue;
    }
    const h2 = line.match(/^ {0,3}##[ \t]+(.+?)[ \t#]*$/);
    if (h2) {
      flush();
      headings.push(h2[1].trim());
      current = h2[1].trim().toLowerCase();
      if (title !== null) body = true;
      continue;
    }
    if (title !== null && line.trim()) body = true;
    buffer.push(line);
  }
  flush();
  return { title, sections, headings, hasBody: body };
}

function hasOption(section: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+\S/m.test(section) || /^ {0,3}###[ \t]+\S/m.test(section);
}

const ADR_SECTIONS: ReadonlyArray<{ key: string; label: string; check?: (body: string) => boolean }> = [
  { key: 'context', label: 'Context' },
  { key: 'considered options', label: 'Considered Options', check: hasOption },
  { key: 'decision outcome', label: 'Decision Outcome' },
  { key: 'consequences', label: 'Consequences' },
];

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'brainstorm-adr';
}

/** ADR Markdown as created: engine-built frontmatter and a Proposed status section. */
export function buildAdrContent(markdown: string, title: string, today: string): string {
  const body = stripFrontmatter(markdown).replace(/^\s+/, '');
  const frontmatter = [
    '---',
    'adr-number: ADR-pending',
    'status: Proposed',
    `date: ${today}`,
    `slug: ${slugify(title)}`,
    '---',
    '',
  ].join('\n');
  const statusSection = /(^ {0,3}##[ \t]+Status[ \t]*\r?\n(?:[ \t]*\r?\n)*)([^\r\n]*)/im;
  const withStatus = statusSection.test(body)
    ? body.replace(statusSection, '$1Proposed')
    : body.replace(/^( {0,3}#[ \t]+.+\r?\n)/m, '$1\n## Status\n\nProposed\n');
  return `${frontmatter}${withStatus}`;
}

// ── Handoff context ───────────────────────────────────────────────────────────

export interface HandoffContextInput {
  sessionId: string;
  project: string;
  artifactType: BrainstormArtifactType;
  version: number;
  markdown: string;
  citations: readonly BrainstormCitationDto[];
}

/** The `freeformContext` a target thread starts with: the artifact and cited claims, never source content. */
export function buildHandoffContext(input: HandoffContextInput): string {
  const lines = [
    '# Brainstorm handoff',
    '',
    `This work starts from Brainstorm session ${input.sessionId} in project ${input.project}: `
      + `${BRAINSTORM_ARTIFACT_TYPE_LABELS[input.artifactType]}, version ${input.version}.`,
    `Session link: /brainstorm/${input.sessionId}`,
    '',
    '## Artifact',
    '',
    input.markdown,
  ];
  if (input.citations.length > 0) {
    lines.push('', '## Cited claims', '');
    for (const citation of input.citations) {
      const where = citation.path
        ? `${citation.sourceName}: ${citation.path}${citation.revision ? ` @ ${citation.revision}` : ''}`
        : `${citation.sourceName}: ${citation.mcpServerName ?? 'MCP'} ${citation.mcpToolId ?? ''}`.trim();
      lines.push(`- ${citation.claim} (${where})`);
    }
  }
  return lines.join('\n');
}

// ── Registry ──────────────────────────────────────────────────────────────────

export interface TargetServices {
  createThread(input: {
    userId: string;
    project: string;
    module: 'adr' | 'interview';
    repository: ProjectRepository;
    skillPath: string | null;
    freeformContext: string;
  }): Promise<string>;
  findRecordByThread(module: 'adr' | 'interview' | 'feature-request', threadId: string): Promise<string | null>;
  createAdrFromContent(input: {
    userId: string;
    project: string;
    repo: string;
    title: string;
    chatThreadId: string;
    content: string;
    skillSettingsId: string | null;
  }): Promise<string>;
  createInterview(input: {
    userId: string;
    project: string;
    repo: string;
    title: string;
    chatThreadId: string;
    skillSettingsId: string | null;
  }): Promise<string>;
  createFeatureRequestFromPlan?(input: {
    userId: string;
    project: string;
    title: string;
    request: string;
  }): Promise<string>;
  markInterviewThread(threadId: string): Promise<void>;
}

/** The stored target fields a preview fixes and a confirmation executes. */
export interface TargetPlan {
  title: string;
  repo: string;
  skillPath: string | null;
  status: string;
}

export interface HandoffTarget {
  id: BrainstormActionId;
  kind: Exclude<BrainstormActionKind, 'keep_standalone'>;
  module: Exclude<BrainstormTargetModule, 'standalone'>;
  label: string;
  description: string;
  menuKey: string;
  appliesTo(type: BrainstormArtifactType): boolean;
  allowed(caps: HandoffCapabilities): boolean;
  missingInformation(outline: ArtifactOutline, caps: HandoffCapabilities): string[];
  plan(outline: ArtifactOutline, type: BrainstormArtifactType, caps: HandoffCapabilities): TargetPlan;
  notes(plan: TargetPlan): string[];
  link(id: string): string;
}

function hasPermission(caps: HandoffCapabilities, key: string): boolean {
  return caps.isSuperAdmin || caps.permissions.has(key);
}

function inInterviewGroup(caps: HandoffCapabilities): boolean {
  if (caps.isSuperAdmin || caps.permissions.has('admin:roles')) return true;
  return INTERVIEW_GROUPS.some((group) => caps.groups.includes(group));
}

export function interviewSkillPathFor(type: BrainstormArtifactType, repository: ProjectRepository | null): string {
  if (type === 'technical_design') return skillPathFor(AGENT_SKILL_ROOT, 'grill-design');
  return repository?.interviewSkillPath || skillPathFor(AGENT_SKILL_ROOT, 'grill-with-docs');
}

export const ADR_TARGET: HandoffTarget = {
  id: 'create-adr',
  kind: 'create_direct',
  module: 'adr',
  label: 'Create ADR',
  description: 'Create a Proposed ADR from this artifact. It goes through the normal ADR review.',
  menuKey: 'adr',
  appliesTo: (type) => type === 'adr',
  allowed: (caps) => hasPermission(caps, 'adr:create'),
  missingInformation(outline, caps) {
    const missing: string[] = [];
    if (!outline.title) missing.push('Title');
    for (const section of ADR_SECTIONS) {
      const body = outline.sections.get(section.key);
      if (!body || (section.check && !section.check(body))) missing.push(section.label);
    }
    if (!caps.repository) missing.push('Project repository');
    return missing;
  },
  plan: (outline, _type, caps) => ({
    title: outline.title ?? '',
    repo: caps.repository?.repo ?? '',
    skillPath: null,
    status: 'Proposed',
  }),
  notes: () => [
    'The ADR is created as Proposed, whatever the artifact says about its status.',
    'No reviewers are assigned. You review it as the owner, and can add reviewers from the ADR.',
  ],
  link: (id) => `/adr/${id}`,
};

export const INTERVIEW_TARGET: HandoffTarget = {
  id: 'start-interview',
  kind: 'start_workflow',
  module: 'interview',
  label: 'Start Interview',
  description: 'Start a design interview that begins with this artifact and its cited claims.',
  menuKey: 'backlog',
  appliesTo: (type) => type === 'technical_design' || type === 'discovery_brief',
  allowed: (caps) => hasPermission(caps, 'interviews:manage') && inInterviewGroup(caps),
  missingInformation(outline, caps) {
    const missing: string[] = [];
    if (!outline.title) missing.push('Title');
    if (!outline.hasBody) missing.push('Content below the title');
    if (!caps.repository) missing.push('Project repository');
    return missing;
  },
  plan: (outline, type, caps) => ({
    title: outline.title ?? '',
    repo: caps.repository?.repo ?? '',
    skillPath: interviewSkillPathFor(type, caps.repository),
    status: 'In progress',
  }),
  notes: (plan) => [
    `The interview uses the ${plan.skillPath?.split('/').slice(-2, -1)[0] ?? 'project'} skill.`,
    'The interview starts with the artifact and its cited claims. Source files and chat history are not copied.',
  ],
  link: (id) => `/backlog/interview/${id}`,
};

export const FEATURE_REQUEST_TARGET: HandoffTarget = {
  id: 'create-feature-request',
  kind: 'create_direct',
  module: 'feature-request',
  label: 'Create Feature Request',
  description: 'Create a Feature Request pre-filled with this implementation plan and its cited claims.',
  menuKey: 'feature-requests',
  appliesTo: (type) => type === 'implementation_plan',
  allowed: (caps) => hasPermission(caps, 'feature-requests:submit'),
  missingInformation(outline) {
    const missing: string[] = [];
    if (!outline.title) missing.push('Title');
    if (!outline.hasBody) missing.push('Content below the title');
    return missing;
  },
  plan: (outline, _type, caps) => ({
    title: outline.title ?? '',
    repo: caps.repository?.repo ?? '',
    skillPath: null,
    status: 'New',
  }),
  notes: () => [
    'The Feature Request is created as New with your implementation plan and cited claims.',
    'You can triage, prioritize, or kick off a design interview from the Feature Requests board.',
  ],
  link: (id) => `/feature-requests?selected=${id}`,
};

export const HANDOFF_TARGETS: readonly HandoffTarget[] = [
  ADR_TARGET,
  INTERVIEW_TARGET,
  FEATURE_REQUEST_TARGET,
];

export function targetById(id: BrainstormActionId): HandoffTarget | null {
  return HANDOFF_TARGETS.find((target) => target.id === id) ?? null;
}

/**
 * Creates the target record, reusing one already attached to the thread.
 * `threadId` is null on first execution; the caller stores the returned thread before the record exists.
 */
export async function executeTarget(
  target: HandoffTarget,
  input: {
    services: TargetServices;
    userId: string;
    project: string;
    plan: TargetPlan;
    repository: ProjectRepository | null;
    markdown: string;
    context: string;
    today: string;
    threadId: string | null;
    storeThread: (threadId: string) => Promise<void>;
  },
): Promise<{ resultRef: BrainstormResultRef; recovered: boolean }> {
  const { services } = input;
  if (target.module === 'feature-request') {
    if (!services.createFeatureRequestFromPlan) {
      throw new Error('createFeatureRequestFromPlan is not configured');
    }
    const id = await services.createFeatureRequestFromPlan({
      userId: input.userId,
      project: input.project,
      title: input.plan.title,
      request: input.context,
    });
    return {
      resultRef: { module: 'feature-request', id, link: target.link(id) },
      recovered: false,
    };
  }
  if (!input.repository) {
    throw new Error('repository is required for this handoff target');
  }
  let threadId = input.threadId;
  if (!threadId) {
    threadId = await services.createThread({
      userId: input.userId,
      project: input.project,
      module: target.module,
      repository: input.repository,
      skillPath: input.plan.skillPath,
      freeformContext: input.context,
    });
    await input.storeThread(threadId);
  }
  const existing = await services.findRecordByThread(target.module, threadId);
  if (existing) {
    if (target.module === 'interview') await services.markInterviewThread(threadId);
    return { resultRef: { module: target.module, id: existing, link: target.link(existing) }, recovered: true };
  }
  const id = target.module === 'adr'
    ? await services.createAdrFromContent({
        userId: input.userId,
        project: input.project,
        repo: input.plan.repo,
        title: input.plan.title,
        chatThreadId: threadId,
        content: buildAdrContent(input.markdown, input.plan.title, input.today),
        skillSettingsId: input.repository.settingsId,
      })
    : await services.createInterview({
        userId: input.userId,
        project: input.project,
        repo: input.plan.repo,
        title: input.plan.title,
        chatThreadId: threadId,
        skillSettingsId: input.repository.settingsId,
      });
  return { resultRef: { module: target.module, id, link: target.link(id) }, recovered: false };
}
