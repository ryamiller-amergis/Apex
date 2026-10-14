import type { ChoiceBlock } from './parseAgentMessage';

export interface ChoiceSelection {
  selected: string | null;
  freeform: string;
}

/**
 * Builds the reply sent when the user submits picker answers. `Q<n>` is the
 * UI's running counter, which drifts from the agent's own question labels,
 * so each answer quotes the question it answers.
 */
export function formatChoiceAnswers(
  blocks: ReadonlyArray<ChoiceBlock>,
  selections: Readonly<Record<string, ChoiceSelection | undefined>>,
  questionOffset = 0,
): string {
  const answers: string[] = [];
  blocks.forEach((block, index) => {
    const selection = selections[block.id];
    if (!selection?.selected) return;
    const question = block.question.trim();
    const lines = [`Q${questionOffset + index + 1}${question ? ` · ${question}` : ''}`];
    const notes = selection.freeform.trim();
    if (selection.selected === 'other') {
      lines.push(`Answer: ${notes}`);
    } else {
      const option = block.options.find((o) => o.letter === selection.selected);
      lines.push(`Answer: ${selection.selected.toUpperCase()} — ${option?.text ?? selection.selected}`);
      if (notes) lines.push(`Notes: ${notes}`);
    }
    answers.push(lines.join('\n'));
  });
  return answers.join('\n\n');
}
