import fs from 'node:fs';
import path from 'node:path';
import { ATS_BOARD_AGENT_SKILLS } from '../services/playbookSteps/registry';
import { assertGraphWithinGuards } from '../services/playbookGuardService';
import { assertCursorAgentsUseReadOnlyMcp } from '../services/playbookMcpCapabilityService';
import type { PlaybookGraph } from '../../shared/types/playbook';
import {
  AtsBoardTranscriptError,
  atsBoardRunInput,
  formatAtsBoardTranscript,
  parseAtsBoardSynopsis,
  prepareAtsBoardRunInput,
  redactBoardText,
} from '../../shared/atsBoard';
import { assertAtsBoardReportRoles } from '../services/boardDeliberationService';

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
    expect(template.templateVersion).toBe(2);
    expect(graph.nodes).toHaveLength(12);
    expect(
      graph.nodes.filter((node) => node.stepType === 'cursor-agent')
    ).toHaveLength(8);
    expect(
      graph.nodes.filter((node) => node.stepType === 'board-deliberation')
    ).toHaveLength(1);
    expect(() => assertGraphWithinGuards(graph)).not.toThrow();
    expect(() => assertCursorAgentsUseReadOnlyMcp(graph)).not.toThrow();
  });

  it('lets role members see the charter only, then binds every report into deliberation', () => {
    for (const roleId of ROLE_IDS) {
      const node = graph.nodes.find((entry) => entry.id === roleId);
      const prompt = String(node?.config?.prompt);
      expect(prompt).toContain('${input.charter}');
      expect(prompt).not.toContain('${steps.');
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
    });
    expect(transcript).toContain('## Phase 1 Requirements');
    expect(transcript).toContain('Ratify Phase 1 only.');
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
});
