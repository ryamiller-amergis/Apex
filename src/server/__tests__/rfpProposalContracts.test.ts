import {
  RFP_EXPECTED_USER_SCALE_LABELS,
  RFP_PROPOSAL_JOB_STATUS_LABELS,
  computeRfpCostTotals,
  defaultRfpArchitectureSizing,
  effectiveRfpVerdict,
  isRfpProposalJobActive,
  parseRfpGeneratedDraft,
  rfpDraftKindForVerdict,
  rfpProposalUnlocked,
  rfpRepoNameFromTitle,
  rfpReviewSubmitLabel,
  rfpWizardInitialStep,
  validateRfpArchitecture,
  validateRfpDraftForPublish,
  validateRfpIntakePayload,
  type RfpArchitectureInput,
  type RfpCostLine,
  type RfpDecisionSummaryDraft,
  type RfpIntakePayload,
  type RfpProposalDraft,
} from '../../shared/types/rfpIntake';

const INTAKE: RfpIntakePayload = {
  title: 'Benefits tracker',
  stakeholder: 'Benefits Administration',
  request: 'Track enrollments',
  problem: 'Spreadsheets',
  audience: 'internal',
  dataSensitivity: 'employee-pii',
  existingSolution: 'none known',
  expectedUsers: 'medium',
  aiInApp: 'not-sure',
};

const WEB_ARCH: RfpArchitectureInput = {
  appType: 'web',
  resources: ['rds', 'ecs'],
  requiresAi: true,
  domainName: 'benefits.amergis.com',
  sizing: {
    region: 'us-east',
    sizingProfile: 'medium',
    environmentCount: 2,
    uptimePattern: 'always-on',
    storageGb: 100,
    aiUsage: 'moderate',
  },
};

function costLine(overrides: Partial<RfpCostLine> = {}): RfpCostLine {
  return {
    id: 'rds-prod',
    label: 'RDS PostgreSQL',
    category: 'operating',
    cadence: 'monthly',
    quantity: 730,
    unit: 'hour',
    unitPrice: 0.065,
    amounts: { low: 47.45, expected: 47.45, high: 47.45 },
    currency: 'USD',
    priceStatus: 'verified',
    sourceType: 'aws-price-list',
    sourceUrl: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.json',
    sourceTitle: 'AWS Price List: Amazon RDS (us-east-1)',
    retrievedAt: '2026-09-28T12:00:00.000Z',
    confidence: 'high',
    assumptions: ['Single-AZ'],
    adminConfirmed: true,
    ...overrides,
  };
}

function proposalDraft(overrides: Partial<RfpProposalDraft> = {}): RfpProposalDraft {
  const costLines = overrides.costLines ?? [costLine()];
  return {
    version: 1,
    kind: 'proposal',
    jobId: 'job-1',
    inputFingerprint: 'fp-1',
    verdict: 'build',
    generatedAt: '2026-09-28T12:00:00.000Z',
    editedBy: null,
    editedAt: null,
    sections: {
      executiveSummary: 'Build a tracker.',
      recommendedSolution: 'A web app on Apex-managed AWS.',
      scope: ['Enrollment tracking'],
      deliveryPhases: [{ name: 'Discovery', duration: '2 weeks', outcomes: ['Confirmed workflow'] }],
      timeline: 'About 10 weeks.',
      assumptions: ['Existing SSO'],
      exclusions: ['Payroll integration'],
      risks: [{ risk: 'Scope growth', mitigation: 'Fixed phase goals' }],
      securityAndData: 'Employee data stays in the tenant.',
      ownership: 'Benefits Administration owns the product.',
      nextSteps: ['Approve the proposal'],
    },
    costLines,
    totals: computeRfpCostTotals(costLines),
    ...overrides,
  };
}

describe('RFP intake new fields', () => {
  it('FF-0 labels the three expected-user bands without overlapping edges', () => {
    expect(RFP_EXPECTED_USER_SCALE_LABELS).toEqual({
      small: 'Small (1–100)',
      medium: 'Medium (101–500)',
      large: 'Large (501+)',
    });
  });

  it('FF-0 FF-1 requires expected users and AI intent when requested', () => {
    const errors = validateRfpIntakePayload(
      { ...INTAKE, expectedUsers: null, aiInApp: undefined },
      { requireScaleAndAi: true },
    );
    expect(errors).toEqual(expect.arrayContaining(['expectedUsers is required', 'aiInApp is required']));
  });

  it('FF-0 FF-1 rejects unknown enum values', () => {
    const errors = validateRfpIntakePayload({
      ...INTAKE,
      expectedUsers: 'huge' as never,
      aiInApp: 'maybe' as never,
    });
    expect(errors).toEqual(expect.arrayContaining(['expectedUsers is invalid', 'aiInApp is invalid']));
  });

  it('FF-5 keeps older requests without the new fields valid', () => {
    const legacy = { ...INTAKE, expectedUsers: null, aiInApp: null };
    expect(validateRfpIntakePayload(legacy)).toEqual([]);
  });
});

describe('validateRfpArchitecture', () => {
  it('AP-0 accepts a web app with a domain name', () => {
    expect(validateRfpArchitecture(WEB_ARCH)).toEqual([]);
  });

  it('AP-0 requires a domain name only for web apps', () => {
    expect(validateRfpArchitecture({ ...WEB_ARCH, domainName: '  ' })).toContain('domainName is required for web apps');
    expect(validateRfpArchitecture({ ...WEB_ARCH, appType: 'console', domainName: null })).toEqual([]);
  });

  it('AP-0 rejects unknown app types and resources', () => {
    const errors = validateRfpArchitecture({
      ...WEB_ARCH,
      appType: 'mobile' as never,
      resources: ['rds', 'kafka' as never],
    });
    expect(errors).toEqual(expect.arrayContaining(['appType is invalid', 'resources contains an invalid value']));
  });

  it('AP-0 requires requiresAi to be a boolean', () => {
    expect(validateRfpArchitecture({ ...WEB_ARCH, requiresAi: undefined as never })).toContain('requiresAi is required');
  });

  it('PS-0 requires the pricing sizing assumptions', () => {
    expect(validateRfpArchitecture({ ...WEB_ARCH, sizing: undefined as never })).toContain('sizing is required');
  });

  it('PS-0 rejects out-of-range sizing values', () => {
    const errors = validateRfpArchitecture({
      ...WEB_ARCH,
      sizing: {
        region: 'mars' as never,
        sizingProfile: 'huge' as never,
        environmentCount: 9,
        uptimePattern: 'sometimes' as never,
        storageGb: -1,
        aiUsage: null,
      },
    });
    expect(errors).toEqual(expect.arrayContaining([
      'sizing.region is invalid',
      'sizing.sizingProfile is invalid',
      'sizing.environmentCount must be between 1 and 4',
      'sizing.uptimePattern is invalid',
      'sizing.storageGb must be between 0 and 10000',
      'sizing.aiUsage is required when the app requires AI',
    ]));
  });

  it('PS-0 does not ask for AI usage when the app does not require AI', () => {
    expect(validateRfpArchitecture({ ...WEB_ARCH, requiresAi: false, sizing: { ...WEB_ARCH.sizing, aiUsage: null } })).toEqual([]);
  });
});

describe('defaultRfpArchitectureSizing', () => {
  it('PS-1 prefills larger assumptions for larger expected-user scales', () => {
    const small = defaultRfpArchitectureSizing('small', false);
    const large = defaultRfpArchitectureSizing('large', true);
    expect(small).toMatchObject({ sizingProfile: 'small', uptimePattern: 'business-hours', aiUsage: null });
    expect(large).toMatchObject({ sizingProfile: 'large', uptimePattern: 'always-on', aiUsage: 'heavy' });
    expect(large.storageGb).toBeGreaterThan(small.storageGb);
  });

  it('PS-1 falls back to medium when the expected scale is unknown', () => {
    expect(defaultRfpArchitectureSizing(null, true)).toMatchObject({ sizingProfile: 'medium', aiUsage: 'moderate' });
  });
});

describe('review submission routing', () => {
  it('RS-0 maps build, rent-and-wrap, rent, and buy to a proposal', () => {
    for (const verdict of ['build', 'rent-and-wrap', 'rent', 'buy'] as const) {
      expect(rfpDraftKindForVerdict(verdict)).toBe('proposal');
      expect(rfpReviewSubmitLabel(verdict)).toBe('Submit for proposal');
    }
  });

  it('RS-0 maps Decline to a decision summary and Needs clarification to a saved review', () => {
    expect(rfpDraftKindForVerdict('decline')).toBe('decision-summary');
    expect(rfpReviewSubmitLabel('decline')).toBe('Submit decision summary');
    expect(rfpDraftKindForVerdict('needs-clarification')).toBeNull();
    expect(rfpReviewSubmitLabel('needs-clarification')).toBe('Save review');
  });

  it('RS-1 prefers the reviewer override over the AI verdict', () => {
    expect(effectiveRfpVerdict({
      reviewerDecision: { verdict: 'rent', rationale: 'r', reviewerId: 'a', decidedAt: 'now', sourceMessageIds: [] },
      currentEvaluation: { verdict: 'build' } as never,
    })).toBe('rent');
    expect(effectiveRfpVerdict({ reviewerDecision: null, currentEvaluation: { verdict: 'build' } as never })).toBe('build');
    expect(effectiveRfpVerdict({ reviewerDecision: null, currentEvaluation: null })).toBeNull();
  });
});

describe('proposal generation status', () => {
  it('GS-0 labels each state for admins', () => {
    expect(RFP_PROPOSAL_JOB_STATUS_LABELS).toMatchObject({
      queued: 'Queued',
      'researching-prices': 'Researching prices',
      writing: 'Writing proposal',
      ready: 'Ready',
      failed: 'Failed',
    });
  });

  it('GS-0 treats queued, researching, and writing as active', () => {
    expect(isRfpProposalJobActive('queued')).toBe(true);
    expect(isRfpProposalJobActive('writing')).toBe(true);
    expect(isRfpProposalJobActive('ready')).toBe(false);
    expect(isRfpProposalJobActive('failed')).toBe(false);
  });
});

describe('rfpProposalUnlocked', () => {
  const base = {
    reviewSubmittedAt: null,
    proposal: null,
    approval: null,
    reviewerDecision: null,
    currentEvaluation: { verdict: 'build' } as never,
  };

  it('PL-0 keeps Proposal locked for admins until the review is submitted', () => {
    expect(rfpProposalUnlocked(base, true)).toBe(false);
    expect(rfpProposalUnlocked({ ...base, reviewSubmittedAt: '2026-09-28T12:00:00.000Z' }, true)).toBe(true);
  });

  it('PL-0 keeps Proposal locked while the verdict needs clarification', () => {
    expect(rfpProposalUnlocked({
      ...base,
      reviewSubmittedAt: '2026-09-28T12:00:00.000Z',
      currentEvaluation: { verdict: 'needs-clarification' } as never,
    }, true)).toBe(false);
  });

  it('PL-1 unlocks Proposal for requesters only after publication', () => {
    expect(rfpProposalUnlocked({ ...base, reviewSubmittedAt: '2026-09-28T12:00:00.000Z' }, false)).toBe(false);
    expect(rfpProposalUnlocked({ ...base, proposal: {} as never }, false)).toBe(true);
  });
});

describe('computeRfpCostTotals', () => {
  it('PC-0 sums one-time and monthly ranges and annualizes monthly costs', () => {
    const totals = computeRfpCostTotals([
      costLine({ id: 'a', amounts: { low: 10, expected: 20, high: 30 } }),
      costLine({ id: 'b', amounts: { low: 5, expected: 5.555, high: 8 } }),
      costLine({ id: 'c', category: 'implementation', cadence: 'one-time', amounts: { low: 1000, expected: 2000, high: 3000 } }),
    ]);
    expect(totals.monthly).toEqual({ low: 15, expected: 25.56, high: 38 });
    expect(totals.annual).toEqual({ low: 180, expected: 306.72, high: 456 });
    expect(totals.oneTime).toEqual({ low: 1000, expected: 2000, high: 3000 });
    expect(totals.unpricedLineCount).toBe(0);
  });

  it('PC-1 counts unavailable prices instead of treating them as zero cost', () => {
    const totals = computeRfpCostTotals([
      costLine(),
      costLine({ id: 'pd', priceStatus: 'unavailable', amounts: null, unitPrice: null }),
    ]);
    expect(totals.unpricedLineCount).toBe(1);
    expect(totals.monthly.expected).toBe(47.45);
  });
});

describe('parseRfpGeneratedDraft', () => {
  it('GD-0 accepts a valid proposal draft and recomputes totals', () => {
    const draft = proposalDraft();
    const parsed = parseRfpGeneratedDraft({ ...draft, totals: { bogus: true } });
    expect(parsed).not.toBeNull();
    expect((parsed as RfpProposalDraft).totals.monthly.expected).toBe(47.45);
  });

  it('GD-0 accepts a valid decision summary', () => {
    const summary: RfpDecisionSummaryDraft = {
      version: 1,
      kind: 'decision-summary',
      jobId: 'job-2',
      inputFingerprint: 'fp-2',
      verdict: 'decline',
      generatedAt: '2026-09-28T12:00:00.000Z',
      editedBy: null,
      editedAt: null,
      summary: 'We will not build this.',
      reasons: ['A licensed product already covers it'],
      alternatives: ['Use the existing HR system'],
      nextSteps: ['Talk to HR IT'],
    };
    expect(parseRfpGeneratedDraft(summary)).toEqual(summary);
  });

  it('GD-1 rejects cost lines with a non-official source type or a negative amount', () => {
    expect(parseRfpGeneratedDraft(proposalDraft({ costLines: [costLine({ sourceType: 'blog' as never })] }))).toBeNull();
    expect(parseRfpGeneratedDraft(proposalDraft({
      costLines: [costLine({ amounts: { low: -1, expected: 2, high: 3 } })],
    }))).toBeNull();
  });

  it('GD-1 rejects ranges where low exceeds expected or expected exceeds high', () => {
    expect(parseRfpGeneratedDraft(proposalDraft({
      costLines: [costLine({ amounts: { low: 10, expected: 5, high: 20 } })],
    }))).toBeNull();
  });

  it('GD-1 rejects a verified price without an https source URL', () => {
    expect(parseRfpGeneratedDraft(proposalDraft({ costLines: [costLine({ sourceUrl: null })] }))).toBeNull();
    expect(parseRfpGeneratedDraft(proposalDraft({ costLines: [costLine({ sourceUrl: 'http://example.com' })] }))).toBeNull();
  });

  it('GD-1 rejects an unknown kind or version', () => {
    expect(parseRfpGeneratedDraft({ ...proposalDraft(), kind: 'memo' })).toBeNull();
    expect(parseRfpGeneratedDraft({ ...proposalDraft(), version: 2 })).toBeNull();
    expect(parseRfpGeneratedDraft(null)).toBeNull();
  });
});

describe('validateRfpDraftForPublish', () => {
  it('PB-0 accepts a proposal whose costs are all priced and confirmed', () => {
    expect(validateRfpDraftForPublish(proposalDraft())).toEqual([]);
  });

  it('PB-0 requires every cost line to be admin-confirmed', () => {
    expect(validateRfpDraftForPublish(proposalDraft({ costLines: [costLine({ adminConfirmed: false })] })))
      .toContain('RDS PostgreSQL needs admin confirmation');
  });

  it('PB-0 requires an amount for unavailable prices before publishing', () => {
    expect(validateRfpDraftForPublish(proposalDraft({
      costLines: [costLine({ priceStatus: 'unavailable', amounts: null, adminConfirmed: true })],
    }))).toContain('RDS PostgreSQL needs an amount');
  });
});

describe('rfpRepoNameFromTitle', () => {
  it('AR-1 slugs the request title into a repo name', () => {
    expect(rfpRepoNameFromTitle('  Benefits Tracker (v2)! ')).toBe('benefits-tracker-v2');
  });

  it('AR-1 falls back when the title has no usable characters', () => {
    expect(rfpRepoNameFromTitle('!!!')).toBe('apex-app');
  });

  it('AR-1 caps the length and does not end on a dash', () => {
    const name = rfpRepoNameFromTitle(`${'a'.repeat(62)} tail`);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith('-')).toBe(false);
  });
});

describe('rfpWizardInitialStep', () => {
  it('WZ-0 opens on Request details until a proposal is published', () => {
    expect(rfpWizardInitialStep({ proposal: null, approval: null })).toBe(1);
  });

  it('WZ-3 opens on Proposal once published or approved', () => {
    expect(rfpWizardInitialStep({ proposal: {} as never, approval: null })).toBe(3);
    expect(rfpWizardInitialStep({ proposal: {} as never, approval: {} as never })).toBe(3);
  });
});
