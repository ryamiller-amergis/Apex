import React from 'react';
import { Link } from 'react-router-dom';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useStartDesignDocValidationPlaybook } from '../hooks/useDesignDocValidationPlaybook';

interface DesignDocPlaybookStartActionProps {
  designDocId: string;
  project: string;
  isOwner: boolean;
  canRun: boolean;
}

const DesignDocPlaybookStartActionEnabled: React.FC<Omit<DesignDocPlaybookStartActionProps, 'isOwner' | 'canRun'>> = ({
  designDocId,
  project,
}) => {
  const start = useStartDesignDocValidationPlaybook(designDocId, project);
  return (
    <div data-testid="dd-playbook-start">
      <button
        type="button"
        data-testid="dd-playbook-start-btn"
        onClick={() => void start.mutateAsync()}
        disabled={start.isPending}
      >
        {start.isPending ? 'Starting Playbook…' : 'Start validation Playbook'}
      </button>
      {start.isError && (
        <p role="alert" data-testid="dd-playbook-start-error">{start.error.message}</p>
      )}
      {start.data && (
        <Link
          to={`/playbooks/runs/${start.data.runId}?project=${encodeURIComponent(project)}`}
          data-testid="dd-playbook-start-run-link"
        >
          Open run
        </Link>
      )}
    </div>
  );
};

export const DesignDocPlaybookStartAction: React.FC<DesignDocPlaybookStartActionProps> = ({
  designDocId,
  project,
  isOwner,
  canRun,
}) => {
  const enabled = useFeatureFlag('playbooks-production-adapters', project);

  // @feature-flag:playbooks-production-adapters start winner=enabled
  if (!enabled || !isOwner || !canRun) {
    // @feature-flag:playbooks-production-adapters disabled-start
    return null;
    // @feature-flag:playbooks-production-adapters disabled-end
  }
  // @feature-flag:playbooks-production-adapters enabled-start
  return (
    <DesignDocPlaybookStartActionEnabled designDocId={designDocId} project={project} />
  );
  // @feature-flag:playbooks-production-adapters enabled-end
  // @feature-flag:playbooks-production-adapters end
};
