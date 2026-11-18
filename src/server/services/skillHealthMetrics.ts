/**
 * Skill Health metrics — pure aggregation over rows loaded by `skillHealthService`.
 *
 * Kept free of database access so every rule (attribution, pass/fail, status) is unit-testable.
 */

import type { ValidationScorecard } from '../../shared/types/interview';
import {
  SKILL_HEALTH_FOUNDATION_PROJECT,
  SKILL_HEALTH_MIN_SCORED_DOCUMENTS,
  type SkillAttributionSource,
  type SkillHealthArtifactKind,
  type SkillHealthEfficiency,
  type SkillHealthInterval,
  type SkillHealthModelBreakdown,
  type SkillHealthProject,
  type SkillHealthRecurringGap,
  type SkillHealthSectionCell,
  type SkillHealthSkill,
  type SkillHealthStatus,
  type SkillHealthTrendPoint,
  type SkillHealthVersion,
} from '../../shared/types/skillHealth';
import { collectValidationGaps, resolveScorecardOverallScore } from '../../shared/utils/validationReport';
import {
  buildProjectEvaluation,
  evaluationSkillPathKey,
  humanStats,
  type SkillHealthEvaluationEventInput,
  type SkillHealthEvaluationJobInput,
} from './skillHealthEvaluationMetrics';
import { buildProjectSignals, type SkillSignalRowInput } from './skillSignalMetrics';
import { meanInterval, wilsonInterval } from './skillLearningStats';
import type { SkillLearningSurface } from '../../shared/constants/skillLearningSurfaces';

export interface SkillHealthDocumentInput {
  id: string;
  kind: SkillHealthArtifactKind;
  project: string;
  createdAt: string;
  status: string;
  validationScore: number | null;
  scorecard: ValidationScorecard | null;
  skillSettingsId: string | null;
  skillSha256: string | null;
  hasOverride: boolean;
  model?: string | null;
  effort?: string | null;
  /** When the document was last reviewed; used as its approval time once accepted. */
  reviewedAt?: string | null;
}

export interface SkillHealthSettingsInput {
  id: string;
  project: string;
  skillRepo: string;
  isDefault: boolean;
  prdSkillPath: string | null;
  designDocSkillPath: string | null;
  prdThreshold: number | null;
  designDocThreshold: number | null;
}

export interface SkillHealthCommentInput {
  documentId: string;
  documentType: SkillHealthArtifactKind;
  sectionKey: string;
}

export interface SkillHealthCostInput {
  documentId: string;
  documentType: SkillHealthArtifactKind;
  costUsd: number;
}

export interface SkillHealthInputs {
  documents: SkillHealthDocumentInput[];
  settings: SkillHealthSettingsInput[];
  comments: SkillHealthCommentInput[];
  costs: SkillHealthCostInput[];
  /** Projects with the `skill-learning` flag on; only their events are used. */
  evaluationProjects: string[];
  evaluationEvents: SkillHealthEvaluationEventInput[];
  evaluationJobs: SkillHealthEvaluationJobInput[];
  /** Same flag filter as `evaluationEvents`. */
  signals: SkillSignalRowInput[];
}

function enabledEvaluationEvents(inputs: SkillHealthInputs): SkillHealthEvaluationEventInput[] {
  const enabled = new Set(inputs.evaluationProjects);
  return inputs.evaluationEvents.filter((e) => enabled.has(e.project));
}

const ACCEPTED_STATUSES = new Set(['approved', 'reviewer_approved']);
const RECURRING_GAP_LIMIT = 8;
const SAMPLE_LIMIT = 3;

export function normalizeSkillPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return trimmed ? trimmed : null;
}

interface Attribution {
  skillPath: string | null;
  threshold: number | null;
  source: SkillAttributionSource;
}

function attribute(
  doc: SkillHealthDocumentInput,
  settingsById: Map<string, SkillHealthSettingsInput>,
  defaultByProject: Map<string, SkillHealthSettingsInput>,
): Attribution {
  const own = doc.skillSettingsId ? settingsById.get(doc.skillSettingsId) : undefined;
  const settings = own ?? defaultByProject.get(doc.project);
  if (!settings) return { skillPath: null, threshold: null, source: 'unattributed' };

  const isPrd = doc.kind === 'prd';
  return {
    skillPath: normalizeSkillPath(isPrd ? settings.prdSkillPath : settings.designDocSkillPath),
    threshold: isPrd ? settings.prdThreshold : settings.designDocThreshold,
    source: own ? 'document-settings' : 'project-default',
  };
}

function scoreOf(doc: SkillHealthDocumentInput): number | null {
  if (typeof doc.validationScore === 'number') return doc.validationScore;
  return resolveScorecardOverallScore(doc.scorecard);
}

function passes(doc: SkillHealthDocumentInput, score: number, threshold: number | null): boolean | null {
  if (threshold !== null) return score >= threshold;
  const fromScorecard = doc.scorecard?.ready_threshold;
  if (typeof fromScorecard === 'number') return score >= fromScorecard;
  if (typeof doc.scorecard?.is_ready === 'boolean') return doc.scorecard.is_ready;
  return null;
}

export function deriveStatus(scoredDocuments: number, passRate: number | null): SkillHealthStatus {
  if (scoredDocuments < SKILL_HEALTH_MIN_SCORED_DOCUMENTS || passRate === null) return 'insufficient_data';
  if (passRate >= 0.8) return 'good';
  if (passRate >= 0.5) return 'fair';
  return 'poor';
}

export function weekStartOf(iso: string): string {
  const date = new Date(iso);
  const day = date.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function docKey(kind: SkillHealthArtifactKind, id: string): string {
  return `${kind}:${id}`;
}

interface SkillAccumulator {
  project: string;
  artifactKind: SkillHealthArtifactKind;
  skillPath: string | null;
  docs: { doc: SkillHealthDocumentInput; score: number | null; passed: boolean | null }[];
  attribution: Record<SkillAttributionSource, number>;
}

function buildTrend(entries: SkillAccumulator['docs']): SkillHealthTrendPoint[] {
  const byWeek = new Map<string, { documents: number; scores: number[] }>();
  for (const { doc, score } of entries) {
    const week = weekStartOf(doc.createdAt);
    const bucket = byWeek.get(week) ?? { documents: 0, scores: [] };
    bucket.documents += 1;
    if (score !== null) bucket.scores.push(score);
    byWeek.set(week, bucket);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, bucket]) => ({
      weekStart,
      documents: bucket.documents,
      averageScore: average(bucket.scores),
    }));
}

function buildSections(
  entries: SkillAccumulator['docs'],
  commentsByDoc: Map<string, SkillHealthCommentInput[]>,
): SkillHealthSectionCell[] {
  const cells = new Map<string, SkillHealthSectionCell>();
  for (const { doc } of entries) {
    for (const comment of commentsByDoc.get(docKey(doc.kind, doc.id)) ?? []) {
      const cell = cells.get(comment.sectionKey) ?? { sectionKey: comment.sectionKey, commentCount: 0 };
      cell.commentCount += 1;
      cells.set(comment.sectionKey, cell);
    }
  }
  return [...cells.values()].sort((a, b) => a.sectionKey.localeCompare(b.sectionKey));
}

function buildRecurringGaps(entries: SkillAccumulator['docs']): SkillHealthRecurringGap[] {
  const bySection = new Map<string, { section: string; occurrences: number; docs: Set<string>; samples: string[] }>();
  for (const { doc } of entries) {
    for (const gap of collectValidationGaps(doc.scorecard)) {
      if (gap.resolution === 'accepted' || gap.resolution === 'deferred') continue;
      const label = (gap.section || gap.file || 'Unspecified').trim();
      const key = label.toLowerCase();
      const bucket = bySection.get(key) ?? {
        section: label,
        occurrences: 0,
        docs: new Set<string>(),
        samples: [],
      };
      bucket.occurrences += 1;
      bucket.docs.add(doc.id);
      if (gap.description && bucket.samples.length < SAMPLE_LIMIT && !bucket.samples.includes(gap.description)) {
        bucket.samples.push(gap.description);
      }
      bySection.set(key, bucket);
    }
  }
  return [...bySection.values()]
    .sort((a, b) => b.docs.size - a.docs.size || b.occurrences - a.occurrences)
    .slice(0, RECURRING_GAP_LIMIT)
    .map((bucket) => ({
      section: bucket.section,
      occurrences: bucket.occurrences,
      documentCount: bucket.docs.size,
      sampleDescriptions: bucket.samples,
      exampleDocumentIds: [...bucket.docs].slice(0, SAMPLE_LIMIT),
    }));
}

function acceptanceRateOf(entries: SkillAccumulator['docs']): number | null {
  const accepted = entries.filter((e) => ACCEPTED_STATUSES.has(e.doc.status)).length;
  const revisionRequested = entries.filter((e) => e.doc.status === 'revision_requested').length;
  return ratio(accepted, accepted + revisionRequested);
}

function passRateOf(entries: SkillAccumulator['docs']): number | null {
  const judged = entries.filter((e) => e.passed !== null);
  return ratio(judged.filter((e) => e.passed).length, judged.length);
}

function roundInterval(interval: { low: number; high: number } | null, digits: number): SkillHealthInterval | null {
  if (!interval) return null;
  const factor = 10 ** digits;
  return { low: Math.round(interval.low * factor) / factor, high: Math.round(interval.high * factor) / factor };
}

function versionIntervals(list: SkillAccumulator['docs']): Pick<SkillHealthVersion, 'scoreInterval' | 'passRateInterval' | 'sufficientSample'> {
  const scores = list.flatMap((e) => (e.score === null ? [] : [e.score]));
  const judged = list.filter((e) => e.passed !== null);
  return {
    scoreInterval: roundInterval(meanInterval(scores), 1),
    passRateInterval: roundInterval(wilsonInterval(judged.filter((e) => e.passed).length, judged.length), 3),
    sufficientSample: scores.length >= SKILL_HEALTH_MIN_SCORED_DOCUMENTS,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildModels(entries: SkillAccumulator['docs'], costByDoc: Map<string, number>): SkillHealthModelBreakdown[] {
  const byModel = new Map<string, SkillAccumulator['docs']>();
  for (const entry of entries) {
    const key = `${entry.doc.model ?? ''}|${entry.doc.effort ?? ''}`;
    const list = byModel.get(key);
    if (list) list.push(entry);
    else byModel.set(key, [entry]);
  }
  return [...byModel.values()]
    .map((list) => {
      const scored = list.flatMap((e) => (e.score === null ? [] : [e.score]));
      const cost = list.reduce((sum, e) => sum + (costByDoc.get(docKey(e.doc.kind, e.doc.id)) ?? 0), 0);
      return {
        model: list[0].doc.model ?? null,
        effort: list[0].doc.effort ?? null,
        documents: list.length,
        averageScore: average(scored),
        acceptanceRate: acceptanceRateOf(list),
        costPerDocument: round(cost / list.length, 2),
      };
    })
    .sort((a, b) => b.documents - a.documents);
}

const ASSISTANT_SURFACE: Record<SkillHealthArtifactKind, SkillLearningSurface> = {
  prd: 'prd_assistant',
  design_doc: 'design_doc_assistant',
};

function buildEfficiency(
  entries: SkillAccumulator['docs'],
  costUsd: number,
  signalsByDoc: Map<string, SkillSignalRowInput[]>,
): SkillHealthEfficiency {
  const accepted = entries.filter((e) => ACCEPTED_STATUSES.has(e.doc.status));
  const hours = accepted.flatMap(({ doc }) => {
    if (!doc.reviewedAt) return [];
    const elapsed = (Date.parse(doc.reviewedAt) - Date.parse(doc.createdAt)) / 3_600_000;
    return Number.isFinite(elapsed) && elapsed >= 0 ? [elapsed] : [];
  });
  const rounds: number[] = [];
  let retries = 0;
  for (const { doc } of accepted) {
    const signals = signalsByDoc.get(doc.id) ?? [];
    const reviews = signals.filter((s) => s.surface === doc.kind && s.metadata?.source === 'review');
    if (reviews.length > 0) rounds.push(1 + reviews.filter((s) => s.kind === 'rejected').length);
    retries += signals.filter(
      (s) => s.surface === ASSISTANT_SURFACE[doc.kind] && (s.kind === 'regenerated' || s.kind === 'rejected'),
    ).length;
  }
  return {
    accepted: accepted.length,
    medianHoursToApproval: round(median(hours), 1),
    reviewRoundsPerAccepted: rounds.length === 0 ? null : round(rounds.reduce((a, b) => a + b, 0) / rounds.length, 2),
    costPerAccepted: accepted.length === 0 ? null : round(costUsd / accepted.length, 2),
    assistantRetriesPerAccepted: accepted.length === 0 ? null : round(retries / accepted.length, 2),
  };
}

function buildVersions(
  entries: SkillAccumulator['docs'],
  humanEvents: SkillHealthEvaluationEventInput[],
): SkillHealthVersion[] {
  const byVersion = new Map<string | null, SkillAccumulator['docs']>();
  for (const entry of entries) {
    const list = byVersion.get(entry.doc.skillSha256);
    if (list) list.push(entry);
    else byVersion.set(entry.doc.skillSha256, [entry]);
  }
  return [...byVersion.entries()]
    .map(([skillSha256, list]) => {
      const scored = list.filter((e) => e.score !== null);
      const created = list.map((e) => e.doc.createdAt).sort();
      return {
        skillSha256,
        documents: list.length,
        scoredDocuments: scored.length,
        averageScore: average(scored.map((e) => e.score as number)),
        passRate: passRateOf(list),
        acceptanceRate: acceptanceRateOf(list),
        firstSeen: created[0],
        lastSeen: created[created.length - 1],
        ...humanStats(humanEvents.filter((e) => (e.skillVersion ?? null) === skillSha256)),
        ...versionIntervals(list),
      };
    })
    .sort((a, b) =>
      Number(a.skillSha256 === null) - Number(b.skillSha256 === null) || b.lastSeen.localeCompare(a.lastSeen),
    );
}

function defaultSettingsByProject(settings: SkillHealthSettingsInput[]): Map<string, SkillHealthSettingsInput> {
  const byProject = new Map<string, SkillHealthSettingsInput>();
  for (const s of settings) {
    if (s.isDefault || !byProject.has(s.project)) byProject.set(s.project, s);
  }
  return byProject;
}

export function buildSkillHealthSkills(inputs: SkillHealthInputs): SkillHealthSkill[] {
  const settingsById = new Map(inputs.settings.map((s) => [s.id, s]));
  const defaultByProject = defaultSettingsByProject(inputs.settings);

  const commentsByDoc = new Map<string, SkillHealthCommentInput[]>();
  for (const c of inputs.comments) {
    const key = docKey(c.documentType, c.documentId);
    const list = commentsByDoc.get(key);
    if (list) list.push(c);
    else commentsByDoc.set(key, [c]);
  }
  const costByDoc = new Map<string, number>();
  for (const c of inputs.costs) {
    const key = docKey(c.documentType, c.documentId);
    costByDoc.set(key, (costByDoc.get(key) ?? 0) + c.costUsd);
  }
  const documentEventsBySkill = new Map<string, SkillHealthEvaluationEventInput[]>();
  for (const event of enabledEvaluationEvents(inputs)) {
    if (event.subjectType === 'interview_phase') continue;
    const key = `${event.project}:${event.subjectType}:${evaluationSkillPathKey(event.skillPath)}`;
    const list = documentEventsBySkill.get(key);
    if (list) list.push(event);
    else documentEventsBySkill.set(key, [event]);
  }

  const signalProjects = new Set(inputs.evaluationProjects);
  const signalsByDoc = new Map<string, SkillSignalRowInput[]>();
  for (const signal of inputs.signals) {
    if (!signal.subjectId || !signalProjects.has(signal.project)) continue;
    const list = signalsByDoc.get(signal.subjectId);
    if (list) list.push(signal);
    else signalsByDoc.set(signal.subjectId, [signal]);
  }

  const skills = new Map<string, SkillAccumulator>();
  for (const doc of inputs.documents) {
    const attribution = attribute(doc, settingsById, defaultByProject);
    const key = `${doc.project}:${doc.kind}:${(attribution.skillPath ?? '').toLowerCase()}`;
    const acc = skills.get(key) ?? {
      project: doc.project,
      artifactKind: doc.kind,
      skillPath: attribution.skillPath,
      docs: [],
      attribution: { 'document-settings': 0, 'project-default': 0, unattributed: 0 },
    };
    const score = scoreOf(doc);
    acc.docs.push({ doc, score, passed: score === null ? null : passes(doc, score, attribution.threshold) });
    acc.attribution[attribution.source] += 1;
    skills.set(key, acc);
  }

  return [...skills.entries()]
    .map(([key, acc]) => {
      const scored = acc.docs.filter((e) => e.score !== null);
      const revisionRequested = acc.docs.filter((e) => e.doc.status === 'revision_requested').length;
      const passRate = passRateOf(acc.docs);
      const reviewComments = acc.docs.reduce(
        (sum, e) => sum + (commentsByDoc.get(docKey(e.doc.kind, e.doc.id))?.length ?? 0),
        0,
      );
      const costUsd = acc.docs.reduce((sum, e) => sum + (costByDoc.get(docKey(e.doc.kind, e.doc.id)) ?? 0), 0);

      return {
        key,
        project: acc.project,
        artifactKind: acc.artifactKind,
        skillPath: acc.skillPath,
        status: deriveStatus(scored.length, passRate),
        documents: acc.docs.length,
        scoredDocuments: scored.length,
        averageScore: average(scored.map((e) => e.score as number)),
        passRate,
        acceptanceRate: acceptanceRateOf(acc.docs),
        revisionRequested,
        overrides: acc.docs.filter((e) => e.doc.hasOverride).length,
        generationFailures: acc.docs.filter((e) => e.doc.status === 'generation_failed').length,
        reviewComments,
        commentsPerDocument: ratio(reviewComments, acc.docs.length),
        costUsd: Math.round(costUsd * 100) / 100,
        costPerDocument: acc.docs.length === 0 ? null : Math.round((costUsd / acc.docs.length) * 100) / 100,
        attribution: acc.attribution,
        trend: buildTrend(acc.docs),
        sections: buildSections(acc.docs, commentsByDoc),
        recurringGaps: buildRecurringGaps(acc.docs),
        versions: buildVersions(acc.docs, documentEventsBySkill.get(key) ?? []),
        models: buildModels(acc.docs, costByDoc),
        efficiency: buildEfficiency(acc.docs, costUsd, signalsByDoc),
      };
    })
    .sort((a, b) => b.documents - a.documents);
}

export function buildSkillHealthProjects(inputs: SkillHealthInputs): SkillHealthProject[] {
  const defaultByProject = defaultSettingsByProject(inputs.settings);
  const byProject = new Map<string, SkillHealthSkill[]>();
  for (const skill of buildSkillHealthSkills(inputs)) {
    const list = byProject.get(skill.project);
    if (list) list.push(skill);
    else byProject.set(skill.project, [skill]);
  }
  const enabledEvents = enabledEvaluationEvents(inputs);
  const evaluationEnabled = new Set(inputs.evaluationProjects);
  const enabledSignals = inputs.signals.filter((s) => evaluationEnabled.has(s.project));
  for (const row of [...enabledEvents, ...enabledSignals]) {
    if (!byProject.has(row.project)) byProject.set(row.project, []);
  }
  const eventIds = new Set(enabledEvents.map((e) => e.id));
  const jobs = inputs.evaluationJobs.filter((j) => eventIds.has(j.eventId));

  return [...byProject.entries()]
    .map(([project, skills]) => ({
      project,
      skillRepo: defaultByProject.get(project)?.skillRepo ?? null,
      isFoundation: project === SKILL_HEALTH_FOUNDATION_PROJECT,
      skills,
      evaluation: evaluationEnabled.has(project)
        ? buildProjectEvaluation(project, enabledEvents.filter((e) => e.project === project), jobs)
        : null,
      signals: evaluationEnabled.has(project)
        ? buildProjectSignals(enabledSignals.filter((s) => s.project === project))
        : null,
    }))
    .sort((a, b) => Number(b.isFoundation) - Number(a.isFoundation) || a.project.localeCompare(b.project));
}
