/**
 * Every Apex surface that feeds Skill Learning. Adding a surface is one entry
 * here; `skill_signals.surface` is not constrained in the database.
 */

export const SKILL_SIGNAL_KINDS = [
  'rating',
  'accepted',
  'rejected',
  'regenerated',
  'rolled_back',
  'handoff_completed',
  'handoff_failed',
  'gate_approved',
  'gate_rejected',
  'run_failed',
  'completed',
  'abandoned',
  'judged',
] as const;
export type SkillSignalKind = (typeof SKILL_SIGNAL_KINDS)[number];

/**
 * Whether a signal says the skill's output was kept (+1) or thrown away (-1).
 * `rating` takes its sign from the value; neutral kinds count toward volume only.
 */
export const SKILL_SIGNAL_POLARITY: Record<SkillSignalKind, 1 | -1 | 0> = {
  rating: 0,
  accepted: 1,
  rejected: -1,
  regenerated: -1,
  rolled_back: -1,
  handoff_completed: 1,
  handoff_failed: -1,
  gate_approved: 1,
  gate_rejected: -1,
  run_failed: -1,
  completed: 1,
  abandoned: -1,
  judged: 0,
};

export interface SkillLearningSurfaceDefinition {
  key: string;
  label: string;
  /** Where the explicit feedback and automatic signals come from, in plain words. */
  signalSources: string;
  /** True when the surface also has rubric review and judge/Promptfoo evaluation. */
  rubricEvaluated: boolean;
}

export const SKILL_LEARNING_SURFACES = [
  { key: 'interview', label: 'Interviews', signalSources: 'Thumbs per question, phase feedback', rubricEvaluated: true },
  { key: 'prd', label: 'PRDs', signalSources: 'Quality review, every approver and owner decision', rubricEvaluated: true },
  { key: 'design_doc', label: 'Design docs', signalSources: 'Quality review, every approver and owner decision', rubricEvaluated: true },
  { key: 'test_cases', label: 'Test cases', signalSources: 'Quality review, QA approver and owner decisions', rubricEvaluated: true },
  { key: 'home_chat', label: 'Home chat', signalSources: 'Rating per reply', rubricEvaluated: false },
  { key: 'adr', label: 'ADRs', signalSources: 'ADR generation finished or produced nothing, approver and owner decisions, optional rating', rubricEvaluated: false },
  { key: 'adr_assistant', label: 'ADR assistant', signalSources: 'Proposed edits applied (as-is or edited) or rejected, rating per reply', rubricEvaluated: false },
  { key: 'prd_assistant', label: 'PRD assistant', signalSources: 'Proposed edits applied, rejected or regenerated, rating per reply', rubricEvaluated: false },
  { key: 'design_doc_assistant', label: 'Design doc assistant', signalSources: 'Proposed edits applied, rejected or regenerated, rating per reply', rubricEvaluated: false },
  { key: 'brainstorm', label: 'Brainstorm', signalSources: 'Handoffs completed or failed, artifact rollbacks, rating per artifact version', rubricEvaluated: false },
  { key: 'playbook', label: 'Playbooks', signalSources: 'Gate approvals and rejections, failed steps, rating per finished run', rubricEvaluated: false },
  { key: 'build_intake', label: 'Build intake', signalSources: 'Drafted brief approved (with or without edits) or abandoned, rating per brief version', rubricEvaluated: false },
  { key: 'qa_lab', label: 'QA Lab', signalSources: 'Assistant proposals applied or discarded, case regenerations, rating of the latest reply', rubricEvaluated: false },
] as const satisfies readonly SkillLearningSurfaceDefinition[];

export type SkillLearningSurface = (typeof SKILL_LEARNING_SURFACES)[number]['key'];

export function isSkillLearningSurface(value: unknown): value is SkillLearningSurface {
  return SKILL_LEARNING_SURFACES.some((surface) => surface.key === value);
}

export function isSkillSignalKind(value: unknown): value is SkillSignalKind {
  return (SKILL_SIGNAL_KINDS as readonly unknown[]).includes(value);
}
