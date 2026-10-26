import React from 'react';
import { Link } from 'react-router-dom';
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
          to={`/playbooks?project=${encodeURIComponent(project)}&run=${encodeURIComponent(start.data.runId)}`}
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
  if (!isOwner || !canRun) return null;
  return (
    <DesignDocPlaybookStartActionEnabled designDocId={designDocId} project={project} />
  );
};
