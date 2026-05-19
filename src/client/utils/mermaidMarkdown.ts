export function normalizeMermaidBlocks(markdown: string): string {
  const lines = markdown.split('\n');
  const normalized: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      normalized.push(line);
      continue;
    }

    if (!inFence && /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph)\b/.test(trimmed)) {
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

export function normalizeMermaidChart(chart: string): string {
  return chart
    .replace(/\(\[\["([^"]+)"\]\]\)/g, '(["$1"])')
    .replace(/\(\[\[([^\]]+)\]\]\)/g, '([$1])');
}
