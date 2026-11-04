import { approvalReportForStep } from '../playbookApprovalReport';

describe('approvalReportForStep', () => {
  const edges = [
    { from: 'scan', to: 'gate' },
    { from: 'other', to: 'later' },
  ];

  it('uses the report from the step that feeds the gate', () => {
    const report = approvalReportForStep([
      { stepId: 'other', outputInline: { reportMd: 'unrelated' }, completedAt: '2026-11-02T14:00:00.000Z' },
      { stepId: 'scan', outputInline: { reportMd: 'the finding' }, completedAt: '2026-11-02T13:00:00.000Z' },
    ], edges, 'gate');

    expect(report).toBe('the finding');
  });

  it('does not borrow a report from a step that does not lead to the gate', () => {
    expect(approvalReportForStep([
      { stepId: 'other', outputInline: { reportMd: 'unrelated' }, completedAt: '2026-11-02T14:00:00.000Z' },
      { stepId: 'scan', outputInline: {}, completedAt: '2026-11-02T13:00:00.000Z' },
    ], edges, 'gate')).toBeNull();
  });
});
