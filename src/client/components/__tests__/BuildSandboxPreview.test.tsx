import { render, screen } from '@testing-library/react';
import React from 'react';
import { BuildSandboxPreview } from '../BuildSandboxPreview';

describe('BuildSandboxPreview', () => {
  it('shows waiting copy and places the branch iframe without same-origin sandbox', () => {
    render(
      <BuildSandboxPreview
        buildStatus="deploying"
        deployment={{ status: 'queued', queuePosition: 2, previewUrl: null, leaseExpiresAt: null, failedStage: null, errorExcerpt: null, pipelineUrl: null, supportContactNames: [] }}
        previews={[]}
        livePreviewUrl={null}
        showPipelineSteps={false}
        pipelineSteps={null}
      />,
    );
    expect(screen.getByTestId('build-sandbox-status')).toHaveTextContent(
      'Waiting for a preview slot',
    );
  });

  it('renders a safe iframe when a live preview URL is available', () => {
    render(
      <BuildSandboxPreview
        buildStatus="preview_ready"
        deployment={{ status: 'succeeded', queuePosition: null, previewUrl: 'https://apex.example/api/builds/b/preview/t/', leaseExpiresAt: null, failedStage: null, errorExcerpt: null, pipelineUrl: null, supportContactNames: [] }}
        previews={[{ revisionNumber: 1, commit: 'a'.repeat(40), deploymentStatus: 'succeeded', finishedAt: '2026-11-01T12:00:00.000Z', previewUrl: 'https://apex.example/api/builds/b/preview/t/', isLive: true }]}
        livePreviewUrl="https://apex.example/api/builds/b/preview/t/"
        showPipelineSteps={false}
        pipelineSteps={null}
      />,
    );
    const iframe = screen.getByTestId('build-workspace-preview-iframe');
    expect(iframe).toHaveAttribute('sandbox', 'allow-forms allow-modals allow-scripts');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.getByTestId('build-sandbox-status')).toHaveTextContent('Preview ready');
  });
});
