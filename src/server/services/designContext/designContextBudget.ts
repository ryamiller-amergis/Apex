/**
 * Decides how much design source fits in one prompt.
 *
 * A byte budget replaces the twenty-file cap the Azure DevOps fetch used: the
 * limit is what the model can take, not what an API quota allowed. Files that
 * do not fit come back named, so a caller can say what was left out instead of
 * silently generating from a partial view.
 */
import type { DesignSourceFile } from './repoDesignContextReader';

export const DEFAULT_DESIGN_CONTEXT_BUDGET_BYTES = 400_000;

export type BudgetedDesignContext = Readonly<{
  included: DesignSourceFile[];
  omitted: string[];
  usedBytes: number;
}>;

export function applyDesignContextBudget(
  files: ReadonlyArray<DesignSourceFile>,
  budgetBytes: number = DEFAULT_DESIGN_CONTEXT_BUDGET_BYTES,
): BudgetedDesignContext {
  const included: DesignSourceFile[] = [];
  const omitted: string[] = [];
  let usedBytes = 0;

  for (const file of files) {
    const size = Buffer.byteLength(file.content, 'utf8');
    // Skip and keep going: one oversized file should not truncate the tail.
    if (usedBytes + size > budgetBytes) {
      omitted.push(file.path);
      continue;
    }
    included.push(file);
    usedBytes += size;
  }

  return { included, omitted, usedBytes };
}
