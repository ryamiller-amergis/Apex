/**
 * One-off helper to attach a Figma URL to a feature (or PBI view) when the
 * Cursor agent didn't make the callback itself — e.g. the user manually
 * created the Figma page outside the import flow.
 *
 * Usage:
 *   npx ts-node -P tsconfig.server.json scripts/set-figma-url.ts \
 *     --featureId FEAT-Q9ZT-006 \
 *     --figmaUrl "https://www.figma.com/design/.../?node-id=..." \
 *     [--pbiId PBI-...] \
 *     [--project MaxView] \
 *     [--areaPath MaxView]
 *
 * Resolves the feature's pagePath by scanning every backlog draft, then POSTs
 * to /api/backlog/update-figma-url on the local dev server (which uses the
 * localhost bypass — no auth needed).
 */

import dotenv from 'dotenv';
dotenv.config();

import { AzureDevOpsService } from '../src/server/services/azureDevOps';

interface Args {
  featureId: string;
  figmaUrl: string;
  pbiId?: string;
  project?: string;
  areaPath?: string;
  port?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith('--') || value === undefined) continue;
    const key = flag.slice(2) as keyof Args;
    (args as Record<string, string>)[key] = value;
    i++;
  }
  if (!args.featureId) throw new Error('--featureId is required');
  if (!args.figmaUrl) throw new Error('--figmaUrl is required');
  return args as Args;
}

async function main() {
  const args = parseArgs(process.argv);
  const project = args.project ?? process.env.ADO_PROJECT ?? 'MaxView';
  const areaPath = args.areaPath ?? process.env.ADO_AREA_PATH ?? 'MaxView';
  const port = args.port ?? process.env.PORT ?? '3001';

  console.log(`Searching for feature ${args.featureId} in ${project}/${areaPath}…`);

  const ado = new AzureDevOpsService(project, areaPath);
  const docs = await ado.getDraftBacklogDocs() as any[];

  const match = docs
    .map((d: any) => ({
      pagePath: d.path as string,
      feature: ((d.document?.features ?? []) as any[]).find((f: any) => f.id === args.featureId),
    }))
    .find(m => m.feature);

  if (!match) {
    throw new Error(`Feature ${args.featureId} not found in any backlog draft under ${project}/${areaPath}`);
  }

  console.log(`Found on page: ${match.pagePath}`);
  console.log(`Feature title: "${match.feature.title}"`);
  if (args.pbiId) {
    const view = (match.feature.uiMock?.views ?? []).find((v: any) => v.pbiId === args.pbiId);
    if (!view) throw new Error(`PBI view ${args.pbiId} not found on feature ${args.featureId}`);
    console.log(`Targeting PBI view: "${view.pbiTitle}"`);
  } else {
    if (!match.feature.uiMock) {
      throw new Error(`Feature ${args.featureId} has no uiMock — nothing to attach a Figma URL to`);
    }
  }

  const body = {
    featureId: args.featureId,
    pagePath: match.pagePath,
    figmaUrl: args.figmaUrl,
    project,
    areaPath,
    ...(args.pbiId ? { pbiId: args.pbiId } : {}),
  };

  console.log(`POST http://localhost:${port}/api/backlog/update-figma-url`);
  const res = await fetch(`http://localhost:${port}/api/backlog/update-figma-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Update failed (${res.status}): ${text}`);
  }
  console.log('Success:', text);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
