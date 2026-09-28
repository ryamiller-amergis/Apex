import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readRepoFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

describe('AI orchestrator image deployment', () => {
  const detector = readRepoFile('scripts/ci/detect-image-publish-changes.sh');
  const publishScript = readRepoFile('scripts/ci/publish-ai-orchestrator.sh');
  const interactivePublish = readRepoFile('scripts/ci/publish-ai-runs-interactive.sh');
  const workflows = [
    readRepoFile('.github/workflows/deploy-dev-quick.yml'),
    readRepoFile('.github/workflows/pr-tests.yml'),
    readRepoFile('.github/workflows/deploy.yml'),
  ];
  const productionWorkflow = workflows[2];

  it('detects every source category copied into the orchestrator image', () => {
    expect(detector).toMatch(
      /detect ai_orchestrator[\s\S]*runners\/ai-orchestrator\/[\s\S]*scripts\/ci\/publish-ai-orchestrator\.sh[\s\S]*src\/server\/[\s\S]*src\/shared\/[\s\S]*package\.json[\s\S]*package-lock\.json[\s\S]*tsconfig\.server\.json/,
    );
  });

  it('rebuilds the interactive image for shared server and contract changes', () => {
    expect(detector).toMatch(
      /detect ai_runs_interactive[\s\S]*runners\/ai-runs-interactive\/[\s\S]*src\/server\/[\s\S]*src\/shared\/[\s\S]*package\.json[\s\S]*package-lock\.json[\s\S]*tsconfig\.server\.json/,
    );
  });

  it('publishes and updates the orchestrator in every application deploy workflow', () => {
    for (const workflow of workflows) {
      expect(workflow).toMatch(/ai_orchestrator/);
      expect(workflow).toMatch(
        /AI_ORCHESTRATOR_CONTAINER_APP_NAME:[^\n]*AI_ORCHESTRATOR_CONTAINER_APP_NAME/,
      );
      expect(workflow).toMatch(
        /bash scripts\/ci\/publish-ai-orchestrator\.sh/,
      );
    }
  });

  it('promotes one immutable image through staging and production', () => {
    expect(productionWorkflow).toMatch(
      /AI_ORCHESTRATOR_STAGING_CONTAINER_APP_NAME/,
    );
    expect(productionWorkflow).toMatch(
      /Promote AI orchestrator image to production[\s\S]*SKIP_IMAGE_PUBLISH: true/,
    );
    expect(publishScript).toMatch(
      /SKIP_IMAGE_PUBLISH=.*false[\s\S]*reusing \$\{IMAGE\}/,
    );
  });

  it('rolls one interactive image to legacy and split class Container Apps', () => {
    expect(interactivePublish).toMatch(/AI_PLATFORM_V2_FAST_INTERACTIVE_CONTAINER_APP_NAME/);
    expect(interactivePublish).toMatch(/AI_PLATFORM_V2_AGENTIC_CONTAINER_APP_NAME/);
    expect(interactivePublish).toMatch(/SKIP_IMAGE_PUBLISH/);
    expect(interactivePublish).toMatch(/properties\.healthState/);
    expect(productionWorkflow).toMatch(
      /Promote interactive image to production[\s\S]*SKIP_IMAGE_PUBLISH: true/,
    );
  });

  it('serializes all DEV deployments through one mutex', () => {
    expect(workflows[0]).toMatch(/group: quick-dev-deploy/);
    expect(workflows[1]).toMatch(/group: quick-dev-deploy/);
  });
});
