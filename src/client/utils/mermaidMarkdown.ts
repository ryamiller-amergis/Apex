const MERMAID_KEYWORD_RE = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|C4Context|C4Container|C4Component|C4Deployment|C4Dynamic|quadrantChart|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta|requirementDiagram|zenuml|kanban)\b/;

export function normalizeMermaidBlocks(markdown: string): string {
  const lines = markdown.split('\n');
  const normalized: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      const fenceMarker = trimmed.startsWith('```') ? '```' : '~~~';

      if (!inFence) {
        // Opening fence — check if it's a bare fence (no language tag) whose
        // first content line is a mermaid keyword. If so, rewrite as ```mermaid.
        const lang = trimmed.slice(fenceMarker.length).trim();
        if (!lang && i + 1 < lines.length && MERMAID_KEYWORD_RE.test(lines[i + 1].trim())) {
          normalized.push(`${fenceMarker}mermaid`);
          inFence = true;
          continue;
        }
      }

      inFence = !inFence;
      normalized.push(line);
      continue;
    }

    if (!inFence && MERMAID_KEYWORD_RE.test(trimmed)) {
      normalized.push('```mermaid');

      while (i < lines.length) {
        const currentLine = lines[i];
        const currentTrimmed = currentLine.trim();

        if (i !== 0 && (/^#{1,6}\s+/.test(currentLine) || currentTrimmed === '---')) {
          break;
        }

        normalized.push(currentLine);
        i += 1;
      }

      normalized.push('```');
      i -= 1;
      continue;
    }

    normalized.push(line);
  }

  return normalized.join('\n');
}

/**
 * Escape semicolons inside sequence diagram message labels.
 *
 * Mermaid treats `;` as a line separator, so a message like
 *   `A-->>B: status=error; local list retained`
 * is parsed as two statements — the second one (`local list retained`)
 * is invalid and causes a parse error. Replace `;` with the mermaid
 * HTML entity `#59;` so it renders as a literal semicolon.
 */
function escapeSequenceDiagramSemicolons(chart: string): string {
  const lines = chart.split('\n');
  let isSequence = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^sequenceDiagram\b/.test(trimmed)) {
      isSequence = true;
      continue;
    }
    if (!isSequence) continue;

    // Match message lines: arrows (->> -->> -> --> -x --x -) --)
    // followed by a participant and colon, then the message text.
    const msgMatch = lines[i].match(/^(\s*\S+\s*-[->x.)]+[+-]?\s*\S+\s*:\s*)(.*)/);
    if (msgMatch && msgMatch[2].includes(';')) {
      lines[i] = msgMatch[1] + msgMatch[2].replace(/;/g, '#59;');
    }

    // Also handle Note lines: `Note over X: text with ; in it`
    const noteMatch = lines[i].match(/^(\s*Note\s+(?:over|left of|right of)\s+[^:]+:\s*)(.*)/i);
    if (noteMatch && noteMatch[2].includes(';')) {
      lines[i] = noteMatch[1] + noteMatch[2].replace(/;/g, '#59;');
    }
  }

  return lines.join('\n');
}

export function normalizeMermaidChart(chart: string): string {
  return escapeSequenceDiagramSemicolons(chart
    // ([[" text "]]) → (["text"]) — subroutine shape wrapped in parens (AI over-nests)
    .replace(/\(\[\["([^"]+)"\]\]\)/g, '(["$1"])')
    .replace(/\(\[\[([^\]]+)\]\]\)/g, '([$1])')
    // {{"quoted text"}} → {"quoted text"} — quoted hexagon shape invalid in Mermaid v11+
    .replace(/\{\{"([^"]+)"\}\}/g, '{"$1"}')
  );
}
