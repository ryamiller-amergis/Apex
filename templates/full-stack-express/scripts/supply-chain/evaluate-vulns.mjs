import { EXIT_CLEAN, EXIT_FINDINGS } from './constants.mjs';

export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function severityOf(value) {
  if (value == null || value === '') {
    return { failing: false, label: 'unknown' };
  }
  const text = String(value).trim();
  const lower = text.toLowerCase();
  if (lower === 'critical' || lower === 'high') {
    return { failing: true, label: lower };
  }
  if (['moderate', 'medium', 'low', 'none', 'unknown'].includes(lower)) {
    return { failing: false, label: lower };
  }
  const score = Number(text);
  if (Number.isFinite(score)) {
    if (score >= 9) {
      return { failing: true, label: 'critical' };
    }
    if (score >= 7) {
      return { failing: true, label: 'high' };
    }
    return { failing: false, label: lower };
  }
  return { failing: false, label: lower };
}

function exceptionMatches(exception, packageName, ids) {
  return exception.package === packageName && ids.includes(exception.advisory);
}

/**
 * Fails on high and critical advisories. A reviewed exception is honored
 * through its expires date, inclusive. An expired exception is reported.
 */
export function evaluateVulns(report, exceptions, options = {}) {
  const today = options.today ?? utcDay();
  const lines = [];
  let findings = 0;

  for (const result of report?.results ?? []) {
    for (const entry of result.packages ?? []) {
      const packageName = entry.package?.name ?? 'unknown';
      for (const group of entry.groups ?? []) {
        const severity = severityOf(group.max_severity);
        if (!severity.failing) {
          continue;
        }
        const ids = [...(group.ids ?? []), ...(group.aliases ?? [])];
        const match = (exceptions ?? []).find((exception) =>
          exceptionMatches(exception, packageName, ids)
        );
        const advisory = group.ids?.[0] ?? ids[0] ?? 'unknown';
        if (match && match.expires >= today) {
          lines.push(`honored exception: ${match.advisory} ${match.package}`);
          continue;
        }
        if (match) {
          lines.push(`expired exception: ${match.advisory} ${match.package}`);
        }
        lines.push(
          `advisory ${advisory} package ${packageName} severity ${severity.label}`
        );
        findings += 1;
      }
    }
  }

  return {
    exitCode: findings === 0 ? EXIT_CLEAN : EXIT_FINDINGS,
    lines,
  };
}
