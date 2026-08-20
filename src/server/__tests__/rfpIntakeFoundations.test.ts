import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import {
  rfpAttachments,
  rfpComments,
  rfpEvaluations,
  rfpRequestEvents,
  rfpRequests,
} from '../db/schema';
import {
  parseProductIntakeEvaluationOutput,
  PRODUCT_INTAKE_EVALUATION_OUTPUT_FILE,
  RFP_AI_STATUSES,
  RFP_HUMAN_STATUSES,
  RFP_INTAKE_MANAGE,
  RFP_INTAKE_VIEW,
  RFP_REQUEST_EVENT_TYPES,
  RFP_VERDICTS,
} from '../../shared/types/rfpIntake';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260819210000_rfp-intake-foundations.sql',
);

const VALID_OUTPUT = {
  verdict: 'build',
  confidence: 'high',
  techVelocity: 'stable',
  nativeBenefit: 'high',
  audience: 'internal',
  dataLeavesTenant: false,
  priority: 'high',
  risk: 'low',
  deliveryApproach: 'full-code',
  recommendedLane: 'platform-feature',
  recommendedTooling: ['Apex'],
  hostingRecommendation: 'azure-existing',
  operationalOwner: 'Apex platform team',
  reuseOpportunity: 'none',
  entersInterviewFlow: false,
  buildBuyRentSummary: 'Build it in Apex because it multiplies existing governance.',
  rationale: 'Stable CRUD with high native benefit; keep data in tenant.',
  existingOverlap: 'none',
  clarifyingQuestions: [],
};

describe('FEAT-001 TBI-001 RFP persistence and shared contracts', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('DoD-0 / VT-01 creates all five RFP tables, indexes, constraints, settings, and permissions', () => {
    expect(upSql).toMatch(/CREATE TABLE rfp_requests/i);
    expect(upSql).toMatch(/CREATE TABLE rfp_evaluations/i);
    expect(upSql).toMatch(/CREATE TABLE rfp_comments/i);
    expect(upSql).toMatch(/CREATE TABLE rfp_attachments/i);
    expect(upSql).toMatch(/CREATE TABLE rfp_request_events/i);
    expect(upSql).toMatch(/UNIQUE \(rfp_request_id, version\)/);
    expect(upSql).toMatch(/idx_rfp_requests_owner_created/);
    expect(upSql).toMatch(/idx_rfp_requests_status_created/);
    expect(upSql).toMatch(/idx_rfp_evaluations_verdict/);
    expect(upSql).toMatch(/idx_rfp_request_events_request_created/);
    expect(upSql).toMatch(/product_intake_evaluation_skill_path/);
    expect(upSql).toMatch(/product_intake_evaluation_model/);
    expect(upSql).toContain(`'${RFP_INTAKE_VIEW}'`);
    expect(upSql).toContain(`'${RFP_INTAKE_MANAGE}'`);
    expect(upSql).toMatch(/FOREIGN KEY \(current_evaluation_id\) REFERENCES rfp_evaluations\(id\)/);
    expect(upSql).toMatch(/REFERENCES rfp_requests\(id\) ON DELETE CASCADE/);
  });

  it('DoD-0 / VT-02 Evaluation version uniqueness is enforced on (rfp_request_id, version)', () => {
    expect(upSql).toMatch(/CONSTRAINT rfp_evaluations_request_version_key UNIQUE \(rfp_request_id, version\)/);
  });

  it('DoD-1 ORM schema table names and columns match the migration', () => {
    expect(getTableName(rfpRequests)).toBe('rfp_requests');
    expect(getTableName(rfpEvaluations)).toBe('rfp_evaluations');
    expect(getTableName(rfpComments)).toBe('rfp_comments');
    expect(getTableName(rfpAttachments)).toBe('rfp_attachments');
    expect(getTableName(rfpRequestEvents)).toBe('rfp_request_events');
    expect(Object.keys(getTableColumns(rfpRequests))).toEqual(
      expect.arrayContaining([
        'id', 'ownerId', 'status', 'aiStatus', 'aiThreadId',
        'sourceProject', 'currentEvaluationId', 'clarificationUsed',
        'reviewerVerdict', 'reviewerRationale', 'reviewerId',
        'reviewerDecidedAt', 'reviewerSourceMessageIds',
      ]),
    );
    expect(Object.keys(getTableColumns(rfpEvaluations))).toEqual(
      expect.arrayContaining(['id', 'rfpRequestId', 'version', 'verdict', 'rawOutput']),
    );
  });

  it('DoD-2 shared contracts compile with Product Intake Evaluation enums', () => {
    expect(RFP_VERDICTS).toEqual([
      'build', 'rent-and-wrap', 'rent', 'buy', 'decline', 'needs-clarification',
    ]);
    expect(RFP_HUMAN_STATUSES).toContain('evaluating');
    expect(RFP_HUMAN_STATUSES).toContain('evaluated');
    expect(RFP_REQUEST_EVENT_TYPES).toContain('reviewer-decision-applied');
    expect(RFP_AI_STATUSES).toEqual(['evaluating', 'failed', 'complete']);
    expect(PRODUCT_INTAKE_EVALUATION_OUTPUT_FILE).toBe('product-intake-evaluation.json');
    expect(parseProductIntakeEvaluationOutput(VALID_OUTPUT)).toEqual(VALID_OUTPUT);
    expect(parseProductIntakeEvaluationOutput({
      ...VALID_OUTPUT,
      rationale: '## Call\nBuild a standalone app.\n\n## Caveat\nOwner is unassigned.',
    })?.rationale).toContain('## Call');
    expect(parseProductIntakeEvaluationOutput({ verdict: 'maybe' })).toBeNull();
    expect(parseProductIntakeEvaluationOutput(null)).toBeNull();
  });

  it('DoD-0 down drops only the new RFP tables and seeded rows', () => {
    expect(downSql).toMatch(/DROP TABLE IF EXISTS rfp_request_events/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS rfp_attachments/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS rfp_comments/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS rfp_evaluations/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS rfp_requests/);
    expect(downSql).toMatch(/DELETE FROM app_permissions WHERE key IN \('rfp-intake:view', 'rfp-intake:manage'\)/);
    expect(downSql).not.toMatch(/DROP TABLE IF EXISTS app_users/);
  });
});
