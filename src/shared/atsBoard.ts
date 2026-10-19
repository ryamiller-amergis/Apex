/**
 * Contract for the autonomous ATS board.
 *
 * The board may propose. Leadership ratifies. A package that is still
 * "awaiting leadership" is not a requirement and cannot become PRD input.
 */

export const ATS_AGENT_BOARD_TEMPLATE_KEY = 'ats-agent-board';

export const ATS_BOARD_AWAITING_LEADERSHIP =
  'Board approved — awaiting leadership';

export const ATS_BOARD_DECISION_STATUSES = [
  ATS_BOARD_AWAITING_LEADERSHIP,
  'Open — insufficient evidence',
  'Blocked — violates charter',
] as const;

export type AtsBoardDecisionStatus =
  (typeof ATS_BOARD_DECISION_STATUSES)[number];

export interface AtsBoardCharterFields {
  objective: string;
  separation: string;
  staffingModel: string;
  boundaries: string;
  nonNegotiables: string;
  authorizeNamedResearch: boolean;
}

export interface AtsBoardDecision {
  id: string;
  area: string;
  decision: string;
  status: AtsBoardDecisionStatus;
  evidence: string[];
  confidence: number;
  evidenceQuality?: 'strong' | 'moderate' | 'weak';
}

export interface AtsBoardOption {
  id: string;
  title: string;
  description: string;
  tradeoffs: string[];
  recommended: boolean;
}

export interface AtsBoardDeliberationSummary {
  topic: string;
  participants: string[];
  outcome: string;
  status: 'resolved' | 'unresolved' | 'leadership_required';
}

export interface AtsBoardSynopsis {
  schemaVersion: 1 | 2;
  status: typeof ATS_BOARD_AWAITING_LEADERSHIP;
  decisionRequests: string[];
  recommendation: string;
  businessOutcomes: string[];
  executiveSynopsis: string;
  phase1: string[];
  day1Cutover: string;
  separationImpact: string;
  options: AtsBoardOption[];
  leadershipActions: string[];
  deliberation: AtsBoardDeliberationSummary[];
  decisions: AtsBoardDecision[];
  dissent: string[];
  risks: string[];
  assumptions: string[];
  advantages: string[];
  deferred: string[];
  unresolved: string[];
}

export interface AtsBoardLeadershipDecision {
  decision: 'approved' | 'rejected';
  comment?: string;
}

export interface AtsBoardAuditTurn {
  sequence: number;
  phase: 'agenda' | 'response' | 'rebuttal' | 'synthesis';
  topicId: string | null;
  specialist: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result: Record<string, unknown> | null;
  completedAt: string | null;
}

export class AtsBoardCharterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtsBoardCharterError';
  }
}

export class AtsBoardTranscriptError extends Error {
  constructor() {
    super('Only a leadership-ratified board package can become PRD input.');
    this.name = 'AtsBoardTranscriptError';
  }
}

const NAMED_RESEARCH = /\b(aya|erecruit)\b/i;

export function redactBoardText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
    .replace(/\$\s?\d[\d,]*(?:\.\d+)?\b/g, '[redacted amount]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted identifier]')
    .replace(/\(\d{3}\)\s*\d{3}[-.\s]\d{4}\b/g, '[redacted phone]')
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, '[redacted phone]');
}

export function assertNamedResearchAuthorized(
  charter: string,
  authorized: boolean
): void {
  if (authorized) return;
  if (NAMED_RESEARCH.test(charter)) {
    throw new AtsBoardCharterError(
      'Named research for Aya or eRecruit requires explicit authorization.'
    );
  }
}

export function buildAtsBoardCharter(fields: AtsBoardCharterFields): string {
  return redactBoardText(
    [
      `Objective: ${fields.objective.trim()}`,
      `Separation: ${fields.separation.trim()}`,
      `Staffing model: ${fields.staffingModel.trim()}`,
      `Boundaries: ${fields.boundaries.trim()}`,
      `Non-negotiables: ${fields.nonNegotiables.trim()}`,
      `Named research authorized: ${fields.authorizeNamedResearch ? 'yes' : 'no'}`,
    ].join('\n')
  );
}

export function atsBoardRunInput(
  fields: AtsBoardCharterFields
): Record<string, unknown> {
  const charter = buildAtsBoardCharter(fields);
  assertNamedResearchAuthorized(charter, fields.authorizeNamedResearch);
  return {
    board: ATS_AGENT_BOARD_TEMPLATE_KEY,
    charter,
    authorizeNamedResearch: fields.authorizeNamedResearch,
  };
}

export function prepareAtsBoardRunInput(
  runInput: Record<string, unknown>
): Record<string, unknown> {
  if (runInput.board !== ATS_AGENT_BOARD_TEMPLATE_KEY) return runInput;
  const charter =
    typeof runInput.charter === 'string'
      ? redactBoardText(runInput.charter)
      : '';
  if (!charter.trim()) {
    throw new AtsBoardCharterError(
      'The ATS board needs a charter before it can start.'
    );
  }
  const authorized = runInput.authorizeNamedResearch === true;
  assertNamedResearchAuthorized(charter, authorized);
  return { ...runInput, charter, authorizeNamedResearch: authorized };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return null;
  const direct = parseJson(value);
  if (direct) return direct;
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fence ? parseJson(fence[1]) : null;
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function entryText(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const parts = Object.values(entry as Record<string, unknown>).filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0
  );
  return parts.length > 0 ? parts.join(' — ') : null;
}

/** Models often write list items as small objects; each becomes one line of its text fields. */
function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const lines: string[] = [];
  for (const entry of value) {
    const text = entryText(entry);
    if (text === null) return null;
    lines.push(text);
  }
  return lines;
}

function isDecisionStatus(value: unknown): value is AtsBoardDecisionStatus {
  return ATS_BOARD_DECISION_STATUSES.includes(value as AtsBoardDecisionStatus);
}

function isEvidenceQuality(
  value: unknown
): value is NonNullable<AtsBoardDecision['evidenceQuality']> {
  return value === 'strong' || value === 'moderate' || value === 'weak';
}

function parseOptions(value: unknown): AtsBoardOption[] | null {
  if (!Array.isArray(value)) return null;
  const options: AtsBoardOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return null;
    const option = entry as Record<string, unknown>;
    const tradeoffs = asStringList(option.tradeoffs);
    if (
      typeof option.id !== 'string' ||
      typeof option.title !== 'string' ||
      typeof option.description !== 'string' ||
      !tradeoffs ||
      typeof option.recommended !== 'boolean'
    )
      return null;
    options.push({
      id: option.id,
      title: option.title,
      description: option.description,
      tradeoffs,
      recommended: option.recommended,
    });
  }
  return options;
}

function parseDeliberation(
  value: unknown
): AtsBoardDeliberationSummary[] | null {
  if (!Array.isArray(value)) return null;
  const summaries: AtsBoardDeliberationSummary[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return null;
    const summary = entry as Record<string, unknown>;
    const participants = asStringList(summary.participants);
    if (
      typeof summary.topic !== 'string' ||
      !participants ||
      typeof summary.outcome !== 'string' ||
      !['resolved', 'unresolved', 'leadership_required'].includes(
        String(summary.status)
      )
    )
      return null;
    summaries.push({
      topic: summary.topic,
      participants,
      outcome: summary.outcome,
      status: summary.status as AtsBoardDeliberationSummary['status'],
    });
  }
  return summaries;
}

export function parseAtsBoardSynopsis(
  output: Record<string, unknown> | null
): AtsBoardSynopsis | null {
  if (!output) return null;
  const source = asObject(output.scorecard) ?? asObject(output.reportMd);
  if (!source) return null;
  if (source.status !== ATS_BOARD_AWAITING_LEADERSHIP) return null;
  if (
    typeof source.executiveSynopsis !== 'string' ||
    !source.executiveSynopsis.trim()
  )
    return null;
  if (
    typeof source.day1Cutover !== 'string' ||
    typeof source.separationImpact !== 'string'
  )
    return null;

  const phase1 = asStringList(source.phase1);
  const dissent = asStringList(source.dissent);
  const risks = asStringList(source.risks);
  const assumptions = asStringList(source.assumptions);
  const advantages = asStringList(source.advantages);
  const deferred = asStringList(source.deferred);
  const unresolved = asStringList(source.unresolved);
  if (
    !phase1 ||
    !dissent ||
    !risks ||
    !assumptions ||
    !advantages ||
    !deferred ||
    !unresolved
  ) {
    return null;
  }
  if (!Array.isArray(source.decisions)) return null;
  const schemaVersion = source.schemaVersion === 2 ? 2 : 1;
  const decisionRequests =
    schemaVersion === 2 ? asStringList(source.decisionRequests) : [];
  const businessOutcomes =
    schemaVersion === 2 ? asStringList(source.businessOutcomes) : [];
  const options = schemaVersion === 2 ? parseOptions(source.options) : [];
  const leadershipActions =
    schemaVersion === 2 ? asStringList(source.leadershipActions) : [];
  const deliberation =
    schemaVersion === 2 ? parseDeliberation(source.deliberation) : [];
  const recommendation =
    schemaVersion === 2 ? source.recommendation : source.executiveSynopsis;
  if (
    !decisionRequests ||
    !businessOutcomes ||
    !options ||
    !leadershipActions ||
    !deliberation ||
    typeof recommendation !== 'string' ||
    !recommendation.trim()
  )
    return null;

  const decisions: AtsBoardDecision[] = [];
  for (const entry of source.decisions) {
    if (!entry || typeof entry !== 'object') return null;
    const decision = entry as Record<string, unknown>;
    const evidence = asStringList(decision.evidence);
    if (
      typeof decision.id !== 'string' ||
      typeof decision.area !== 'string' ||
      typeof decision.decision !== 'string' ||
      !isDecisionStatus(decision.status) ||
      !evidence ||
      typeof decision.confidence !== 'number' ||
      decision.confidence < 0 ||
      decision.confidence > 1
    ) {
      return null;
    }
    decisions.push({
      id: decision.id,
      area: decision.area,
      decision: decision.decision,
      status: decision.status,
      evidence,
      confidence: decision.confidence,
      ...(isEvidenceQuality(decision.evidenceQuality)
        ? { evidenceQuality: decision.evidenceQuality }
        : {}),
    });
  }

  return {
    schemaVersion,
    status: ATS_BOARD_AWAITING_LEADERSHIP,
    decisionRequests,
    recommendation: recommendation.trim(),
    businessOutcomes,
    executiveSynopsis: source.executiveSynopsis.trim(),
    phase1,
    day1Cutover: source.day1Cutover,
    separationImpact: source.separationImpact,
    options,
    leadershipActions,
    deliberation,
    decisions,
    dissent,
    risks,
    assumptions,
    advantages,
    deferred,
    unresolved,
  };
}

function section(title: string, lines: string[]): string {
  const body =
    lines.length > 0
      ? lines.map((line) => `- ${line}`).join('\n')
      : '- None recorded.';
  return `## ${title}\n\n${body}`;
}

/**
 * The transcript `/to-prd` can read. Refuses a package leadership has not ratified.
 */
export function formatAtsBoardTranscript(
  synopsis: AtsBoardSynopsis,
  leadership: AtsBoardLeadershipDecision | null
): string {
  if (leadership?.decision !== 'approved') throw new AtsBoardTranscriptError();

  const ledger = synopsis.decisions.map(
    (decision) =>
      `${decision.area}: ${decision.decision} (${decision.status}; confidence ${decision.confidence}). ` +
      (decision.evidenceQuality
        ? `Evidence quality: ${decision.evidenceQuality}. `
        : '') +
      (decision.evidence.join(' ') || 'No evidence recorded.')
  );
  const note = leadership.comment?.trim()
    ? `Leadership note: ${leadership.comment.trim()}`
    : 'Leadership ratified this package with no additional note.';

  return [
    '# ATS board package',
    '',
    'Leadership ratified this package. Earlier board text in the same conversation does not override it.',
    '',
    note,
    '',
    section('Leadership Decisions Requested', synopsis.decisionRequests),
    '',
    '## Recommendation',
    '',
    synopsis.recommendation,
    '',
    section('Business Outcomes', synopsis.businessOutcomes),
    '',
    '## Phase 1 Brief',
    '',
    synopsis.executiveSynopsis,
    '',
    section('Phase 1 Requirements', synopsis.phase1),
    '',
    '## Day-1 cutover',
    '',
    synopsis.day1Cutover,
    '',
    '## Separation impact',
    '',
    synopsis.separationImpact,
    '',
    section('Experience Differentiators', synopsis.advantages),
    '',
    section('Deferred Roadmap', synopsis.deferred),
    '',
    section(
      'Options and Trade-offs',
      synopsis.options.map(
        (option) =>
          `${option.recommended ? 'Recommended — ' : ''}${option.title}: ${option.description}. ` +
          `Trade-offs: ${option.tradeoffs.join('; ') || 'None recorded.'}`
      )
    ),
    '',
    section(
      'Deliberation',
      synopsis.deliberation.map(
        (item) =>
          `${item.topic} (${item.status}; ${item.participants.join(', ')}): ${item.outcome}`
      )
    ),
    '',
    section('Leadership Actions', synopsis.leadershipActions),
    '',
    section('Research Notes', [
      ...synopsis.assumptions.map((item) => `Assumption: ${item}`),
      ...synopsis.risks.map((item) => `Risk: ${item}`),
      ...synopsis.unresolved.map((item) => `Unresolved: ${item}`),
    ]),
    '',
    section('Dissent', synopsis.dissent),
    '',
    section('Final Decision Ledger', ledger),
    '',
    'This ledger overrides every earlier ledger in this conversation.',
  ].join('\n');
}
