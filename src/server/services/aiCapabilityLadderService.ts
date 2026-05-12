/**
 * AI Capability Ladder scoring service.
 *
 * Combines Cursor Admin/Analytics data (definitive) with ADO delivery
 * metrics (definitive) and baseline config (configured) to produce a
 * fully scored AiCapabilityLadderResult.
 *
 * Evidence quality labels:
 *  - definitive  : direct API data (Cursor or ADO)
 *  - configured  : admin-entered baseline or override values
 *  - inferred    : proxied from indirect signal (e.g. design-doc = orchestrator)
 */

import type {
  AiCapabilityLadderResult,
  LadderBar,
  LadderCriterion,
  CriterionStatus,
  DeveloperGap,
  AiCodeWorkItemAdoptionSummary,
} from '../types/aiCapabilityLadder';
import type { CursorTeamSummary, CursorDeveloperSummary } from '../types/cursorAnalytics';
import type { AiCapabilityBaseline } from '../types/aiCapabilityLadder';

// ── Threshold constants ────────────────────────────────────────────────────────
const B1_SEAT_COVERAGE = 1.0;       // 100% of ADO devs have Cursor seats
const B1_DAU_FRACTION = 0.50;       // >=50% DAU
const B1_DAU_WEEKS = 2;             // sustained 2+ weeks
const B1_FEATURES_SPECFLOW = 3;     // >=3 features via spec-driven flow
const B2_DAU_FRACTION = 0.80;       // >=80% DAU
const B2_DAU_WEEKS = 4;             // sustained 4+ weeks
const B2_ORCHESTRATOR_PCT = 0.50;   // >=50% new features via orchestrator
const B2_CYCLE_TIME_IMPROVEMENT = 0.20; // PR cycle time -20%
const B2_LEAD_TIME_IMPROVEMENT = 0.15;  // lead time -15%
const B2_SKILLS_IN_USE = 1;         // >=1 team-specific skill
const B3_DAU_FRACTION = 0.80;       // >=80% DAU steady state
const B3_ORCHESTRATOR_PCT = 0.70;   // >=70% new features via orchestrator
const B3_CYCLE_TIME_IMPROVEMENT = 0.30; // PR cycle time -30%
const B3_LEAD_TIME_IMPROVEMENT = 0.25;  // lead time -25%
const B3_SKILLS_CONTRIBUTED = 2;    // >=2 skills contributed to shared registry

// ── Helpers ────────────────────────────────────────────────────────────────────

function pct(v: number): string { return `${Math.round(v * 100)}%`; }
function days(v: number | null): string { return v !== null ? `${v.toFixed(1)}d` : 'n/a'; }

function statusFromValue(
  current: number | null,
  target: number,
  atRiskThreshold = 0.85,
): CriterionStatus {
  if (current === null) return 'unknown';
  if (current >= target) return 'met';
  if (current >= target * atRiskThreshold) return 'at-risk';
  return 'not-met';
}

function worstStatus(criteria: LadderCriterion[]): CriterionStatus {
  const rank: Record<CriterionStatus, number> = { met: 0, 'at-risk': 1, 'not-met': 2, unknown: 3 };
  return criteria.reduce<CriterionStatus>((worst, c) => {
    return rank[c.status] > rank[worst] ? c.status : worst;
  }, 'met');
}

function devsNeedingLift(
  developers: CursorDeveloperSummary[],
  adoMembers: string[],
  field: keyof Pick<CursorDeveloperSummary, 'dauFraction' | 'totalAccepts' | 'cmdkUsages'>,
  target: number,
  action: string,
): DeveloperGap[] {
  const result: DeveloperGap[] = [];
  for (const dev of developers) {
    if (adoMembers.length > 0 && !adoMembers.some(m => namesMatch(m, dev.name, dev.email))) continue;
    const val = dev[field] as number;
    if (val < target) {
      result.push({
        name: dev.name,
        email: dev.email,
        currentValue: val,
        currentDisplay: typeof val === 'number' && field === 'dauFraction' ? pct(val) : String(val),
        action,
      });
    }
  }
  return result;
}

/** Loose identity matching: ADO display name vs Cursor name or email prefix */
function namesMatch(adoName: string, cursorName: string, cursorEmail: string): boolean {
  const norm = (s: string) => s.toLowerCase().trim();
  if (norm(adoName) === norm(cursorName)) return true;
  // "First Last" vs email "first.last@..."
  const emailPrefix = cursorEmail.split('@')[0]?.replace(/[._-]/g, ' ') ?? '';
  return norm(adoName) === norm(emailPrefix);
}

function devsWithoutCursorActivity(
  developers: CursorDeveloperSummary[],
  adoMembers: string[],
): DeveloperGap[] {
  // ADO members who have no matching Cursor entry with activeDays > 0
  return adoMembers
    .filter(adoName => {
      const found = developers.find(d => namesMatch(adoName, d.name, d.email));
      return !found || found.activeDays === 0;
    })
    .map(adoName => {
      const found = developers.find(d => namesMatch(adoName, d.name, d.email));
      return {
        name: adoName,
        email: found?.email ?? '',
        currentValue: 0,
        currentDisplay: '0 active days',
        action: 'Ensure Cursor seat is assigned and guide first AI-assisted workflow',
      };
    });
}

function aiCodeWorkItemGaps(
  aiCodeAdoption: AiCodeWorkItemAdoptionSummary,
  target: number,
): DeveloperGap[] {
  return aiCodeAdoption.developerAdoption
    .filter(dev => dev.totalAssignedWorkItems > 0 && dev.adoptionRate < target)
    .map(dev => ({
      name: dev.developer,
      email: '',
      currentValue: dev.adoptionRate,
      currentDisplay: `${dev.aiCodeWorkItems}/${dev.totalAssignedWorkItems} (${pct(dev.adoptionRate)}) ai-code tagged`,
      action: `Tag AI-assisted work with ai-code and use AI workflow on at least ${pct(target)} of assigned items`,
    }));
}

// ── Scoring ────────────────────────────────────────────────────────────────────

function scoreBar1(
  cursor: CursorTeamSummary,
  adoMembers: string[],
  kickoffCount: number,
  baseline: AiCapabilityBaseline,
  cursorDataAvailable: boolean,
): LadderBar {
  const adoSize = adoMembers.length || cursor.teamSize;

  // 1a. Seat coverage — unknown when Cursor API unreachable
  const seatCrit: LadderCriterion = !cursorDataAvailable
    ? unknownCursorCriterion(
        'b1-seats', '100% Cursor seats assigned', 'adoption',
        '100% of ADO team members have a Cursor seat',
        B1_SEAT_COVERAGE, `${adoSize}/${adoSize} (100%)`,
      )
    : (() => {
        const seatCoverage = adoSize > 0 ? cursor.activeSeats / adoSize : null;
        // Developers who are on the ADO roster but whose name/email doesn't appear in Cursor
        const missingFromCursor = adoMembers.filter(
          name => !cursor.developers.some(d => namesMatch(name, d.name, d.email))
        );
        return {
          id: 'b1-seats',
          label: '100% Cursor seats assigned',
          category: 'adoption' as const,
          status: (seatCoverage !== null
            ? (seatCoverage >= B1_SEAT_COVERAGE ? 'met' : seatCoverage >= 0.8 ? 'at-risk' : 'not-met')
            : 'unknown') as CriterionStatus,
          evidenceQuality: 'definitive' as const,
          threshold: '100% of ADO team members have a Cursor seat',
          targetValue: B1_SEAT_COVERAGE,
          currentValue: seatCoverage,
          currentDisplay: seatCoverage !== null
            ? `${cursor.activeSeats}/${adoSize} seats (${pct(seatCoverage)})`
            : 'unknown',
          targetDisplay: `${adoSize}/${adoSize} (100%)`,
          gapDisplay: seatCoverage !== null && seatCoverage < 1
            ? `${missingFromCursor.length} member(s) not matched in Cursor: ${missingFromCursor.slice(0, 3).join(', ')}${missingFromCursor.length > 3 ? '…' : ''}`
            : null,
          evidenceSource: 'Cursor Admin API /teams/members matched against ADO team roster',
          developersNeedingLift: missingFromCursor.map(name => ({
            name,
            email: '',
            currentValue: 0,
            currentDisplay: 'Not matched in Cursor',
            action: 'Assign Cursor seat, or add email-to-name override if display name differs',
          })),
        };
      })();

  // 1b. >=50% DAU sustained 2+ weeks
  const dauMet = cursor.weeksAbove50pct >= B1_DAU_WEEKS;
  const dauCrit: LadderCriterion = !cursorDataAvailable
    ? unknownCursorCriterion(
        'b1-dau', '>=50% Cursor DAU sustained 2+ weeks', 'adoption',
        '>=50% of team active in Cursor each day, for at least 2 consecutive weeks',
        B1_DAU_WEEKS, `${B1_DAU_WEEKS}+ consecutive weeks`,
      )
    : {
        id: 'b1-dau',
        label: '>=50% Cursor DAU sustained 2+ weeks',
        category: 'adoption',
        status: dauMet ? 'met' : (cursor.weeksAbove50pct >= 1 ? 'at-risk' : 'not-met'),
        evidenceQuality: 'definitive',
        threshold: '>=50% of team active in Cursor each day, for at least 2 consecutive weeks',
        targetValue: B1_DAU_WEEKS,
        currentValue: cursor.weeksAbove50pct,
        currentDisplay: `${cursor.weeksAbove50pct} week(s) at >=50% DAU`,
        targetDisplay: `${B1_DAU_WEEKS}+ consecutive weeks`,
        gapDisplay: !dauMet ? `Need ${B1_DAU_WEEKS - cursor.weeksAbove50pct} more week(s)` : null,
        evidenceSource: 'Cursor Analytics API /analytics/team/dau',
        developersNeedingLift: devsNeedingLift(
          cursor.developers, adoMembers, 'dauFraction', B1_DAU_FRACTION,
          `Increase daily Cursor usage — target at least ${pct(B1_DAU_FRACTION)} of working days`,
        ),
      };

  // 1c. >=3 features via spec-driven / AI-orchestrated flow
  const specFlowMet = kickoffCount >= B1_FEATURES_SPECFLOW;
  const specCrit: LadderCriterion = {
    id: 'b1-specflow',
    label: `>=${B1_FEATURES_SPECFLOW} features via spec-driven AI flow`,
    category: 'practice',
    status: specFlowMet ? 'met' : (kickoffCount >= 1 ? 'at-risk' : 'not-met'),
    evidenceQuality: 'inferred',
    threshold: `>=${B1_FEATURES_SPECFLOW} work items have a design-doc kickoff committed to the repo`,
    targetValue: B1_FEATURES_SPECFLOW,
    currentValue: kickoffCount,
    currentDisplay: `${kickoffCount} kickoff doc(s)`,
    targetDisplay: `${B1_FEATURES_SPECFLOW}+`,
    gapDisplay: !specFlowMet ? `${B1_FEATURES_SPECFLOW - kickoffCount} more kickoff doc(s) needed` : null,
    evidenceSource: 'ADO /design-doc Git folder (proxy for spec-driven orchestrator flow)',
    developersNeedingLift: [],
  };

  // 1d. Baseline captured
  const hasBaseline = !!baseline.capturedAt && (
    baseline.prCycleTimeDays !== null ||
    baseline.leadTimeDays !== null ||
    baseline.defectRatePerPbi !== null
  );
  const baselineCrit: LadderCriterion = {
    id: 'b1-baseline',
    label: 'Pre-AI baseline captured',
    category: 'outcomes',
    status: hasBaseline ? 'met' : 'not-met',
    evidenceQuality: 'configured',
    threshold: 'PR cycle time, lead time, and defect rate baseline values are recorded',
    targetValue: 1,
    currentValue: hasBaseline ? 1 : 0,
    currentDisplay: hasBaseline ? `Baseline from ${baseline.capturedAt}` : 'Not set',
    targetDisplay: 'Baseline recorded',
    gapDisplay: !hasBaseline ? 'Edit data/ai-capability-baseline.json with pre-AI measurements' : null,
    evidenceSource: 'data/ai-capability-baseline.json (configured)',
    developersNeedingLift: [],
  };

  const criteria = [seatCrit, dauCrit, specCrit, baselineCrit];
  return { bar: 'bar1', title: 'Bar 1 — Foundation', status: worstStatus(criteria), criteria };
}

function scoreBar2(
  cursor: CursorTeamSummary,
  adoMembers: string[],
  kickoffCount: number,
  totalEligibleFeatures: number,
  aiCodeAdoption: AiCodeWorkItemAdoptionSummary,
  avgPrCycleTimeDays: number | null,
  avgLeadTimeDays: number | null,
  avgDefectRate: number | null,
  baseline: AiCapabilityBaseline,
  cursorDataAvailable: boolean,
): LadderBar {
  // 2a. >=80% DAU sustained 4+ weeks
  const dau4wMet = cursor.weeksAbove80pct >= B2_DAU_WEEKS;
  const dau4wCrit: LadderCriterion = !cursorDataAvailable
    ? unknownCursorCriterion(
        'b2-dau', '>=80% Cursor DAU sustained 4+ weeks', 'adoption',
        '>=80% of team active in Cursor each day, for at least 4 consecutive weeks',
        B2_DAU_WEEKS, `${B2_DAU_WEEKS}+ consecutive weeks`,
      )
    : {
        id: 'b2-dau',
        label: '>=80% Cursor DAU sustained 4+ weeks',
        category: 'adoption',
        status: dau4wMet ? 'met' : (cursor.weeksAbove80pct >= 2 ? 'at-risk' : 'not-met'),
        evidenceQuality: 'definitive',
        threshold: '>=80% of team active in Cursor each day, for at least 4 consecutive weeks',
        targetValue: B2_DAU_WEEKS,
        currentValue: cursor.weeksAbove80pct,
        currentDisplay: `${cursor.weeksAbove80pct} week(s) at >=80% DAU`,
        targetDisplay: `${B2_DAU_WEEKS}+ consecutive weeks`,
        gapDisplay: !dau4wMet ? `Need ${B2_DAU_WEEKS - cursor.weeksAbove80pct} more week(s)` : null,
        evidenceSource: 'Cursor Analytics API /analytics/team/dau',
        developersNeedingLift: devsNeedingLift(
          cursor.developers, adoMembers, 'dauFraction', B2_DAU_FRACTION,
          `Increase daily Cursor usage — target at least ${pct(B2_DAU_FRACTION)} of working days`,
        ),
      };

  // 2b. >=50% work items use AI coding workflow (ai-code tag)
  const orchFraction = aiCodeAdoption.adoptionRate;
  const orchMet = orchFraction !== null && orchFraction >= B2_ORCHESTRATOR_PCT;
  const orchCrit: LadderCriterion = {
    id: 'b2-orchestrator',
    label: `>=${pct(B2_ORCHESTRATOR_PCT)} work items tagged ai-code`,
    category: 'practice',
    status: orchFraction !== null ? statusFromValue(orchFraction, B2_ORCHESTRATOR_PCT) : 'unknown',
    evidenceQuality: 'definitive',
    threshold: `>=${pct(B2_ORCHESTRATOR_PCT)} of ADO work items that went In Progress in the last 4 weeks have the ai-code tag`,
    targetValue: B2_ORCHESTRATOR_PCT,
    currentValue: orchFraction,
    currentDisplay: orchFraction !== null
      ? `${pct(orchFraction)} (${aiCodeAdoption.aiCodeWorkItems}/${aiCodeAdoption.totalAssignedWorkItems})`
      : 'No assigned work items in window',
    targetDisplay: `>=${pct(B2_ORCHESTRATOR_PCT)}`,
    gapDisplay: orchFraction !== null && !orchMet
      ? `${Math.ceil(aiCodeAdoption.totalAssignedWorkItems * B2_ORCHESTRATOR_PCT) - aiCodeAdoption.aiCodeWorkItems} more work item(s) need ai-code`
      : null,
    evidenceSource: 'ADO PBI/TBI/Bug whose ActivatedDate falls in the last 4 weeks; developer attributed to assignee at first In Progress revision.',
    developersNeedingLift: aiCodeWorkItemGaps(aiCodeAdoption, B2_ORCHESTRATOR_PCT),
  };

  // 2c. AI standard for review/test/doc gen — use skills + agent edits + MCP as signal
  const hasAiReviewSignal = cursor.agentEditAcceptRate > 0 || cursor.totalSkillUsages > 0 || cursor.mcpToolsInUse.length > 0;
  const aiStandardCrit: LadderCriterion = !cursorDataAvailable
    ? unknownCursorCriterion(
        'b2-ai-standard', 'AI standard for code review, test gen, doc gen', 'practice',
        'Agent edits, Skills, and/or MCP tools are actively used for review/test/doc workflows',
        1, 'Active agent/skill/MCP usage on review+test+doc',
      )
    : {
        id: 'b2-ai-standard',
        label: 'AI standard for code review, test gen, doc gen',
        category: 'practice',
        status: hasAiReviewSignal ? 'at-risk' : 'not-met',
        evidenceQuality: 'definitive',
        threshold: 'Agent edits, Skills, and/or MCP tools are actively used for review/test/doc workflows',
        targetValue: 1,
        currentValue: hasAiReviewSignal ? 1 : 0,
        currentDisplay: hasAiReviewSignal
          ? `Agent accept rate: ${pct(cursor.agentEditAcceptRate)}, Skills: ${cursor.skillsInUse.length}, MCP tools: ${cursor.mcpToolsInUse.length}`
          : 'No evidence',
        targetDisplay: 'Active agent/skill/MCP usage on review+test+doc',
        gapDisplay: !hasAiReviewSignal ? 'No agent edits, skills, or MCP tool usage detected' : null,
        evidenceSource: 'Cursor Analytics API /analytics/team/agent-edits, /skills, /mcp',
        developersNeedingLift: [],
      };

  // 2d. PR cycle time -20% vs baseline
  const cycleImprovement = baseline.prCycleTimeDays && avgPrCycleTimeDays !== null
    ? (baseline.prCycleTimeDays - avgPrCycleTimeDays) / baseline.prCycleTimeDays
    : null;
  const cycleMet = cycleImprovement !== null && cycleImprovement >= B2_CYCLE_TIME_IMPROVEMENT;
  const cycleCrit: LadderCriterion = {
    id: 'b2-cycle',
    label: `PR cycle time -${pct(B2_CYCLE_TIME_IMPROVEMENT)} vs baseline`,
    category: 'outcomes',
    status: cycleImprovement !== null ? statusFromValue(cycleImprovement, B2_CYCLE_TIME_IMPROVEMENT) : 'unknown',
    evidenceQuality: cycleImprovement !== null ? 'definitive' : 'configured',
    threshold: `PR cycle time at least ${pct(B2_CYCLE_TIME_IMPROVEMENT)} better than pre-AI baseline`,
    targetValue: B2_CYCLE_TIME_IMPROVEMENT,
    currentValue: cycleImprovement,
    currentDisplay: cycleImprovement !== null
      ? `${days(avgPrCycleTimeDays)} current vs ${days(baseline.prCycleTimeDays)} baseline (${pct(cycleImprovement)} improvement)`
      : `${days(avgPrCycleTimeDays)} current (no baseline set)`,
    targetDisplay: `>=${pct(B2_CYCLE_TIME_IMPROVEMENT)} reduction`,
    gapDisplay: !cycleMet && cycleImprovement !== null
      ? `Need ${pct(B2_CYCLE_TIME_IMPROVEMENT - cycleImprovement)} more reduction`
      : (!cycleMet ? 'Set baseline in data/ai-capability-baseline.json' : null),
    evidenceSource: 'ADO /api/pull-request-time-stats, baseline from config',
    developersNeedingLift: [],
  };

  // 2e. Lead time -15%
  const leadImprovement = baseline.leadTimeDays && avgLeadTimeDays !== null
    ? (baseline.leadTimeDays - avgLeadTimeDays) / baseline.leadTimeDays
    : null;
  const leadMet = leadImprovement !== null && leadImprovement >= B2_LEAD_TIME_IMPROVEMENT;
  const leadCrit: LadderCriterion = {
    id: 'b2-lead',
    label: `Lead time -${pct(B2_LEAD_TIME_IMPROVEMENT)} vs baseline`,
    category: 'outcomes',
    status: leadImprovement !== null ? statusFromValue(leadImprovement, B2_LEAD_TIME_IMPROVEMENT) : 'unknown',
    evidenceQuality: leadImprovement !== null ? 'definitive' : 'configured',
    threshold: `Lead time at least ${pct(B2_LEAD_TIME_IMPROVEMENT)} better than pre-AI baseline`,
    targetValue: B2_LEAD_TIME_IMPROVEMENT,
    currentValue: leadImprovement,
    currentDisplay: leadImprovement !== null
      ? `${days(avgLeadTimeDays)} current vs ${days(baseline.leadTimeDays)} baseline (${pct(leadImprovement)} improvement)`
      : `${days(avgLeadTimeDays)} current (no baseline set)`,
    targetDisplay: `>=${pct(B2_LEAD_TIME_IMPROVEMENT)} reduction`,
    gapDisplay: !leadMet && leadImprovement !== null
      ? `Need ${pct(B2_LEAD_TIME_IMPROVEMENT - leadImprovement)} more reduction`
      : (!leadMet ? 'Set baseline in data/ai-capability-baseline.json' : null),
    evidenceSource: 'ADO /api/in-progress-stats, baseline from config',
    developersNeedingLift: [],
  };

  // 2f. Defect rate flat or better
  const defectOk = avgDefectRate !== null && baseline.defectRatePerPbi !== null
    ? avgDefectRate <= baseline.defectRatePerPbi
    : null;
  const defectCrit: LadderCriterion = {
    id: 'b2-defect',
    label: 'Defect rate flat or better',
    category: 'outcomes',
    status: defectOk === null ? 'unknown' : (defectOk ? 'met' : 'not-met'),
    evidenceQuality: defectOk !== null ? 'definitive' : 'configured',
    threshold: 'QA bug rate per PBI is equal to or lower than baseline',
    targetValue: baseline.defectRatePerPbi ?? 0,
    currentValue: avgDefectRate,
    currentDisplay: avgDefectRate !== null ? `${avgDefectRate.toFixed(2)} bugs/PBI` : 'unknown',
    targetDisplay: baseline.defectRatePerPbi !== null ? `<=${baseline.defectRatePerPbi.toFixed(2)} bugs/PBI` : 'baseline not set',
    gapDisplay: defectOk === false ? `Current rate ${avgDefectRate?.toFixed(2)} exceeds baseline ${baseline.defectRatePerPbi?.toFixed(2)}` : null,
    evidenceSource: 'ADO /api/qa-bug-stats, baseline from config',
    developersNeedingLift: [],
  };

  // 2g. >=1 team-specific skill in active use
  const skillsMet = cursor.skillsInUse.length >= B2_SKILLS_IN_USE;
  const skillsCrit: LadderCriterion = !cursorDataAvailable
    ? unknownCursorCriterion(
        'b2-skills', `>=${B2_SKILLS_IN_USE} team-specific skill in active use`, 'contribution',
        `At least ${B2_SKILLS_IN_USE} Cursor skill has been used by the team`,
        B2_SKILLS_IN_USE, `${B2_SKILLS_IN_USE}+ active skill(s)`,
      )
    : {
        id: 'b2-skills',
        label: `>=${B2_SKILLS_IN_USE} team-specific skill in active use`,
        category: 'contribution',
        status: skillsMet ? 'met' : (cursor.totalSkillUsages > 0 ? 'at-risk' : 'not-met'),
        evidenceQuality: 'definitive',
        threshold: `At least ${B2_SKILLS_IN_USE} Cursor skill has been used by the team`,
        targetValue: B2_SKILLS_IN_USE,
        currentValue: cursor.skillsInUse.length,
        currentDisplay: cursor.skillsInUse.length > 0
          ? `${cursor.skillsInUse.length} skill(s): ${cursor.skillsInUse.slice(0, 3).join(', ')}${cursor.skillsInUse.length > 3 ? '…' : ''}`
          : 'No skills used',
        targetDisplay: `${B2_SKILLS_IN_USE}+ active skill(s)`,
        gapDisplay: !skillsMet ? `${B2_SKILLS_IN_USE - cursor.skillsInUse.length} more skill(s) needed` : null,
        evidenceSource: 'Cursor Analytics API /analytics/team/skills',
        developersNeedingLift: [],
      };

  const criteria = [dau4wCrit, orchCrit, aiStandardCrit, cycleCrit, leadCrit, defectCrit, skillsCrit];
  return { bar: 'bar2', title: 'Bar 2 — Fluency', status: worstStatus(criteria), criteria };
}

function scoreBar3(
  cursor: CursorTeamSummary,
  adoMembers: string[],
  kickoffCount: number,
  totalEligibleFeatures: number,
  aiCodeAdoption: AiCodeWorkItemAdoptionSummary,
  avgPrCycleTimeDays: number | null,
  avgLeadTimeDays: number | null,
  avgDefectRate: number | null,
  deployFrequencyPerMonth: number | null,
  baseline: AiCapabilityBaseline,
  cursorDataAvailable: boolean,
): LadderBar {
  // 3a. >=80% DAU steady state
  const dau3Crit: LadderCriterion = !cursorDataAvailable
    ? unknownCursorCriterion(
        'b3-dau', '>=80% Cursor DAU steady state', 'adoption',
        '>=80% DAU maintained over the full selected window (steady state)',
        8, '8+ consecutive weeks (steady state)',
      )
    : {
        id: 'b3-dau',
        label: '>=80% Cursor DAU steady state',
        category: 'adoption',
        status: cursor.weeksAbove80pct >= 8 ? 'met' : (cursor.weeksAbove80pct >= B2_DAU_WEEKS ? 'at-risk' : 'not-met'),
        evidenceQuality: 'definitive',
        threshold: '>=80% DAU maintained over the full selected window (steady state, not just 4 weeks)',
        targetValue: 8,
        currentValue: cursor.weeksAbove80pct,
        currentDisplay: `${cursor.weeksAbove80pct} consecutive week(s) at >=80% DAU`,
        targetDisplay: '8+ consecutive weeks (steady state)',
        gapDisplay: cursor.weeksAbove80pct < 8 ? `${8 - cursor.weeksAbove80pct} more week(s) needed` : null,
        evidenceSource: 'Cursor Analytics API /analytics/team/dau',
        developersNeedingLift: devsNeedingLift(
          cursor.developers, adoMembers, 'dauFraction', B3_DAU_FRACTION,
          `Sustain daily Cursor usage — all developers should be using AI as default workflow`,
        ),
      };

  // 3b. >=70% work items use AI coding workflow (ai-code tag)
  const orchFraction = aiCodeAdoption.adoptionRate;
  const orch3Crit: LadderCriterion = {
    id: 'b3-orchestrator',
    label: `>=${pct(B3_ORCHESTRATOR_PCT)} work items tagged ai-code`,
    category: 'practice',
    status: orchFraction !== null ? statusFromValue(orchFraction, B3_ORCHESTRATOR_PCT) : 'unknown',
    evidenceQuality: 'definitive',
    threshold: `>=${pct(B3_ORCHESTRATOR_PCT)} of ADO work items that went In Progress in the last 4 weeks have the ai-code tag`,
    targetValue: B3_ORCHESTRATOR_PCT,
    currentValue: orchFraction,
    currentDisplay: orchFraction !== null
      ? `${pct(orchFraction)} (${aiCodeAdoption.aiCodeWorkItems}/${aiCodeAdoption.totalAssignedWorkItems})`
      : 'No assigned work items in window',
    targetDisplay: `>=${pct(B3_ORCHESTRATOR_PCT)}`,
    gapDisplay: orchFraction !== null && orchFraction < B3_ORCHESTRATOR_PCT
      ? `${Math.ceil(aiCodeAdoption.totalAssignedWorkItems * B3_ORCHESTRATOR_PCT) - aiCodeAdoption.aiCodeWorkItems} more work item(s) need ai-code`
      : null,
    evidenceSource: 'ADO PBI/TBI/Bug whose ActivatedDate falls in the last 4 weeks; developer attributed to assignee at first In Progress revision.',
    developersNeedingLift: aiCodeWorkItemGaps(aiCodeAdoption, B3_ORCHESTRATOR_PCT),
  };

  // 3c. PR cycle time -30%
  const cycleImprovement3 = baseline.prCycleTimeDays && avgPrCycleTimeDays !== null
    ? (baseline.prCycleTimeDays - avgPrCycleTimeDays) / baseline.prCycleTimeDays
    : null;
  const cycle3Crit: LadderCriterion = {
    id: 'b3-cycle',
    label: `PR cycle time -${pct(B3_CYCLE_TIME_IMPROVEMENT)} vs baseline`,
    category: 'outcomes',
    status: cycleImprovement3 !== null ? statusFromValue(cycleImprovement3, B3_CYCLE_TIME_IMPROVEMENT) : 'unknown',
    evidenceQuality: cycleImprovement3 !== null ? 'definitive' : 'configured',
    threshold: `PR cycle time at least ${pct(B3_CYCLE_TIME_IMPROVEMENT)} better than pre-AI baseline`,
    targetValue: B3_CYCLE_TIME_IMPROVEMENT,
    currentValue: cycleImprovement3,
    currentDisplay: cycleImprovement3 !== null
      ? `${days(avgPrCycleTimeDays)} current vs ${days(baseline.prCycleTimeDays)} baseline (${pct(cycleImprovement3)} improvement)`
      : `${days(avgPrCycleTimeDays)} current (no baseline set)`,
    targetDisplay: `>=${pct(B3_CYCLE_TIME_IMPROVEMENT)} reduction`,
    gapDisplay: cycleImprovement3 !== null && cycleImprovement3 < B3_CYCLE_TIME_IMPROVEMENT
      ? `Need ${pct(B3_CYCLE_TIME_IMPROVEMENT - cycleImprovement3)} more reduction`
      : (cycleImprovement3 === null ? 'Set baseline in data/ai-capability-baseline.json' : null),
    evidenceSource: 'ADO /api/pull-request-time-stats, baseline from config',
    developersNeedingLift: [],
  };

  // 3d. Lead time -25%
  const leadImprovement3 = baseline.leadTimeDays && avgLeadTimeDays !== null
    ? (baseline.leadTimeDays - avgLeadTimeDays) / baseline.leadTimeDays
    : null;
  const lead3Crit: LadderCriterion = {
    id: 'b3-lead',
    label: `Lead time -${pct(B3_LEAD_TIME_IMPROVEMENT)} vs baseline`,
    category: 'outcomes',
    status: leadImprovement3 !== null ? statusFromValue(leadImprovement3, B3_LEAD_TIME_IMPROVEMENT) : 'unknown',
    evidenceQuality: leadImprovement3 !== null ? 'definitive' : 'configured',
    threshold: `Lead time at least ${pct(B3_LEAD_TIME_IMPROVEMENT)} better than pre-AI baseline`,
    targetValue: B3_LEAD_TIME_IMPROVEMENT,
    currentValue: leadImprovement3,
    currentDisplay: leadImprovement3 !== null
      ? `${days(avgLeadTimeDays)} current vs ${days(baseline.leadTimeDays)} baseline (${pct(leadImprovement3)} improvement)`
      : `${days(avgLeadTimeDays)} current (no baseline set)`,
    targetDisplay: `>=${pct(B3_LEAD_TIME_IMPROVEMENT)} reduction`,
    gapDisplay: leadImprovement3 !== null && leadImprovement3 < B3_LEAD_TIME_IMPROVEMENT
      ? `Need ${pct(B3_LEAD_TIME_IMPROVEMENT - leadImprovement3)} more reduction`
      : (leadImprovement3 === null ? 'Set baseline in data/ai-capability-baseline.json' : null),
    evidenceSource: 'ADO /api/in-progress-stats, baseline from config',
    developersNeedingLift: [],
  };

  // 3e. Defect rate flat or better
  const defectOk3 = avgDefectRate !== null && baseline.defectRatePerPbi !== null
    ? avgDefectRate <= baseline.defectRatePerPbi
    : null;
  const defect3Crit: LadderCriterion = {
    id: 'b3-defect',
    label: 'Defect rate flat or better',
    category: 'outcomes',
    status: defectOk3 === null ? 'unknown' : (defectOk3 ? 'met' : 'not-met'),
    evidenceQuality: defectOk3 !== null ? 'definitive' : 'configured',
    threshold: 'QA bug rate per PBI is equal to or lower than baseline',
    targetValue: baseline.defectRatePerPbi ?? 0,
    currentValue: avgDefectRate,
    currentDisplay: avgDefectRate !== null ? `${avgDefectRate.toFixed(2)} bugs/PBI` : 'unknown',
    targetDisplay: baseline.defectRatePerPbi !== null ? `<=${baseline.defectRatePerPbi.toFixed(2)} bugs/PBI` : 'baseline not set',
    gapDisplay: defectOk3 === false ? `Current ${avgDefectRate?.toFixed(2)} exceeds baseline ${baseline.defectRatePerPbi?.toFixed(2)}` : null,
    evidenceSource: 'ADO /api/qa-bug-stats, baseline from config',
    developersNeedingLift: [],
  };

  // 3f. Deploy frequency up
  const deployUp = deployFrequencyPerMonth !== null && baseline.deploysPerMonth !== null
    ? deployFrequencyPerMonth > baseline.deploysPerMonth
    : null;
  const deployCrit: LadderCriterion = {
    id: 'b3-deploy',
    label: 'Deployment frequency increased',
    category: 'outcomes',
    status: deployUp === null ? 'unknown' : (deployUp ? 'met' : 'not-met'),
    evidenceQuality: deployUp !== null ? 'definitive' : 'configured',
    threshold: 'Deploys per month is higher than baseline',
    targetValue: baseline.deploysPerMonth ? baseline.deploysPerMonth + 1 : 1,
    currentValue: deployFrequencyPerMonth,
    currentDisplay: deployFrequencyPerMonth !== null ? `${deployFrequencyPerMonth.toFixed(1)} deploys/month` : 'unknown',
    targetDisplay: baseline.deploysPerMonth !== null ? `>${baseline.deploysPerMonth.toFixed(1)} deploys/month` : 'baseline not set',
    gapDisplay: deployUp === false ? `Deploy frequency below baseline` : (deployUp === null ? 'Set baseline or populate deployment records' : null),
    evidenceSource: 'ADO /api/deployments, baseline from config',
    developersNeedingLift: [],
  };

  // 3g. >=2 skills contributed to shared registry
  const sharedSkillsContributed = baseline.skillContributions.filter(s => s.sharedRegistry).length;
  const skillsContribMet = sharedSkillsContributed >= B3_SKILLS_CONTRIBUTED;
  const skillsContrib3Crit: LadderCriterion = {
    id: 'b3-skills',
    label: `>=${B3_SKILLS_CONTRIBUTED} skills contributed to shared registry`,
    category: 'contribution',
    status: skillsContribMet ? 'met' : (sharedSkillsContributed >= 1 ? 'at-risk' : 'not-met'),
    evidenceQuality: 'configured',
    threshold: `At least ${B3_SKILLS_CONTRIBUTED} skills have been added to the shared skills registry`,
    targetValue: B3_SKILLS_CONTRIBUTED,
    currentValue: sharedSkillsContributed,
    currentDisplay: `${sharedSkillsContributed} shared skill(s) contributed`,
    targetDisplay: `${B3_SKILLS_CONTRIBUTED}+`,
    gapDisplay: !skillsContribMet ? `${B3_SKILLS_CONTRIBUTED - sharedSkillsContributed} more shared skill contribution(s) needed` : null,
    evidenceSource: 'data/ai-capability-baseline.json skillContributions (configured)',
    developersNeedingLift: [],
  };

  // 3h. Cross-team demo/pairing
  const hasCrossTeamEvidence = baseline.crossTeamDemoEvidence.length > 0;
  const crossTeamCrit: LadderCriterion = {
    id: 'b3-crossteam',
    label: 'Lead paired with another team; dev demo at cross-team forum',
    category: 'contribution',
    status: hasCrossTeamEvidence ? 'met' : 'not-met',
    evidenceQuality: 'configured',
    threshold: 'At least one lead has paired with another team and one dev has demo\'d at a cross-team forum',
    targetValue: 1,
    currentValue: hasCrossTeamEvidence ? 1 : 0,
    currentDisplay: hasCrossTeamEvidence
      ? `${baseline.crossTeamDemoEvidence.length} evidence item(s) recorded`
      : 'No evidence recorded',
    targetDisplay: 'Evidence recorded in baseline config',
    gapDisplay: !hasCrossTeamEvidence ? 'Add cross-team pairing/demo evidence to data/ai-capability-baseline.json' : null,
    evidenceSource: 'data/ai-capability-baseline.json crossTeamDemoEvidence (configured)',
    developersNeedingLift: [],
  };

  const criteria = [dau3Crit, orch3Crit, cycle3Crit, lead3Crit, defect3Crit, deployCrit, skillsContrib3Crit, crossTeamCrit];
  return { bar: 'bar3', title: 'Bar 3 — Compounding', status: worstStatus(criteria), criteria };
}

// ── Main entry point ───────────────────────────────────────────────────────────

export interface LadderInputs {
  cursorSummary: CursorTeamSummary;
  /** True when Cursor API was successfully reached and returned members */
  cursorDataAvailable: boolean;
  /** Error message from Cursor API if unavailable */
  cursorApiError: string | null;
  adoMembers: string[];
  kickoffCount: number;
  totalEligibleFeatures: number;
  aiCodeWorkItemAdoption: AiCodeWorkItemAdoptionSummary;
  avgPrCycleTimeDays: number | null;
  avgLeadTimeDays: number | null;
  avgDefectRatePerPbi: number | null;
  deployFrequencyPerMonth: number | null;
  baseline: AiCapabilityBaseline;
  fromDate: string;
  toDate: string;
}

/** Marks all Cursor-sourced criteria as unknown when the API is unavailable */
function unknownCursorCriterion(
  id: string,
  label: string,
  category: 'adoption' | 'practice' | 'outcomes' | 'contribution',
  threshold: string,
  targetValue: number,
  targetDisplay: string,
): LadderCriterion {
  return {
    id, label, category,
    status: 'unknown',
    evidenceQuality: 'definitive',
    threshold,
    targetValue,
    currentValue: null,
    currentDisplay: 'Cursor API unavailable',
    targetDisplay,
    gapDisplay: 'Cursor API could not be reached — check CURSOR_API_KEY and team access',
    evidenceSource: 'Cursor Admin/Analytics API (unreachable)',
    developersNeedingLift: [],
  };
}

export function buildLadderResult(inputs: LadderInputs): AiCapabilityLadderResult {
  const {
    cursorSummary, cursorDataAvailable, cursorApiError,
    adoMembers, kickoffCount, totalEligibleFeatures, aiCodeWorkItemAdoption,
    avgPrCycleTimeDays, avgLeadTimeDays, avgDefectRatePerPbi,
    deployFrequencyPerMonth, baseline, fromDate, toDate,
  } = inputs;

  const bar1 = scoreBar1(cursorSummary, adoMembers, kickoffCount, baseline, cursorDataAvailable);
  const bar2 = scoreBar2(
    cursorSummary, adoMembers, kickoffCount, totalEligibleFeatures, aiCodeWorkItemAdoption,
    avgPrCycleTimeDays, avgLeadTimeDays, avgDefectRatePerPbi, baseline, cursorDataAvailable,
  );
  const bar3 = scoreBar3(
    cursorSummary, adoMembers, kickoffCount, totalEligibleFeatures, aiCodeWorkItemAdoption,
    avgPrCycleTimeDays, avgLeadTimeDays, avgDefectRatePerPbi,
    deployFrequencyPerMonth, baseline, cursorDataAvailable,
  );

  const allCriteria = [...bar1.criteria, ...bar2.criteria, ...bar3.criteria];
  const topGaps = allCriteria
    .filter(c => c.status === 'not-met' || c.status === 'at-risk')
    .sort((a, b) => {
      const rank: Record<CriterionStatus, number> = { 'not-met': 0, 'at-risk': 1, met: 2, unknown: 3 };
      return rank[a.status] - rank[b.status];
    })
    .slice(0, 5);

  return {
    evaluatedAt: new Date().toISOString(),
    fromDate,
    toDate,
    adoTeamSize: adoMembers.length || cursorSummary.teamSize,
    cursorSeats: cursorDataAvailable ? cursorSummary.activeSeats : 0,
    bars: [bar1, bar2, bar3],
    developersWithoutCursorActivity: cursorDataAvailable
      ? devsWithoutCursorActivity(cursorSummary.developers, adoMembers)
      : [],
    topGaps,
    cursorApiError,
  };
}
