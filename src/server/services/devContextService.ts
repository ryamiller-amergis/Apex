import fs from 'fs';
import path from 'path';
import { db } from '../db/drizzle';
import { prds, designDocs, testCases } from '../db/schema';
import { eq, and } from 'drizzle-orm';

export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'prd';
}

/**
 * Injects PRD, backlog, design doc (design/tech-spec/assumptions), and test
 * cases into the dev workspace under `.ai-pilot/output/` in the layout the
 * dev-orchestrator skill expects (Phase F0).
 *
 * Called at session start for Apex PRD-sourced dev sessions.
 */
export async function injectDevContextFiles(
  workspaceDir: string,
  prdId: string,
  featureId: string,
): Promise<void> {
  const prdRow = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!prdRow) return;

  const slug = sanitizeSlug(prdRow.title);
  const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  // 1. Write PRD markdown
  if (prdRow.content) {
    fs.writeFileSync(path.join(outputDir, `${slug}.prd.md`), prdRow.content, 'utf-8');
  }

  // 2. Write backlog JSON
  if (prdRow.backlogJson) {
    fs.writeFileSync(
      path.join(outputDir, `${slug}.backlog.json`),
      JSON.stringify(prdRow.backlogJson, null, 2),
      'utf-8',
    );
  }

  // 3. Write test cases if available
  const testCaseRow = await db.query.testCases.findFirst({
    where: eq(testCases.prdId, prdId),
  });
  if (testCaseRow?.testCasesJson) {
    fs.writeFileSync(
      path.join(outputDir, `${slug}.test-cases.json`),
      JSON.stringify(testCaseRow.testCasesJson, null, 2),
      'utf-8',
    );
  }

  // 4. Write design doc artifacts for the target feature
  const featureIndex = resolveFeatureIndex(prdRow.backlogJson, featureId);
  if (featureIndex === null) return;

  const docRow = await db.query.designDocs.findFirst({
    where: and(eq(designDocs.prdId, prdId), eq(designDocs.featureIndex, featureIndex)),
  });
  if (!docRow) return;

  const featureSlug = sanitizeSlug(docRow.title);
  const specDir = path.join(outputDir, `${slug}-design-spec`);
  fs.mkdirSync(specDir, { recursive: true });

  if (docRow.designContent) {
    fs.writeFileSync(path.join(specDir, `${featureSlug}-design.md`), docRow.designContent, 'utf-8');
  }
  if (docRow.techSpecContent) {
    fs.writeFileSync(path.join(specDir, `${featureSlug}-tech-spec.md`), docRow.techSpecContent, 'utf-8');
  }
  if (docRow.assumptionsContent) {
    fs.writeFileSync(path.join(specDir, `${featureSlug}-assumptions.md`), docRow.assumptionsContent, 'utf-8');
  }
}

export function resolveFeatureIndex(backlogJson: unknown, featureId: string): number | null {
  if (!backlogJson || typeof backlogJson !== 'object') return null;
  const backlog = backlogJson as { epics?: Array<{ features?: Array<{ id?: string }> }> };
  let globalIdx = 0;
  for (const epic of backlog.epics ?? []) {
    for (const feat of epic.features ?? []) {
      if (feat.id === featureId) return globalIdx;
      globalIdx++;
    }
  }
  return null;
}
