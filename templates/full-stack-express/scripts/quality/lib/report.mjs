export function findingLine(level, finding) {
  return `${level} ${finding.file} ${finding.path}: ${finding.message}`;
}

function table(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column]).length))
  );
  const line = (cells) =>
    cells
      .map((cell, column) => String(cell).padEnd(widths[column]))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

/**
 * Renders the validator result as plain-text lines: one line per finding, the
 * gate table, the deferral list, the NFR trace table, then the totals.
 */
export function formatReport(result) {
  const lines = [];
  for (const finding of result.errors) {
    lines.push(findingLine('ERROR', finding));
  }
  for (const finding of result.warnings) {
    lines.push(findingLine('WARN', finding));
  }

  const { gates, deferrals, targets } = result.summary;
  if (gates.length > 0) {
    lines.push(
      '',
      'Gates (defined means the script exists; the validator does not run it)'
    );
    lines.push(
      ...table(
        ['gate', 'status', 'script'],
        gates.map((g) => [g.id, g.status, g.script])
      )
    );
  }
  lines.push('', 'Deferrals');
  if (deferrals.length === 0) {
    lines.push('none');
  } else {
    lines.push(
      ...table(
        ['gate', 'owner', 'reason'],
        deferrals.map((d) => [d.gate, d.owner, d.reason])
      )
    );
  }
  if (targets.length > 0) {
    lines.push('', 'NFR targets');
    lines.push(
      ...table(
        ['target', 'value', 'illustrative', 'verified by'],
        targets.map((t) => [
          t.target,
          t.value,
          t.illustrative ? 'yes' : 'no',
          t.verifiedBy,
        ])
      )
    );
  }
  lines.push(
    '',
    `quality:validate: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`
  );
  return lines;
}
