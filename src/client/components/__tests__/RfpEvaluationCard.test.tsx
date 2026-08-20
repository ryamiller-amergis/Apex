import { render, screen } from '@testing-library/react';
import { RfpEvaluationCard } from '../RfpEvaluationCard';
import type { RfpEvaluation } from '../../../shared/types/rfpIntake';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

const evaluation: RfpEvaluation = {
  id: 'ev-1',
  rfpRequestId: 'rfp-1',
  version: 1,
  verdict: 'buy',
  confidence: 'medium',
  techVelocity: 'moderate',
  nativeBenefit: 'medium',
  audience: 'internal',
  dataLeavesTenant: false,
  priority: 'medium',
  risk: 'medium',
  deliveryApproach: 'low-code-config',
  recommendedLane: 'low-code-solution',
  recommendedTooling: ['Cornerstone'],
  hostingRecommendation: 'vendor-hosted',
  operationalOwner: 'People Operations',
  reuseOpportunity: 'Cornerstone',
  entersInterviewFlow: false,
  buildBuyRentSummary: 'Configure Cornerstone instead of building a custom app.',
  rationale: 'Axis A is moderate; Axis B is medium; Host on vendor SaaS.',
  existingOverlap: 'none',
  clarifyingQuestions: [],
  rawOutput: {} as never,
  committedProductBadge: false,
  createdAt: '2026-08-20T00:00:00.000Z',
};

describe('RfpEvaluationCard', () => {
  it('renders structured facts and splits a packed rationale', () => {
    render(<RfpEvaluationCard evaluation={evaluation} />);
    expect(screen.getByTestId('rfp-evaluation-facts')).toHaveTextContent(/SDLC product fit/i);
    expect(screen.getByTestId('rfp-evaluation-rationale').textContent).toMatch(/Axis A is moderate/);
    expect(screen.getByTestId('rfp-evaluation-rationale').textContent).toMatch(/Host on vendor SaaS/);
  });
});
