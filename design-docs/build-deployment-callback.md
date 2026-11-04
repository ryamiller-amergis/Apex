# Build Deployment Callback Contract

## Endpoint

`POST /internal/build-deployments/callback`

## Authentication

Send an `Authorization: Bearer <credential>` header using either:
- **Managed identity JWT**: Audience matching `BUILD_DEPLOY_CALLBACK_AUDIENCE` (or `api://<AZURE_CLIENT_ID>`) and caller `appid`/`azp` listed in `BUILD_DEPLOY_ALLOWED_CLIENT_IDS`.
- **Static pipeline secret**: Matches `BUILD_DEPLOY_CALLBACK_TOKEN` (compared with `crypto.timingSafeEqual`).

## Request Body (`BuildDeploymentCallbackRequest`)

```json
{
  "pipelineRunId": "4411",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "status": "succeeded",
  "previewUrl": "https://preview.dev.example.com",
  "pipelineUrl": "https://dev.azure.com/org/project/_build/results?buildId=4411",
  "failedStage": "Deploy_Dev",
  "errorText": "Optional failure summary"
}
```

## Retry Guidance

Retry on network error or HTTP 5xx up to 3 times, 10 seconds apart. The endpoint is idempotent on `pipelineRunId`.
