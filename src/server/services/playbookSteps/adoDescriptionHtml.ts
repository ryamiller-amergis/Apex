/**
 * Turns a Playbook report into HTML an Azure DevOps HTML field will show.
 * Those fields store HTML. Raw markdown is saved, then the form shows nothing useful.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function markdownToAdoHtml(markdown: string): string {
  const parts: string[] = [];
  let list: string[] = [];
  let paragraph: string[] = [];

  const flushList = () => {
    if (!list.length) return;
    parts.push(`<ul>${list.map((item) => `<li>${item}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    parts.push(`<p>${paragraph.join('<br/>')}</p>`);
    paragraph = [];
  };

  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const tag = heading[1].length === 1 ? 'h1' : heading[1].length === 2 ? 'h2' : 'h3';
      parts.push(`<${tag}>${inline(heading[2])}</${tag}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(inline(bullet[1]));
      continue;
    }
    flushList();
    paragraph.push(inline(line));
  }
  flushParagraph();
  flushList();
  return parts.join('');
}
