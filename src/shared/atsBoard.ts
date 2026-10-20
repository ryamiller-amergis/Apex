/**
 * Contract for the autonomous ATS board.
 *
 * The board may propose. Leadership ratifies. A package that is still
 * "awaiting leadership" is not a requirement and cannot become PRD input.
 */

export const ATS_AGENT_BOARD_TEMPLATE_KEY = 'ats-agent-board';

export interface AtsBoardAiTeamMember {
  nodeId: string;
  name: string;
  synopsis: string;
}

/**
 * Stable, product-facing introductions for the AI roles in the shipped board.
 * Keep these separate from prompts so the dashboard never invents a biography
 * from execution instructions.
 */
export const ATS_BOARD_AI_TEAM: readonly AtsBoardAiTeamMember[] = [
  {
    nodeId: 'operations',
    name: 'Operations specialist',
    synopsis:
      'Maps how work moves from a client request to a filled assignment.',
  },
  {
    nodeId: 'recruiting',
    name: 'Recruiting specialist',
    synopsis: 'Examines candidate sourcing, screening, and submission.',
  },
  {
    nodeId: 'client',
    name: 'Client specialist',
    synopsis: 'Represents how clients request, approve, and track work.',
  },
  {
    nodeId: 'compliance',
    name: 'Compliance specialist',
    synopsis: 'Challenges payroll, tax, invoice, and regulatory assumptions.',
  },
  {
    nodeId: 'data',
    name: 'Data specialist',
    synopsis: 'Plans Day-1 cutover, migration, and system separation needs.',
  },
  {
    nodeId: 'product',
    name: 'Product specialist',
    synopsis: 'Defines the smallest usable Phase 1 experience.',
  },
  {
    nodeId: 'market',
    name: 'Market specialist',
    synopsis:
      'Compares the charter with evidence from public staffing products.',
  },
  {
    nodeId: 'chair',
    name: 'Board chair',
    synopsis: 'Combines the independent findings into a leadership synopsis.',
  },
];

export const ATS_BOARD_AWAITING_LEADERSHIP =
  'Board approved — awaiting leadership';

/** Stored synopsis status value (v1–v3). UI should prefer the display label below. */
export const ATS_BOARD_PACKAGE_DISPLAY_STATUS =
  'Board recommendation — awaiting leadership ratification';

export type AtsBoardDeliberationItem = AtsBoardDeliberationSummary;

export interface AtsBoardEvidenceRegisterEntry {
  id: string;
  claim: string;
  source: string;
  date?: string;
  corroboration?: string;
}

export interface AtsBoardReadiness {
  ratifiable: boolean;
  blockers: string[];
}

export interface AtsBoardLenses {
  security: string[];
  cost: string[];
  delivery: string[];
  adoption: string[];
}

export const ATS_BOARD_DECISION_STATUSES = [
  ATS_BOARD_AWAITING_LEADERSHIP,
  'Open — insufficient evidence',
  'Blocked — violates charter',
] as const;

export type AtsBoardDecisionStatus =
  (typeof ATS_BOARD_DECISION_STATUSES)[number];

export const ATS_BOARD_MATERIAL_EXCEPTION_CATEGORIES = [
  'charter_change',
  'legal_compliance',
  'real_pii',
  'production_cutover',
  'material_spend',
  'external_commitment',
] as const;

export type AtsBoardMaterialExceptionCategory =
  (typeof ATS_BOARD_MATERIAL_EXCEPTION_CATEGORIES)[number];

export const ATS_BOARD_V4_MAX_AI_DECISIONS = 5;
export const ATS_BOARD_V4_MAX_OUTCOMES = 3;
export const ATS_BOARD_V4_MAX_EXCEPTIONS = 3;

export interface AtsBoardMaterialException {
  id: string;
  category: AtsBoardMaterialExceptionCategory;
  title: string;
  question: string;
  recommendedResolution: string;
  rationale?: string;
}

export interface AtsBoardLeadershipBrief {
  headline: string;
  aiDecisions: string[];
  expectedOutcomes: string[];
  materialExceptions: AtsBoardMaterialException[];
}

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
  evidenceIds?: string[];
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
  schemaVersion: 1 | 2 | 3 | 4;
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
  readiness?: AtsBoardReadiness;
  evidenceRegister?: AtsBoardEvidenceRegisterEntry[];
  insufficientEvidence?: string[];
  lenses?: AtsBoardLenses;
  leadershipBrief?: AtsBoardLeadershipBrief;
}

export interface AtsBoardLeadershipDecision {
  decision: 'approved' | 'rejected';
  comment?: string;
  answers?: AtsBoardLeadershipAnswer[];
}

export const ATS_BOARD_LEADERSHIP_RESOLUTIONS = [
  'accept_recommendation',
  'direct',
  'defer',
] as const;

export type AtsBoardLeadershipResolution =
  (typeof ATS_BOARD_LEADERSHIP_RESOLUTIONS)[number];

export interface AtsBoardLeadershipAnswer {
  decisionId: string;
  resolution: AtsBoardLeadershipResolution;
  response: string;
}

export function atsBoardDecisionRequestId(
  request: string,
  index: number
): string {
  const match = /^\s*(D-[A-Z0-9-]+)\s*(?::|—|–)/i.exec(request);
  return match?.[1]?.toUpperCase() ?? `DECISION-${index + 1}`;
}

export function parseAtsBoardLeadershipAnswers(
  value: unknown
): AtsBoardLeadershipAnswer[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const answers: AtsBoardLeadershipAnswer[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const source = item as Record<string, unknown>;
    const decisionId =
      typeof source.decisionId === 'string'
        ? source.decisionId.trim().toUpperCase()
        : '';
    const resolution =
      typeof source.resolution === 'string' ? source.resolution : '';
    const response =
      typeof source.response === 'string' ? source.response.trim() : '';
    if (
      !decisionId ||
      decisionId.length > 80 ||
      !ATS_BOARD_LEADERSHIP_RESOLUTIONS.includes(
        resolution as AtsBoardLeadershipResolution
      ) ||
      !response ||
      response.length > 2000 ||
      seen.has(decisionId)
    ) {
      return null;
    }
    seen.add(decisionId);
    answers.push({
      decisionId,
      resolution: resolution as AtsBoardLeadershipResolution,
      response,
    });
  }
  return answers;
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

function isMaterialExceptionCategory(
  value: unknown
): value is AtsBoardMaterialExceptionCategory {
  return ATS_BOARD_MATERIAL_EXCEPTION_CATEGORIES.includes(
    value as AtsBoardMaterialExceptionCategory
  );
}

const EXCEPTION_CATEGORY_LABELS: Record<
  AtsBoardMaterialExceptionCategory,
  string
> = {
  charter_change: 'Charter change',
  legal_compliance: 'Legal & compliance',
  real_pii: 'Real PII authorization',
  production_cutover: 'Production cutover',
  material_spend: 'Material spend',
  external_commitment: 'External commitment',
};

export function formatAtsBoardExceptionCategory(
  category: AtsBoardMaterialExceptionCategory
): string {
  return EXCEPTION_CATEGORY_LABELS[category];
}

const PLAIN_EXCEPTION_CATEGORY_LABELS: Record<
  AtsBoardMaterialExceptionCategory,
  string
> = {
  charter_change: 'Charter change',
  legal_compliance: 'Legal and compliance',
  real_pii: 'Customer data',
  production_cutover: 'Go-live',
  material_spend: 'Spending',
  external_commitment: 'Outside commitment',
};

/** Category name for a product owner or CIO. The audit record keeps the shorter technical label. */
export function plainExceptionCategory(
  category: AtsBoardMaterialExceptionCategory
): string {
  return PLAIN_EXCEPTION_CATEGORY_LABELS[category];
}

const DECISION_ID = /\bD-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
const EVIDENCE_ID = /\bE\d+\b/g;

function fallbackDecisionName(id: string): string {
  const token = id.replace(/^D-/, '').replace(/-/g, ' ').toLowerCase();
  const known: Record<string, string> = {
    legal: 'the legal review',
    cutover: 'the go-live decision',
    pii: 'the customer-data decision',
    spend: 'the spending decision',
    charter: 'the charter change',
    external: 'the outside commitment',
  };
  return known[token] ?? 'that open decision';
}

function decisionDisplayName(id: string, title?: string): string {
  const clean = title?.replace(DECISION_ID, '').replace(EVIDENCE_ID, '').trim();
  if (clean) return clean;
  return fallbackDecisionName(id);
}

/**
 * Leadership copy with decision and evidence codes replaced by plain names.
 * The stored audit record is unchanged.
 */
export function plainLeadershipCopy(
  text: string,
  decisions: ReadonlyArray<{ id: string; title?: string }> = []
): string {
  const names = new Map(
    decisions.map((decision) => [
      decision.id,
      decisionDisplayName(decision.id, decision.title),
    ])
  );
  return text
    .replace(DECISION_ID, (id) => names.get(id) ?? fallbackDecisionName(id))
    .replace(EVIDENCE_ID, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

function parseMaterialExceptions(
  value: unknown
): AtsBoardMaterialException[] | null {
  if (!Array.isArray(value) || value.length > ATS_BOARD_V4_MAX_EXCEPTIONS) {
    return null;
  }
  const exceptions: AtsBoardMaterialException[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const raw = entry as Record<string, unknown>;
    const id =
      typeof raw.id === 'string' ? raw.id.trim().toUpperCase() : '';
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const question =
      typeof raw.question === 'string' ? raw.question.trim() : '';
    const recommendedResolution =
      typeof raw.recommendedResolution === 'string'
        ? raw.recommendedResolution.trim()
        : '';
    const rationale =
      typeof raw.rationale === 'string' ? raw.rationale.trim() : undefined;
    if (
      !/^D-[A-Z0-9-]+$/.test(id) ||
      seenIds.has(id) ||
      !isMaterialExceptionCategory(raw.category) ||
      !title ||
      !question ||
      !recommendedResolution
    ) {
      return null;
    }
    seenIds.add(id);
    exceptions.push({
      id,
      category: raw.category,
      title,
      question,
      recommendedResolution,
      ...(rationale ? { rationale } : {}),
    });
  }
  return exceptions;
}

function parseLeadershipBrief(value: unknown): AtsBoardLeadershipBrief | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const headline =
    typeof raw.headline === 'string' ? raw.headline.trim() : '';
  const aiDecisions = asStringList(raw.aiDecisions);
  const expectedOutcomes = asStringList(raw.expectedOutcomes);
  const materialExceptions = parseMaterialExceptions(raw.materialExceptions);
  if (
    !headline ||
    !aiDecisions ||
    aiDecisions.length === 0 ||
    aiDecisions.length > ATS_BOARD_V4_MAX_AI_DECISIONS ||
    !expectedOutcomes ||
    expectedOutcomes.length === 0 ||
    expectedOutcomes.length > ATS_BOARD_V4_MAX_OUTCOMES ||
    !materialExceptions
  ) {
    return null;
  }
  return {
    headline,
    aiDecisions,
    expectedOutcomes,
    materialExceptions,
  };
}

export function defaultAtsBoardV4Answers(
  synopsis: AtsBoardSynopsis
): AtsBoardLeadershipAnswer[] {
  const exceptions = synopsis.leadershipBrief?.materialExceptions ?? [];
  return exceptions.map((item) => ({
    decisionId: item.id,
    resolution: 'accept_recommendation',
    response: item.recommendedResolution,
  }));
}

export function areAtsBoardV4AnswersAligned(
  synopsis: AtsBoardSynopsis,
  answers: AtsBoardLeadershipAnswer[] | undefined
): boolean {
  const exceptions = synopsis.leadershipBrief?.materialExceptions;
  if (synopsis.schemaVersion !== 4 || !exceptions) return false;
  if (exceptions.length === 0) {
    return !answers || answers.length === 0;
  }
  if (!answers || answers.length !== exceptions.length) return false;
  const parsed = parseAtsBoardLeadershipAnswers(answers);
  if (!parsed || parsed.length !== exceptions.length) return false;
  const expectedIds = new Set(exceptions.map((item) => item.id));
  return parsed.every((answer) => expectedIds.has(answer.decisionId));
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
  const schemaVersion =
    source.schemaVersion === 4
      ? 4
      : source.schemaVersion === 3
        ? 3
        : source.schemaVersion === 2
          ? 2
          : 1;
  const leadershipBrief =
    schemaVersion === 4 ? parseLeadershipBrief(source.leadershipBrief) : undefined;
  if (schemaVersion === 4 && !leadershipBrief) {
    return null;
  }

  const rawDecisionRequests =
    schemaVersion === 4 && source.decisionRequests === undefined
      ? []
      : schemaVersion >= 2
        ? asStringList(source.decisionRequests)
        : [];
  const businessOutcomes =
    schemaVersion === 4 && source.businessOutcomes === undefined && leadershipBrief
      ? leadershipBrief.expectedOutcomes
      : schemaVersion >= 2
        ? asStringList(source.businessOutcomes)
        : [];
  const options = schemaVersion >= 2 ? parseOptions(source.options) : [];
  const leadershipActions =
    schemaVersion >= 2 ? asStringList(source.leadershipActions) : [];
  const deliberation =
    schemaVersion >= 2 ? parseDeliberation(source.deliberation) : [];
  const recommendation =
    schemaVersion === 4 &&
    (typeof source.recommendation !== 'string' || !source.recommendation.trim()) &&
    leadershipBrief
      ? leadershipBrief.headline
      : schemaVersion >= 2
        ? source.recommendation
        : source.executiveSynopsis;
  const insufficientEvidence =
    schemaVersion >= 3
      ? (asStringList(source.insufficientEvidence) ?? [])
      : [];
  if (
    !rawDecisionRequests ||
    !businessOutcomes ||
    !options ||
    !leadershipActions ||
    !deliberation ||
    typeof recommendation !== 'string' ||
    !recommendation.trim()
  )
    return null;
  if (
    schemaVersion >= 3 &&
    source.insufficientEvidence !== undefined &&
    asStringList(source.insufficientEvidence) === null
  ) {
    return null;
  }

  let decisionRequests = rawDecisionRequests;
  if (schemaVersion === 4 && leadershipBrief) {
    const exceptionIds = new Set(
      leadershipBrief.materialExceptions.map((item) => item.id)
    );
    if (rawDecisionRequests.length === 0) {
      decisionRequests = leadershipBrief.materialExceptions.map(
        (item) => `${item.id}: ${item.question}`
      );
    } else {
      if (
        rawDecisionRequests.length > ATS_BOARD_V4_MAX_EXCEPTIONS ||
        rawDecisionRequests.length !== leadershipBrief.materialExceptions.length
      ) {
        return null;
      }
      const requestIds = rawDecisionRequests.map((item, idx) =>
        atsBoardDecisionRequestId(item, idx)
      );
      if (requestIds.some((id) => !exceptionIds.has(id))) {
        return null;
      }
    }
  }

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
    const evidenceIds = asStringList(decision.evidenceIds);
    decisions.push({
      id: decision.id,
      area: decision.area,
      decision: decision.decision,
      status: decision.status,
      evidence,
      confidence: decision.confidence,
      ...(evidenceIds ? { evidenceIds } : {}),
      ...(isEvidenceQuality(decision.evidenceQuality)
        ? { evidenceQuality: decision.evidenceQuality }
        : {}),
    });
  }

  let readiness: AtsBoardReadiness | undefined;
  if (
    schemaVersion >= 3 &&
    source.readiness &&
    typeof source.readiness === 'object'
  ) {
    const r = source.readiness as Record<string, unknown>;
    const blockers = asStringList(r.blockers);
    if (typeof r.ratifiable === 'boolean' && blockers) {
      readiness = { ratifiable: r.ratifiable, blockers };
    }
  }

  let evidenceRegister: AtsBoardEvidenceRegisterEntry[] | undefined;
  if (schemaVersion >= 3 && Array.isArray(source.evidenceRegister)) {
    const entries: AtsBoardEvidenceRegisterEntry[] = [];
    for (const item of source.evidenceRegister) {
      if (!item || typeof item !== 'object') return null;
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.claim !== 'string')
        return null;
      if (typeof entry.source !== 'string') return null;
      entries.push({
        id: entry.id,
        claim: entry.claim,
        source: entry.source,
        ...(typeof entry.date === 'string' ? { date: entry.date } : {}),
        ...(typeof entry.corroboration === 'string'
          ? { corroboration: entry.corroboration }
          : {}),
      });
    }
    evidenceRegister = entries;
  }

  let lenses: AtsBoardLenses | undefined;
  if (
    schemaVersion >= 3 &&
    source.lenses &&
    typeof source.lenses === 'object'
  ) {
    const l = source.lenses as Record<string, unknown>;
    const security = asStringList(l.security);
    const cost = asStringList(l.cost);
    const delivery = asStringList(l.delivery);
    const adoption = asStringList(l.adoption);
    if (security && cost && delivery && adoption) {
      lenses = { security, cost, delivery, adoption };
    }
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
    ...(readiness ? { readiness } : {}),
    ...(evidenceRegister ? { evidenceRegister } : {}),
    ...(insufficientEvidence && insufficientEvidence.length > 0
      ? { insufficientEvidence }
      : {}),
    ...(lenses ? { lenses } : {}),
    ...(leadershipBrief ? { leadershipBrief } : {}),
  };
}

export function atsBoardPackageStatusLabel(
  _synopsis: AtsBoardSynopsis,
  leadership: AtsBoardLeadershipDecision | null
): string {
  if (leadership?.decision === 'approved') return 'Leadership ratified';
  if (leadership?.decision === 'rejected') return 'Leadership rejected';
  return ATS_BOARD_PACKAGE_DISPLAY_STATUS;
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
  const effectiveAnswers =
    leadership.answers && leadership.answers.length > 0
      ? leadership.answers
      : synopsis.schemaVersion === 4
        ? defaultAtsBoardV4Answers(synopsis)
        : [];
  const leadershipResolutions = effectiveAnswers.map(
    (answer) =>
      `${answer.decisionId} (${answer.resolution.replace(/_/g, ' ')}): ${answer.response}`
  );

  const v4Brief =
    synopsis.schemaVersion === 4 ? synopsis.leadershipBrief : undefined;
  const v4Overrides = v4Brief
    ? effectiveAnswers
        .filter((answer) => {
          const match = v4Brief.materialExceptions.find(
            (item) => item.id === answer.decisionId
          );
          if (!match) return true;
          return (
            answer.resolution !== 'accept_recommendation' ||
            answer.response.trim() !== match.recommendedResolution.trim()
          );
        })
        .map(
          (answer) =>
            `${answer.decisionId} (${answer.resolution.replace(/_/g, ' ')}): ${answer.response}`
        )
    : [];

  return [
    '# ATS board package',
    '',
    'Leadership ratified this package. Earlier board text in the same conversation does not override it.',
    '',
    note,
    '',
    ...(v4Brief
      ? [
          '## AI-Decided Plan',
          '',
          v4Brief.headline,
          '',
          section('AI-Made Decisions', v4Brief.aiDecisions),
          '',
          section('Expected Outcomes', v4Brief.expectedOutcomes),
          '',
          section(
            'Material Exceptions',
            v4Brief.materialExceptions.map(
              (item) =>
                `${item.id} [${formatAtsBoardExceptionCategory(item.category)}] ${item.title}: ${item.question} — AI recommendation: ${item.recommendedResolution}`
            )
          ),
          '',
          section('Leadership Overrides', v4Overrides),
          '',
          '## Full Audit Record',
          '',
        ]
      : []),
    section('Leadership Resolutions', leadershipResolutions),
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
    ...(synopsis.readiness
      ? [
          section('Readiness', [
            `Ratifiable: ${synopsis.readiness.ratifiable ? 'yes' : 'no'}`,
            ...synopsis.readiness.blockers.map((item) => `Blocker: ${item}`),
          ]),
          '',
        ]
      : []),
    ...(synopsis.evidenceRegister
      ? [
          section(
            'Evidence register',
            synopsis.evidenceRegister.map(
              (entry) =>
                `${entry.id}: ${entry.claim} (${entry.source}${
                  entry.corroboration ? `; ${entry.corroboration}` : ''
                })`
            )
          ),
          '',
        ]
      : []),
    ...(synopsis.lenses
      ? [
          section('Security lens', synopsis.lenses.security),
          '',
          section('Cost lens', synopsis.lenses.cost),
          '',
          section('Delivery lens', synopsis.lenses.delivery),
          '',
          section('Adoption lens', synopsis.lenses.adoption),
          '',
        ]
      : []),
    section('Final Decision Ledger', ledger),
    '',
    'This ledger overrides every earlier ledger in this conversation.',
  ].join('\n');
}
