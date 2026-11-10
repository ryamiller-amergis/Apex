import fs from 'node:fs';
import path from 'node:path';
import {
  buildVisualBrief,
  detectRecommendedPagePatterns,
  formatVisualBriefForPrompt,
} from '../../shared/buildVisualBrief';
import type { DesignPreferenceProfile } from '../../shared/types/designPreferenceProfile';
import { classifyBuildSupport } from '../services/buildRiskClassifier';
import {
  classifyBuildRevisionFastEdit,
  formatEscalationTimelineMessage,
} from '../services/build/buildRevisionFastEditClassifier';
import { createLocalCursorRevisionEditAgentProvider } from '../services/build/buildRevisionEditAgent';
import { evaluateVisualQualityFromEvidence } from '../services/buildVisualVerificationService';

const EVALUATOR_SKILL_PATH = path.resolve(
  __dirname,
  '../../../.cursor/skills/build-run-evaluator/SKILL.md'
);
const EVALUATOR_RUBRIC_PATH = path.resolve(
  __dirname,
  '../../../.cursor/skills/build-run-evaluator/rubric.md'
);
const TEMPLATE_PRODUCT_QUALITY_PATH = path.resolve(
  __dirname,
  '../../../templates/full-stack-express/.cursor/skills/product-quality/SKILL.md'
);

describe('Apex Build-from-Prompt End-User Flow (Phases 1–9)', () => {
  it('Phase 2 & 7: classifies intake support (supported_now vs requires_access_or_credentials vs unsupported_infrastructure) and surfaces approval gates', () => {
    const supported = classifyBuildSupport({
      prompt:
        'Build an operations dashboard with a fulfillment chart and notifications.',
      requirements: [
        {
          text: 'Dashboard displays Verified Batches and an interactive chart.',
        },
      ],
      riskDecisions: [],
    });
    expect(supported.status).toBe('supported_now');
    expect(supported.requiredInputs).toEqual([]);

    const needsCredentials = classifyBuildSupport({
      prompt: 'Connect to Salesforce live API and external webhook.',
      requirements: [
        { text: 'Syncs customer accounts from Salesforce live API.' },
      ],
      riskDecisions: [
        {
          id: 'RD-1',
          category: 'integration',
          rating: 'high',
          decision:
            'Put the new integration behind a feature flag that is off by default.',
          rationale: 'External API access',
          reversible: true,
        },
      ],
    });
    expect(needsCredentials.status).toBe('requires_access_or_credentials');
    expect(needsCredentials.requiredInputs.length).toBeGreaterThan(0);
    expect(needsCredentials.approvalGates.join(' ')).toMatch(/RD-1/);

    const unsupported = classifyBuildSupport({
      prompt: 'Deploy a multi-region active-active Kafka cluster on Kubernetes.',
      requirements: [
        { text: 'Provision a custom Kubernetes cluster and custom VPC.' },
      ],
      riskDecisions: [],
    });
    expect(unsupported.status).toBe('unsupported_infrastructure');
    expect(unsupported.requiredInputs.length).toBeGreaterThan(0);
  });

  it('Phase 2: includes brand tokens, recommended page patterns, and anti-generic sample data guidance in the visual brief', () => {
    const prompt =
      'Build a fulfillment dashboard with KPI charts, an unread notifications inbox, and an AI insights skill grounded in database records and a connector feed.';
    const patterns = detectRecommendedPagePatterns(prompt);
    expect(patterns).toEqual(
      expect.arrayContaining(['chart', 'notifications', 'ai-skill-insights'])
    );

    const brief = buildVisualBrief({
      buildRunId: 'run-e2e-1',
      taskDomain: 'mixed',
      prompt,
      profile: {
        appName: 'project-name',
        preferredPatterns: [],
        avoidedPatterns: [],
      } as unknown as DesignPreferenceProfile,
      logoCandidateId: 'logo-cand-1',
    });

    expect(brief.appName).toBe('Northstar Ops');
    expect(brief.brandTokens).toMatchObject({
      appName: 'Northstar Ops',
      logoCandidateId: 'logo-cand-1',
    });
    const rendered = formatVisualBriefForPrompt(brief);
    expect(rendered).toContain('Recommended page patterns:');
    expect(rendered).toContain('never "Item 1" or "Todo 1"');
  });

  it('Phase 6 & 8: routes copy/layout tweaks to fast_edit (with blocked-model fallback to composer-2.5) and routes backend/chart/notification/AI-skill changes to cloud_agent', async () => {
    const fastCopy = classifyBuildRevisionFastEdit(
      'Center the main container and change the heading copy to Operations Hub.'
    );
    expect(fastCopy).toMatchObject({
      route: 'fast_edit',
      agentKind: 'fast_edit',
      certain: true,
    });

    const cloudBackend = classifyBuildRevisionFastEdit(
      'Add a new chart endpoint and notification backend with AI skill integration.'
    );
    expect(cloudBackend).toMatchObject({
      route: 'full_build',
      agentKind: 'cloud_agent',
      certain: true,
    });

    const clarification = classifyBuildRevisionFastEdit(
      '? Can you suggest options for how this workflow should work?'
    );
    expect(clarification).toMatchObject({
      route: 'full_build',
      agentKind: 'needs_clarification',
    });

    expect(
      formatEscalationTimelineMessage(
        'The chart needs a new database query and API route.'
      )
    ).toContain('The chart needs a new database query and API route.');

    // Verify fast-edit agent falls back from a blocked model (grok-4.7) to composer-2.5
    const modelsUsed: string[] = [];
    const provider = createLocalCursorRevisionEditAgentProvider({
      readHeadCommit: async () => 'a'.repeat(40),
      hasWorkspaceChanges: async () => false,
      tryDeterministicEdit: async () => ({ kind: 'not_applicable' }),
      runtime: {
        async run(input) {
          modelsUsed.push(input.modelId ?? '');
          if (input.modelId === 'grok-4.7') {
            throw new Error('Model grok-4.7 is blocked by team admin.');
          }
          return {
            agentCorrelationRef: 'agent:cursor-local:composer-fallback',
            output: '{"outcome":"edited"}',
          };
        },
      },
    });

    const editResult = await provider.edit({
      workspacePath: '/tmp/scratch-rev',
      baseCommit: 'a'.repeat(40),
      feedback: 'Center the layout and adjust theme tokens.',
      revisionNumber: 2,
      modelId: 'grok-4.7',
    });
    expect(editResult.kind).toBe('edited');
    expect(modelsUsed).toEqual(['grok-4.7', 'composer-2.5']);
  });

  it('Phase 3, 4 & 9: enforces centered desktop viewport geometry in visual verification and documents product-quality and evaluator criteria', () => {
    const brief = buildVisualBrief({
      buildRunId: 'run-visual-1',
      taskDomain: 'ui',
      prompt: 'Build a dashboard',
      profile: {
        appName: 'Northstar Ops',
        preferredPatterns: [],
        avoidedPatterns: [],
      } as unknown as DesignPreferenceProfile,
    });

    const uncenteredResult = evaluateVisualQualityFromEvidence({
      visualBrief: brief,
      block: {
        version: 1,
        taskKey: 'build-feature',
        attemptNumber: 1,
        entries: [
          {
            requirementId: 'DOD-1',
            tier: 'e2e',
            testReferences: [
              { file: 'apps/web/e2e/home.spec.ts', name: 'DOD-1 snapshot' },
            ],
            red: null,
            green: null,
            deferral: { reason: 'Deferred to CI' },
          },
        ],
        checks: { typeCheck: null, lint: null, relatedTests: null },
        standardsReview: { completed: true, findings: [] },
        visualReview: {
          completed: true,
          findings: [],
          screenshotPaths: ['apps/web/e2e/home.png'],
          componentReuseRationale: 'Reused AppShell, StatGrid, and DataChartCard.',
        },
        escalation: null,
      },
      viewports: [
        {
          viewport: 'desktop',
          width: 1280,
          height: 800,
          centeredMain: false,
          maxWidthPx: 1200,
        },
      ],
    });
    expect(uncenteredResult.passed).toBe(false);
    expect(uncenteredResult.findings.join(' ')).toMatch(/not centered/i);

    const productQualitySkill = fs.readFileSync(
      TEMPLATE_PRODUCT_QUALITY_PATH,
      'utf8'
    );
    expect(productQualitySkill).toContain("alignSelf: 'center'");
    expect(productQualitySkill).toContain('DataChartCard');
    expect(productQualitySkill).toContain('NotificationCenter');

    const evaluatorSkill = fs.readFileSync(EVALUATOR_SKILL_PATH, 'utf8');
    const evaluatorRubric = fs.readFileSync(EVALUATOR_RUBRIC_PATH, 'utf8');
    expect(evaluatorSkill).toContain('product-quality/SKILL.md');
    expect(evaluatorRubric).toContain('End-user visual polish');
    expect(evaluatorRubric).toContain('centered layout geometry');
  });
});
