import fs from 'node:fs';
import path from 'node:path';
import { ATS_BOARD_AGENT_SKILLS } from '../services/playbookSteps/registry';
import { assertGraphWithinGuards } from '../services/playbookGuardService';
import { assertCursorAgentsUseReadOnlyMcp } from '../services/playbookMcpCapabilityService';
import type { PlaybookGraph } from '../../shared/types/playbook';
import {
  ATS_BOARD_AI_TEAM,
  AtsBoardTranscriptError,
  atsBoardRunInput,
  formatAtsBoardTranscript,
  parseAtsBoardSynopsis,
  prepareAtsBoardRunInput,
  redactBoardText,
} from '../../shared/atsBoard';
import { assertAtsBoardReportRoles } from '../services/boardDeliberationService';
import { ATS_BOARD_PUBLIC_WEB_MCP_PROFILE } from '../../shared/atsBoardMcp';
import {
  normalizeAtsBoardMemberReportPayload,
  validateAtsBoardMemberReport,
} from '../../shared/atsBoardMemberReport';

const TEMPLATE_PATH = path.resolve(
  process.cwd(),
  'src/server/playbookTemplates/ats-agent-board.json'
);
const ROLE_IDS = [
  'operations',
  'recruiting',
  'client',
  'compliance',
  'data',
  'product',
  'market',
];

const synopsis = {
  status: 'Board approved — awaiting leadership',
  executiveSynopsis: 'Phase 1 covers one filled assignment.',
  phase1: ['A recruiter submits one candidate.'],
  day1Cutover: 'Open jobs and active placements only.',
  separationImpact: 'The new workflow runs without the old system.',
  decisions: [
    {
      id: 'D1',
      area: 'Recruiting',
      decision: 'Submit one candidate from an internal search.',
      status: 'Board approved — awaiting leadership',
      evidence: ['A public vendor page describes internal search. One source.'],
      confidence: 0.4,
    },
  ],
  dissent: ['Market wanted a second source.'],
  risks: ['Payroll is unsettled.'],
  assumptions: ['Named research was authorized.'],
  advantages: ['The recruiter finishes in one screen.'],
  deferred: ['Payroll.'],
  unresolved: ['Invoice rules.'],
};

function loadTemplate(): { templateVersion: number; graph: PlaybookGraph } {
  return JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')) as {
    templateVersion: number;
    graph: PlaybookGraph;
  };
}

describe('ATS agent board template', () => {
  const template = loadTemplate();
  const graph = template.graph;

  it('stays inside the playbook caps and can be published', () => {
    expect(template.templateVersion).toBe(7);
    expect(graph.nodes).toHaveLength(15);
    expect(
      graph.nodes.filter((node) => node.stepType === 'cursor-agent')
    ).toHaveLength(9);
    expect(
      graph.nodes.filter((node) => node.stepType === 'board-deliberation')
    ).toHaveLength(1);
    expect(() => assertGraphWithinGuards(graph)).not.toThrow();
    expect(() => assertCursorAgentsUseReadOnlyMcp(graph)).not.toThrow();
  });

  it('introduces every agent task with stable product-facing copy', () => {
    const agentNodeIds = graph.nodes
      .filter((node) => node.stepType === 'cursor-agent' && node.id !== 'revise')
      .map((node) => node.id)
      .sort();
    expect(ATS_BOARD_AI_TEAM.map((member) => member.nodeId).sort()).toEqual(
      agentNodeIds
    );
    for (const member of ATS_BOARD_AI_TEAM) {
      expect(member.name.trim()).not.toBe('');
      expect(member.synopsis.trim()).not.toBe('');
      expect(member.synopsis).not.toContain('.cursor/');
    }
  });

  it('keeps sequential specialists bounded and leadership copy business-friendly', () => {
    for (const roleId of ROLE_IDS) {
      const node = graph.nodes.find((entry) => entry.id === roleId);
      const skill = fs.readFileSync(
        path.resolve(process.cwd(), String(node?.config?.skillPath)),
        'utf8'
      );
      expect(skill).toContain('at most 2 public-web searches');
      expect(skill).toContain('raw specialist report compact');
    }

    const chairSkill = fs.readFileSync(
      path.resolve(process.cwd(), '.cursor/skills/ats-board-chair/SKILL.md'),
      'utf8'
    );
    expect(chairSkill).toContain('product owner or CIO');
    expect(chairSkill).toContain('complete, polished sentences');
    expect(chairSkill).toContain('never write a decision code');
  });

  it('lets role members see the charter only, then binds every report into deliberation', () => {
    for (const roleId of ROLE_IDS) {
      const node = graph.nodes.find((entry) => entry.id === roleId);
      const prompt = String(node?.config?.prompt);
      expect(prompt).toContain('${input.charter}');
      expect(prompt).not.toContain('${steps.');
      expect(node?.config?.mcpProfile).toBe(ATS_BOARD_PUBLIC_WEB_MCP_PROFILE);
      expect(ATS_BOARD_AGENT_SKILLS).toContain(node?.config?.skillPath);
      expect(
        fs.existsSync(
          path.resolve(process.cwd(), String(node?.config?.skillPath))
        )
      ).toBe(true);
    }

    const deliberation = graph.nodes.find(
      (entry) => entry.id === 'deliberation'
    );
    expect(deliberation?.config).toMatchObject({
      maxTopics: 3,
      maxRounds: 1,
      inquiryBudget: 8,
    });
    expect(deliberation?.config?.reports).toEqual(
      Object.fromEntries(
        ROLE_IDS.map((roleId) => [roleId, `\${steps.${roleId}.reportMd}`])
      )
    );
    const chairPrompt = String(
      graph.nodes.find((entry) => entry.id === 'chair')?.config?.prompt
    );
    for (const roleId of ROLE_IDS) {
      expect(chairPrompt).toContain(`\${steps.${roleId}.reportMd}`);
    }
    expect(chairPrompt).toContain('${steps.deliberation.reportMd}');

    const feedback = graph.nodes.find((entry) => entry.id === 'leadership-feedback');
    expect(feedback?.stepType).toBe('feedback-review');
    expect(feedback?.config?.sourceStepIds).toEqual(['chair', 'deliberation']);
    const revise = graph.nodes.find((entry) => entry.id === 'revise');
    expect(String(revise?.config?.prompt)).toContain('${steps.leadership-feedback.revisionBrief}');
    const learning = graph.nodes.find((entry) => entry.id === 'capture-learning');
    expect(learning?.stepType).toBe('capture-outcome-feedback');
    expect(learning?.config).toEqual({
      label: 'ATS board outcome',
      reviewStepId: 'ratify',
      feedbackStepId: 'leadership-feedback',
      sourceStepIds: ['chair', 'deliberation', 'revise'],
    });
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: 'chair', to: 'leadership-feedback' },
        { from: 'leadership-feedback', to: 'revise' },
        { from: 'revise', to: 'notify-ready' },
        { from: 'ratify', to: 'capture-learning' },
      ])
    );
  });
});

describe('ATS board charter and synopsis', () => {
  it('stops deliberation when a specialist returns the wrong role', () => {
    const reports = Object.fromEntries(
      ROLE_IDS.map((role) => [role, JSON.stringify({ role })])
    );
    reports.market = JSON.stringify({ role: 'product' });
    expect(() => assertAtsBoardReportRoles(reports)).toThrow(
      /market step returned role "product"/
    );
  });

  it('removes contact details and prices before the agents see the charter', () => {
    const redacted = redactBoardText(
      'Email ada@example.com, call (410) 555-1212, budget $12000.'
    );
    expect(redacted).not.toContain('ada@example.com');
    expect(redacted).not.toContain('555-1212');
    expect(redacted).not.toContain('$12000');
    expect(redacted).toContain('[redacted email]');
  });

  it('refuses named research until the leader authorizes it', () => {
    expect(() =>
      prepareAtsBoardRunInput({
        board: 'ats-agent-board',
        charter: 'Beat Aya on fill speed.',
        authorizeNamedResearch: false,
      })
    ).toThrow(/explicit authorization/);

    const input = atsBoardRunInput({
      objective: 'Replace the current fill workflow with a smaller one.',
      separation: 'Run Amergis without eRecruit for that workflow.',
      staffingModel: 'Contract staffing for clinical roles.',
      boundaries: 'No payroll in Phase 1.',
      nonNegotiables: 'Do not copy the old screens.',
      authorizeNamedResearch: true,
    });
    expect(input.charter).toContain('Named research authorized: yes');
    expect(input.authorizeNamedResearch).toBe(true);
  });

  it('reads the chair scorecard and withholds the transcript until ratification', () => {
    const parsed = parseAtsBoardSynopsis({
      scorecard: JSON.stringify(synopsis),
    });
    expect(parsed?.dissent).toEqual(['Market wanted a second source.']);
    expect(() => formatAtsBoardTranscript(parsed!, null)).toThrow(
      AtsBoardTranscriptError
    );

    const transcript = formatAtsBoardTranscript(parsed!, {
      decision: 'approved',
      comment: 'Ratify Phase 1 only.',
      answers: [
        {
          decisionId: 'D-PORTAL',
          resolution: 'direct',
          response: 'Keep client review with the account manager in Phase 1.',
        },
      ],
    });
    expect(transcript).toContain('## Phase 1 Requirements');
    expect(transcript).toContain('Ratify Phase 1 only.');
    expect(transcript).toContain('## Leadership Resolutions');
    expect(transcript).toContain(
      'Keep client review with the account manager in Phase 1.'
    );
    expect(transcript).toContain(
      'This ledger overrides every earlier ledger in this conversation.'
    );
  });

  it('reads list items the chair wrote as objects', () => {
    const parsed = parseAtsBoardSynopsis({
      scorecard: JSON.stringify({
        ...synopsis,
        phase1: [{ id: 'P0', label: 'Shared order record', consensus: true }],
        decisions: [
          {
            ...synopsis.decisions[0],
            evidence: [
              {
                claim: 'Charter scope',
                source: 'User charter',
                corroboration: 'internal',
              },
            ],
          },
        ],
      }),
    });
    expect(parsed?.phase1).toEqual(['P0 — Shared order record']);
    expect(parsed?.decisions[0].evidence).toEqual([
      'Charter scope — User charter — internal',
    ]);
  });

  it('reads the version 2 executive package without breaking version 1 runs', () => {
    const parsed = parseAtsBoardSynopsis({
      scorecard: JSON.stringify({
        ...synopsis,
        schemaVersion: 2,
        decisionRequests: ['Choose the compliance gate order.'],
        recommendation: 'Approve the thin order-to-fill workflow.',
        businessOutcomes: ['Reduce duplicate entry.'],
        options: [
          {
            id: 'O1',
            title: 'Compliance before client',
            description: 'Release only cleared packets.',
            tradeoffs: ['Slower first submission.'],
            recommended: false,
          },
        ],
        leadershipActions: ['Name the compliance policy owner.'],
        deliberation: [
          {
            topic: 'Gate order',
            participants: ['compliance', 'recruiting'],
            outcome: 'Leadership must choose.',
            status: 'leadership_required',
          },
        ],
        decisions: [
          {
            ...synopsis.decisions[0],
            evidenceQuality: 'weak',
          },
        ],
      }),
    });

    expect(parsed?.schemaVersion).toBe(2);
    expect(parsed?.decisionRequests).toEqual([
      'Choose the compliance gate order.',
    ]);
    expect(parsed?.decisions[0].evidenceQuality).toBe('weak');
    expect(parsed?.deliberation[0].participants).toEqual([
      'compliance',
      'recruiting',
    ]);

    const legacy = parseAtsBoardSynopsis({
      scorecard: JSON.stringify(synopsis),
    });
    expect(legacy?.schemaVersion).toBe(1);
    expect(legacy?.recommendation).toBe(synopsis.executiveSynopsis);
  });

  it('reads the version 3 executive package with evidence register and lenses', () => {
    const parsed = parseAtsBoardSynopsis({
      scorecard: JSON.stringify({
        ...synopsis,
        schemaVersion: 3,
        decisionRequests: ['Choose the compliance gate order.'],
        recommendation: 'Approve the thin order-to-fill workflow.',
        businessOutcomes: ['Reduce duplicate entry.'],
        options: [
          {
            id: 'O1',
            title: 'Compliance before client',
            description: 'Release only cleared packets.',
            tradeoffs: ['Slower first submission.'],
            recommended: false,
          },
        ],
        leadershipActions: ['Name the compliance policy owner.'],
        deliberation: [],
        readiness: { ratifiable: false, blockers: ['Payroll unsettled'] },
        evidenceRegister: [
          {
            id: 'E1',
            claim: 'Vendor documents internal search.',
            source: 'https://example.com/search',
            corroboration: 'one source',
          },
        ],
        insufficientEvidence: ['Invoice rules'],
        lenses: {
          security: ['SSO required'],
          cost: ['License tier unknown'],
          delivery: ['Six-month cutover'],
          adoption: ['Recruiter training'],
        },
        decisions: [
          {
            ...synopsis.decisions[0],
            evidenceIds: ['E1'],
          },
        ],
      }),
    });

    expect(parsed?.schemaVersion).toBe(3);
    expect(parsed?.readiness?.blockers).toEqual(['Payroll unsettled']);
    expect(parsed?.evidenceRegister?.[0].id).toBe('E1');
    expect(parsed?.decisions[0].evidenceIds).toEqual(['E1']);
    expect(parsed?.lenses?.security).toEqual(['SSO required']);
  });

  it('validates the version 4 focused leadership brief, caps, exception categories, and transcript', () => {
    const v4Payload = {
      ...synopsis,
      schemaVersion: 4,
      recommendation: 'Ship the single-screen recruiter submittal workflow.',
      businessOutcomes: ['Cut submittal assembly to under 3 minutes.'],
      decisionRequests: [
        'D-PII: Confirm whether Phase 1 remains synthetic-only or admits real candidate PII.',
      ],
      leadershipActions: [],
      options: [],
      deliberation: [],
      leadershipBrief: {
        headline:
          'Phase 1 ships a single-screen recruiter submittal desk on synthetic data.',
        aiDecisions: [
          'Use a 5-stage submission pipeline (Shortlisted, Compliance Cleared, Client-ready, Submitted, Rejected).',
          'Compute job status from active submission stages rather than storing a second mutable status.',
        ],
        expectedOutcomes: ['Cut submittal assembly to under 3 minutes.'],
        materialExceptions: [
          {
            id: 'D-PII',
            category: 'real_pii',
            title: 'Real candidate PII boundary',
            question:
              'Confirm whether Phase 1 remains synthetic-only or admits real candidate PII.',
            recommendedResolution:
              'Keep Phase 1 synthetic-only until HIPAA BAA and SOC 2 controls are signed off.',
            rationale: 'Real PII requires privacy and compliance sign-off.',
          },
        ],
      },
    };

    const parsed = parseAtsBoardSynopsis({
      scorecard: JSON.stringify(v4Payload),
    });
    expect(parsed?.schemaVersion).toBe(4);
    expect(parsed?.leadershipBrief?.aiDecisions).toHaveLength(2);
    expect(parsed?.leadershipBrief?.materialExceptions[0].category).toBe(
      'real_pii'
    );

    const transcript = formatAtsBoardTranscript(parsed!, {
      decision: 'approved',
      answers: [
        {
          decisionId: 'D-PII',
          resolution: 'accept_recommendation',
          response:
            'Keep Phase 1 synthetic-only until HIPAA BAA and SOC 2 controls are signed off.',
        },
      ],
    });
    expect(transcript).toContain('## AI-Decided Plan');
    expect(transcript).toContain('## AI-Made Decisions');
    expect(transcript).toContain('## Material Exceptions');
    expect(transcript).toContain(
      'D-PII [Real PII authorization] Real candidate PII boundary'
    );
    expect(transcript).toContain(
      'D-PII (accept recommendation): Keep Phase 1 synthetic-only'
    );
    expect(transcript).toContain('## Full Audit Record');

    // Rejects invalid exception category or mismatched decisionRequests in v4
    expect(
      parseAtsBoardSynopsis({
        scorecard: JSON.stringify({
          ...v4Payload,
          leadershipBrief: {
            ...v4Payload.leadershipBrief,
            materialExceptions: [
              {
                ...v4Payload.leadershipBrief.materialExceptions[0],
                category: 'ui_preference',
              },
            ],
          },
        }),
      })
    ).toBeNull();

    expect(
      parseAtsBoardSynopsis({
        scorecard: JSON.stringify({
          ...v4Payload,
          decisionRequests: ['D-OTHER: Unaligned question.'],
        }),
      })
    ).toBeNull();
  });

  it('normalizes misplaced evidence corroboration before v3 validation', () => {
    const url =
      'https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html';
    const report = JSON.stringify({
      role: 'compliance',
      recommendationType: 'recommend',
      recommendation: 'Phase 1 submittal workflow only.',
      checklist: [
        { id: 'payroll', status: 'partial', note: '' },
        { id: 'tax', status: 'partial', note: '' },
        { id: 'invoicing', status: 'partial', note: '' },
        { id: 'privacy', status: 'partial', note: '' },
        { id: 'regulatory-authority', status: 'partial', note: '' },
      ],
      evidenceRegister: [
        {
          id: 'E-COM-1',
          claim: 'HIPAA BAA rules apply when PHI is handled.',
          source: '',
          corroboration: url,
        },
      ],
      confidence: 0.6,
    });
    expect(() =>
      validateAtsBoardMemberReport('compliance', report)
    ).not.toThrow();
    const normalized = normalizeAtsBoardMemberReportPayload(JSON.parse(report));
    const entry = (
      normalized.evidenceRegister as Array<Record<string, string>>
    )[0];
    expect(entry.source).toBe(url);
    expect(entry.corroboration).toBe('one source');
  });

  it('validates v3 member reports when recommendationType is present', () => {
    const report = JSON.stringify({
      role: 'operations',
      recommendationType: 'insufficient_evidence',
      recommendation: 'Cannot recommend without SLA data.',
      checklist: [
        { id: 'ownership-handoffs', status: 'blocked', note: '' },
        { id: 'exceptions-slAs', status: 'blocked', note: '' },
        { id: 'placement-lifecycle', status: 'partial', note: '' },
        { id: 'cost-drivers', status: 'not_applicable', note: '' },
      ],
      missingInputs: ['Current SLA baseline'],
      confidence: 0.2,
    });
    expect(() =>
      validateAtsBoardMemberReport('operations', report)
    ).not.toThrow();
    expect(() =>
      validateAtsBoardMemberReport(
        'operations',
        report.replace('operations', 'market')
      )
    ).toThrow(/expected "operations"/);
  });
});
