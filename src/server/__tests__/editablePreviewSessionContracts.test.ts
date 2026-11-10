import {
  EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
  EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
  evaluateEditablePreviewReadiness,
  type EditablePreviewSessionSnapshot,
} from '../services/build/buildPreviewProviderContracts';

const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${'b'.repeat(64)}`;

function readySnapshot(
  overrides: Partial<EditablePreviewSessionSnapshot> = {}
): EditablePreviewSessionSnapshot {
  return {
    spec: {
      contractVersion: EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
      correlation: {
        sessionId: 'studio-session-1',
        buildRunId: 'build-1',
        baseRevisionId: 'revision-1',
        draftRevisionId: 'revision-2',
        revisionNumber: 2,
        baseCommit: 'c'.repeat(40),
        templateVersion: '1.0.0',
      },
      source: {
        snapshotDigest: SOURCE_DIGEST,
        snapshotRef: 'artifact:source-snapshot-1',
      },
      developmentManifestDigest: MANIFEST_DIGEST,
      databaseGrantRef: 'grant:preview-database-1',
      expiresAt: '2026-11-06T18:00:00.000Z',
      policy: {
        egress: 'denied',
        maxRuntimeSeconds: 28_800,
        writableWorkspace: true,
      },
      requiredTransports: EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
    },
    lifecycle: 'ready',
    workspace: {
      writable: true,
      version: 0,
      baseSnapshotDigest: SOURCE_DIGEST,
      appliedChangeSets: [],
    },
    transport: {
      upstreamRef: 'sandbox-upstream:studio-session-1',
      checks: {
        http: 'ready',
        websocket: 'ready',
        vite_hmr: 'ready',
      },
    },
    expiresAt: '2026-11-06T18:00:00.000Z',
    failureCode: null,
    ...overrides,
  };
}

describe('editable preview session contract', () => {
  it('requires HTTP, WebSocket, and Vite HMR before a session is ready', () => {
    expect(
      evaluateEditablePreviewReadiness(
        readySnapshot({
          transport: {
            upstreamRef: 'sandbox-upstream:studio-session-1',
            checks: {
              http: 'ready',
              websocket: 'failed',
              vite_hmr: 'ready',
            },
          },
        })
      )
    ).toEqual({ ready: false, reason: 'transport_not_ready' });
  });

  it('requires a writable workspace reconstructible from the base snapshot and ordered change sets', () => {
    const changeSet = {
      digest: `sha256:${'d'.repeat(64)}`,
      contentRef: 'artifact:change-set-1',
    };
    expect(
      evaluateEditablePreviewReadiness(
        readySnapshot({
          workspace: {
            writable: true,
            version: 1,
            baseSnapshotDigest: SOURCE_DIGEST,
            appliedChangeSets: [changeSet],
          },
        })
      )
    ).toEqual({ ready: true });
    expect(
      evaluateEditablePreviewReadiness(
        readySnapshot({
          workspace: {
            writable: true,
            version: 2,
            baseSnapshotDigest: SOURCE_DIGEST,
            appliedChangeSets: [changeSet],
          },
        })
      )
    ).toEqual({ ready: false, reason: 'source_not_recoverable' });
  });

  it.each([
    ['public URL', 'https://provider.example/session/1'],
    ['Windows path', 'C:\\preview\\workspace'],
    ['Unix path', '/preview/workspace'],
    ['file URL', 'file:///preview/workspace'],
  ])(
    'rejects a %s where the provider must return an opaque reference',
    (_, ref) => {
      expect(
        evaluateEditablePreviewReadiness(
          readySnapshot({
            transport: {
              upstreamRef: ref,
              checks: {
                http: 'ready',
                websocket: 'ready',
                vite_hmr: 'ready',
              },
            },
          })
        )
      ).toEqual({ ready: false, reason: 'provider_location_exposed' });
    }
  );
});
