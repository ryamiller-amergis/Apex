import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'] as const;

/** Fails on every axe violation and names the rule id, impact, and first node. */
export async function expectNoAxeViolations(
  page: Page,
  label: string
): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags([...TAGS]).analyze();
  if (results.violations.length === 0) {
    return;
  }
  const details = results.violations
    .map((violation) => {
      const node = violation.nodes[0]?.target?.join(' ') ?? '';
      return `${violation.id} (${violation.impact ?? 'unknown'}) ${node}`.trim();
    })
    .join('\n');
  throw new Error(`axe violations on ${label}:\n${details}`);
}
