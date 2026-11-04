/**
 * S4 — Build deployment callback auth and internal route tests (TBI-025 DoD-1, PBI-028 AC-0 / VT-07, VT-13).
 */
import express from 'express';
import request from 'supertest';
import buildDeploymentsInternalRouter, {
  setBuildDeploymentCallbackServiceForTests,
} from '../routes/buildDeploymentsInternal';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/internal/build-deployments', buildDeploymentsInternalRouter);
  return app;
}

describe('POST /internal/build-deployments/callback (TBI-025 DoD-1 / VT-07, VT-13)', () => {
  const originalEnv = process.env;
  const mockSettle = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.BUILD_DEPLOY_CALLBACK_TOKEN;
    delete process.env.BUILD_DEPLOY_CALLBACK_AUDIENCE;
    delete process.env.BUILD_DEPLOY_ALLOWED_CLIENT_IDS;
    setBuildDeploymentCallbackServiceForTests({
      settleFromCallback: mockSettle,
    });
  });

  afterAll(() => {
    process.env = originalEnv;
    setBuildDeploymentCallbackServiceForTests(null);
  });

  it('VT-07 TBI-025 DoD-1 returns 503 when callback auth is unconfigured, 401 when missing/wrong token, and 200 with valid token', async () => {
    // 503 when unconfigured
    const unconfRes = await request(buildApp())
      .post('/internal/build-deployments/callback')
      .send({
        pipelineRunId: '4411',
        commit: 'a'.repeat(40),
        status: 'succeeded',
        previewUrl: 'https://preview.example.com/app',
      });
    expect(unconfRes.status).toBe(503);
    expect(mockSettle).not.toHaveBeenCalled();

    process.env.BUILD_DEPLOY_CALLBACK_TOKEN = 'super-secret-callback-token';

    // 401 when missing header
    const noHeaderRes = await request(buildApp())
      .post('/internal/build-deployments/callback')
      .send({
        pipelineRunId: '4411',
        commit: 'a'.repeat(40),
        status: 'succeeded',
        previewUrl: 'https://preview.example.com/app',
      });
    expect(noHeaderRes.status).toBe(401);
    expect(mockSettle).not.toHaveBeenCalled();

    // 401 when wrong token
    const badTokenRes = await request(buildApp())
      .post('/internal/build-deployments/callback')
      .set('Authorization', 'Bearer wrong-token')
      .send({
        pipelineRunId: '4411',
        commit: 'a'.repeat(40),
        status: 'succeeded',
        previewUrl: 'https://preview.example.com/app',
      });
    expect(badTokenRes.status).toBe(401);
    expect(mockSettle).not.toHaveBeenCalled();

    // 200 when valid token
    mockSettle.mockResolvedValueOnce({ kind: 'ok', response: { applied: true } });
    const okRes = await request(buildApp())
      .post('/internal/build-deployments/callback')
      .set('Authorization', 'Bearer super-secret-callback-token')
      .send({
        pipelineRunId: '4411',
        commit: 'a'.repeat(40),
        status: 'succeeded',
        previewUrl: 'https://preview.example.com/app',
      });
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual({ applied: true });
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it('VT-13 TBI-025 / PBI-028 AC-0 rejects javascript: previewUrl (422) and commit mismatch (422), and redacts secrets in errorText', async () => {
    process.env.BUILD_DEPLOY_CALLBACK_TOKEN = 'super-secret-callback-token';

    const jsUrlRes = await request(buildApp())
      .post('/internal/build-deployments/callback')
      .set('Authorization', 'Bearer super-secret-callback-token')
      .send({
        pipelineRunId: '4411',
        commit: 'a'.repeat(40),
        status: 'succeeded',
        previewUrl: 'javascript:alert(1)',
      });
    expect(jsUrlRes.status).toBe(422);
    expect(mockSettle).not.toHaveBeenCalled();

    mockSettle.mockResolvedValueOnce({ kind: 'commit_mismatch' });
    const mismatchRes = await request(buildApp())
      .post('/internal/build-deployments/callback')
      .set('Authorization', 'Bearer super-secret-callback-token')
      .send({
        pipelineRunId: '4411',
        commit: 'b'.repeat(40),
        status: 'succeeded',
        previewUrl: 'https://preview.example.com',
      });
    expect(mismatchRes.status).toBe(422);

    mockSettle.mockResolvedValueOnce({ kind: 'ok', response: { applied: true } });
    const failRes = await request(buildApp())
      .post('/internal/build-deployments/callback')
      .set('Authorization', 'Bearer super-secret-callback-token')
      .send({
        pipelineRunId: '4411',
        commit: 'a'.repeat(40),
        status: 'failed',
        failedStage: 'Deploy',
        errorText: 'Failed with Bearer mySecretToken12345 and postgres://u:secretPass@h:5432/db',
      });
    expect(failRes.status).toBe(200);
    const passedInput = mockSettle.mock.calls[1][0];
    expect(passedInput.errorText).not.toContain('mySecretToken12345');
    expect(passedInput.errorText).not.toContain('secretPass');
  });
});
