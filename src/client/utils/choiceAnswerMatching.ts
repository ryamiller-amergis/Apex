import type { ChoiceBlock } from './parseAgentMessage';

/**
 * True only when every choice question in `blocks` is quoted by one of the
 * later user messages. `formatChoiceAnswers` always echoes the question text
 * back as `Q{n} · {question}`, so a real answer's text contains the question
 * verbatim. A later user message merely existing in the thread is not
 * enough — that message may answer a *different*, more recent question,
 * leaving this one still open.
 */
export function choiceBlocksAnsweredByLaterMessages(
  blocks: ReadonlyArray<ChoiceBlock>,
  laterUserTexts: ReadonlyArray<string>,
): boolean {
  if (blocks.length === 0) return false;
  return blocks.every((block) => {
    const question = block.question.trim();
    // No question text to quote (rare, bare-options block) — fall back to
    // "a later reply exists", the old behavior, since there is nothing to match.
    if (!question) return laterUserTexts.length > 0;
    return laterUserTexts.some((text) => text.includes(question));
  });
}
