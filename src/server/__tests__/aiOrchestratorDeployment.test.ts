import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readRepoFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

describe('AI orchestrator image deployment', () => {
  const detector = readRepoFile('scripts/ci/detect-image-publish-changes.sh');
  const publishScript = readRepoFile('scripts/ci/publish-ai-orchestrator.sh');
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
});
