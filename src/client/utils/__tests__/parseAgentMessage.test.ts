import { parseAgentMessage } from '../parseAgentMessage';
import type { ChoiceBlock, MarkdownBlock } from '../parseAgentMessage';

describe('parseAgentMessage', () => {
  // ── Pure markdown ───────────────────────────────────────────────────────────

  it('returns a single markdown block for plain text', () => {
    const parts = parseAgentMessage('Hello, world!');
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('markdown');
    expect((parts[0] as MarkdownBlock).content).toBe('Hello, world!');
  });

  it('returns an empty array for empty string', () => {
    const parts = parseAgentMessage('');
    expect(parts).toHaveLength(0);
  });

  it('returns empty array for whitespace-only string', () => {
    const parts = parseAgentMessage('   \n  \n  ');
    expect(parts).toHaveLength(0);
  });

  it('preserves multi-line markdown content', () => {
    const text = '# Heading\n\nSome paragraph.\n\nAnother paragraph.';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(1);
    expect((parts[0] as MarkdownBlock).content).toBe(text);
  });

  // ── Basic choice blocks ─────────────────────────────────────────────────────

  it('detects a minimal two-option choice block', () => {
    const text = 'Which approach?\na. Option Alpha\nb. Option Beta';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(1);
    const block = parts[0] as ChoiceBlock;
    expect(block.type).toBe('choices');
    expect(block.options).toHaveLength(2);
    expect(block.options[0]).toEqual({ letter: 'a', text: 'Option Alpha' });
    expect(block.options[1]).toEqual({ letter: 'b', text: 'Option Beta' });
  });

  it('captures question text from the preceding line', () => {
    const text = 'Pick one:\na. First\nb. Second';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(1);
    const block = parts[0] as ChoiceBlock;
    expect(block.question).toBe('Pick one:');
  });

  it('supports all four letters a-d', () => {
    const text = 'Choose:\na. Alpha\nb. Beta\nc. Gamma\nd. Delta';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(1);
    const block = parts[0] as ChoiceBlock;
    expect(block.options).toHaveLength(4);
    expect(block.options.map((o) => o.letter)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('normalises uppercase letters to lowercase', () => {
    const text = 'Which?\nA. First\nB. Second';
    const parts = parseAgentMessage(text);
    const block = parts[0] as ChoiceBlock;
    expect(block.options[0].letter).toBe('a');
    expect(block.options[1].letter).toBe('b');
  });

  it('accepts parenthesis-delimited options (a) style)', () => {
    const text = 'What now?\na) Do this\nb) Do that';
    const parts = parseAgentMessage(text);
    expect(parts[0].type).toBe('choices');
    const block = parts[0] as ChoiceBlock;
    expect(block.options[0].letter).toBe('a');
    expect(block.options[1].letter).toBe('b');
  });

  it('accepts options with leading dashes or asterisks', () => {
    const text = 'Option?\n- a. First\n* b. Second';
    const parts = parseAgentMessage(text);
    expect(parts[0].type).toBe('choices');
    const block = parts[0] as ChoiceBlock;
    expect(block.options).toHaveLength(2);
  });

  it('allows a single blank line between options', () => {
    const text = 'Choose:\na. Alpha\n\nb. Beta';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('choices');
  });

  // ── Fallback: single option treated as plain text ──────────────────────────

  it('falls back to markdown when only one option is present', () => {
    const text = 'Some text.\na. Only option';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('markdown');
  });

  // ── Mixed content ───────────────────────────────────────────────────────────

  it('splits markdown before and choices after', () => {
    const text = 'Intro paragraph.\n\nQuestion:\na. Yes\nb. No';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('markdown');
    expect(parts[1].type).toBe('choices');
    expect((parts[0] as MarkdownBlock).content).toBe('Intro paragraph.');
    expect((parts[1] as ChoiceBlock).question).toBe('Question:');
  });

  it('places trailing text after choices into a markdown block', () => {
    const text = 'a. Option A\nb. Option B\n\nSome footer text.';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('choices');
    expect(parts[1].type).toBe('markdown');
    expect((parts[1] as MarkdownBlock).content).toBe('Some footer text.');
  });

  it('handles multiple choice blocks separated by markdown', () => {
    const text =
      'First question:\na. Yes\nb. No\n\nSome context.\n\nSecond question:\nc. Option C\nd. Option D';
    const parts = parseAgentMessage(text);

    const choiceBlocks = parts.filter((p) => p.type === 'choices');
    const markdownBlocks = parts.filter((p) => p.type === 'markdown');
    expect(choiceBlocks).toHaveLength(2);
    expect(markdownBlocks.length).toBeGreaterThanOrEqual(1);
  });

  // ── ID stability ─────────────────────────────────────────────────────────────

  it('assigns unique ids to each part', () => {
    const text = 'Intro.\n\nQ:\na. A\nb. B\n\nOutro.';
    const parts = parseAgentMessage(text);
    const ids = parts.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────────

  it('trims leading/trailing whitespace from option text', () => {
    const text = 'Q:\na.   Padded option   \nb. Normal option';
    const parts = parseAgentMessage(text);
    const block = parts[0] as ChoiceBlock;
    expect(block.options[0].text).toBe('Padded option');
  });

  it('does not match option lines beyond d', () => {
    // 'e. option' should not be treated as a lettered choice
    const text = 'e. Fifth option\nf. Sixth option';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('markdown');
  });

  // ── Real agent message patterns ──────────────────────────────────────────────

  it('parses a typical agent interview message with intro + question + options', () => {
    const text = [
      'I have loaded the skill. Let me start the interview.',
      '',
      '**Question 1:** Which area of the codebase does this touch?',
      'a. Admin Portal backend',
      'b. MaxHub pipeline',
      'c. Both',
    ].join('\n');

    const parts = parseAgentMessage(text);
    const choices = parts.filter((p) => p.type === 'choices');
    const markdown = parts.filter((p) => p.type === 'markdown');

    expect(choices).toHaveLength(1);
    expect(markdown).toHaveLength(1);
    expect((choices[0] as ChoiceBlock).options).toHaveLength(3);
    expect((choices[0] as ChoiceBlock).question).toContain('Question 1');
  });

  it('produces separate choice blocks for each numbered question', () => {
    const text = [
      '**Question 1:** First question?',
      'a. Yes',
      'b. No',
      '',
      '**Question 2:** Second question?',
      'a. Option A',
      'b. Option B',
    ].join('\n');

    const parts = parseAgentMessage(text);
    const choices = parts.filter((p) => p.type === 'choices');
    expect(choices).toHaveLength(2);
  });

  it('handles "Interview complete" marker as plain markdown', () => {
    const text = '> Interview complete — reply **"create prd"** when you are ready for me to generate the document.';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('markdown');
  });

  it('handles bold-marked question text without crashing', () => {
    const text = '**What is the primary goal?**\na. Improve performance\nb. Add new feature';
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('choices');
    const block = parts[0] as ChoiceBlock;
    expect(block.question).toBe('**What is the primary goal?**');
  });

  it('handles options with em-dash descriptions (real agent format)', () => {
    const text = [
      'Which modules?',
      'a. Admin Portal — template grid row action',
      'b. Backend — resend endpoint only',
      'c. Both — full stack',
    ].join('\n');
    const parts = parseAgentMessage(text);
    expect(parts).toHaveLength(1);
    const block = parts[0] as ChoiceBlock;
    expect(block.options[0].text).toBe('Admin Portal — template grid row action');
  });

  it('survives very long option text without truncating', () => {
    const longText = 'A very detailed option that describes implementation constraints in detail';
    const text = `Choose:\na. ${longText}\nb. Shorter option`;
    const parts = parseAgentMessage(text);
    const block = parts[0] as ChoiceBlock;
    expect(block.options[0].text).toBe(longText);
  });

  it('returns all parts when message contains code block followed by choices', () => {
    const text = [
      'Here is the current code:',
      '',
      '```typescript',
      'const x = 1;',
      '```',
      '',
      'Which approach do you prefer?',
      'a. Refactor',
      'b. Keep as-is',
    ].join('\n');
    const parts = parseAgentMessage(text);
    const choices = parts.filter((p) => p.type === 'choices');
    expect(choices).toHaveLength(1);
    // The code block renders as markdown
    const markdown = parts.filter((p) => p.type === 'markdown');
    expect(markdown.length).toBeGreaterThanOrEqual(1);
  });
});
