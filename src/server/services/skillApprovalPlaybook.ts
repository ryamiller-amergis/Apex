import type { PlaybookGraph } from '../../shared/types/playbook';
import type { SkillExperimentSubjectType } from '../../shared/types/skillExperiment';

/** Notify the experiment's creator with the results, then wait at a gate for an approver of that document type. */
export function buildApprovalPlaybookGraph(subjectType: SkillExperimentSubjectType): PlaybookGraph {
  return {
    nodes: [
      {
        id: 'results',
        stepType: 'notify',
        config: {
          title: 'Skill change ready for approval',
          body: '${input.summary}',
          link: '${input.link}',
          recipientUserId: '${input.creatorUserId}',
        },
      },
      {
        id: 'approve',
        stepType: 'approval-gate',
        config: {
          subject: '${input.subject}',
          approverPool: subjectType,
          gatedStepId: 'results',
        },
      },
    ],
    edges: [{ from: 'results', to: 'approve' }],
  };
}
