import { render, screen } from '@testing-library/react';
import { BuildSandboxPreview } from '../BuildSandboxPreview';

describe('BuildSandboxPreview', () => {
  it('shows waiting copy and places the branch iframe without same-origin sandbox', () => {
    render(
      <BuildSandboxPreview
        buildStatus="deploying"
        deployment={{
          status: 'queued',
          queuePosition: 2,
          previewUrl: null,
          leaseExpiresAt: null,
          failedStage: null,
          errorExcerpt: null,
          pipelineUrl: null,
          supportContactNames: [],
        }}
        previews={[]}
        livePreviewUrl={null}
        showPipelineSteps={false}
        pipelineSteps={null}
      />
    );
    expect(screen.getByTestId('build-sandbox-status')).toHaveTextContent(
      'Waiting for a preview slot'
    );
  });

  it('renders a safe iframe when a live preview URL is available', () => {
    render(
      <BuildSandboxPreview
        buildStatus="preview_ready"
        deployment={{
          status: 'succeeded',
          queuePosition: null,
          previewUrl: 'https://apex.example/api/builds/b/preview/t/',
          leaseExpiresAt: null,
          failedStage: null,
          errorExcerpt: null,
          pipelineUrl: null,
          supportContactNames: [],
        }}
        previews={[
          {
            revisionNumber: 1,
            commit: 'a'.repeat(40),
            deploymentStatus: 'succeeded',
            finishedAt: '2026-11-01T12:00:00.000Z',
            previewUrl: 'https://apex.example/api/builds/b/preview/t/',
            isLive: true,
          },
        ]}
        livePreviewUrl="https://apex.example/api/builds/b/preview/t/"
        showPipelineSteps={false}
        pipelineSteps={null}
      />
    );
    const iframe = screen.getByTestId('build-workspace-preview-iframe');
    expect(iframe).toHaveAttribute(
      'sandbox',
      'allow-forms allow-modals allow-scripts'
    );
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.getByTestId('build-sandbox-status')).toHaveTextContent(
      'Preview ready'
    );
  });

  it('retains origin only for a loopback Studio preview so Vite HMR can connect', () => {
    render(
      <BuildSandboxPreview
        buildStatus="intake"
        deployment={undefined}
        previews={[]}
        livePreviewUrl="http://127.0.0.1:43123/"
        showPipelineSteps={false}
        pipelineSteps={null}
      />
    );

    expect(
      screen.getByTestId('build-workspace-preview-iframe')
    ).toHaveAttribute(
      'sandbox',
      'allow-forms allow-modals allow-scripts allow-same-origin'
    );
  });

  it('updates fast-edit status without replacing the stable iframe', () => {
    const progress = {
      attemptId: 'attempt-1',
      revisionNumber: 2,
      status: 'apply' as const,
      route: 'fast_edit' as const,
      requestedAt: '2026-11-06T18:00:00.000Z',
      previewUpdatedAt: null,
      checksCompletedAt: null,
      checkSummary: null,
      error: null,
      workspaceVersion: 0,
    };
    const view = render(
      <BuildSandboxPreview
        buildStatus="building"
        deployment={undefined}
        previews={[]}
        livePreviewUrl="http://127.0.0.1:43123/"
        showPipelineSteps={false}
        pipelineSteps={null}
        revisionProgress={progress}
      />
    );
    const iframe = screen.getByTestId('build-workspace-preview-iframe');
    expect(screen.getByTestId('build-sandbox-status')).toHaveTextContent(
      'Updating preview'
    );

    view.rerender(
      <BuildSandboxPreview
        buildStatus="preview_ready"
        deployment={undefined}
        previews={[]}
        livePreviewUrl="http://127.0.0.1:43123/"
        showPipelineSteps={false}
        pipelineSteps={null}
        revisionProgress={{
          ...progress,
          status: 'checking',
          workspaceVersion: 1,
        }}
      />
    );

    expect(screen.getByTestId('build-sandbox-status')).toHaveTextContent(
      'Preview updated—checking'
    );
    expect(screen.getByTestId('build-workspace-preview-iframe')).toBe(iframe);
  });

  it('keeps the iframe node when a provider rotates its upstream URL', () => {
    const view = render(
      <BuildSandboxPreview
        buildStatus="preview_ready"
        deployment={undefined}
        previews={[]}
        livePreviewUrl="http://127.0.0.1:43123/"
        showPipelineSteps={false}
        pipelineSteps={null}
      />
    );
    const iframe = screen.getByTestId('build-workspace-preview-iframe');

    view.rerender(
      <BuildSandboxPreview
        buildStatus="building"
        deployment={undefined}
        previews={[]}
        livePreviewUrl="http://127.0.0.1:43124/"
        showPipelineSteps={false}
        pipelineSteps={null}
      />
    );

    expect(screen.getByTestId('build-workspace-preview-iframe')).toBe(iframe);
    expect(iframe).toHaveAttribute('src', 'http://127.0.0.1:43124/');
  });
});
