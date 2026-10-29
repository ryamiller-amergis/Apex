import {
  BookmarkParseCancelled,
  defaultCategoryFor,
  parseBookmarksHtml,
  parseBookmarksHtmlAsync,
} from '../parseBookmarksHtml';

const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://maxview.example.com/" ADD_DATE="1">MaxView Prod</A>
        <DT><H3>Tools</H3>
        <DL><p>
            <DT><A HREF="https://dashboard.clerk.com/">Clerk</A>
            <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
            <DT><H3>Analytics</H3>
            <DL><p>
                <DT><A HREF="https://app.pendo.io/">Pendo</A>
            </DL><p>
        </DL><p>
        <DT><A HREF="chrome://settings/">Chrome settings</A>
    </DL><p>
    <DT><A HREF="https://dev.azure.com/org/">   </A>
    <DT><A HREF="file:///C:/notes.txt">Notes</A>
    <DT><A HREF="https://app.sendgrid.com/"><b>Send</b>Grid &lt;img src=x onerror=alert(1)&gt;</A>
</DL><p>`;

describe('parseBookmarksHtml', () => {
  const { bookmarks, skipped } = parseBookmarksHtml(CHROME_EXPORT);
  const byUrl = (url: string) => bookmarks.find((b) => b.url === url);

  it('keeps only http(s) links and counts the rest as skipped', () => {
    expect(bookmarks.map((b) => b.url)).toEqual([
      'https://maxview.example.com/',
      'https://dashboard.clerk.com/',
      'https://app.pendo.io/',
      'https://dev.azure.com/org/',
      'https://app.sendgrid.com/',
    ]);
    expect(skipped).toBe(3);
  });

  it('records the folder path for nested folders', () => {
    expect(byUrl('https://maxview.example.com/')?.folderPath).toEqual(['Bookmarks bar']);
    expect(byUrl('https://dashboard.clerk.com/')?.folderPath).toEqual(['Bookmarks bar', 'Tools']);
    expect(byUrl('https://app.pendo.io/')?.folderPath).toEqual(['Bookmarks bar', 'Tools', 'Analytics']);
    expect(byUrl('https://app.sendgrid.com/')?.folderPath).toEqual([]);
  });

  it('falls back to the URL when a title is empty', () => {
    expect(byUrl('https://dev.azure.com/org/')?.label).toBe('https://dev.azure.com/org/');
  });

  it('reads titles as plain text', () => {
    expect(byUrl('https://app.sendgrid.com/')?.label).toBe('SendGrid <img src=x onerror=alert(1)>');
  });

  it('gives each bookmark a distinct id', () => {
    expect(new Set(bookmarks.map((b) => b.id)).size).toBe(bookmarks.length);
  });

  it('returns nothing for a file that is not a bookmark export', () => {
    expect(parseBookmarksHtml('<html><body><p>hello</p></body></html>')).toEqual({ bookmarks: [], skipped: 0 });
  });

  it('clips long titles to the label limit', () => {
    const html = `<DL><p><DT><A HREF="https://x.com/">${'a'.repeat(200)}</A></DL>`;
    expect(parseBookmarksHtml(html).bookmarks[0].label.length).toBeLessThanOrEqual(80);
  });
});

describe('defaultCategoryFor', () => {
  it('uses the innermost folder name', () => {
    expect(defaultCategoryFor(['Bookmarks bar', 'Tools'])).toBe('Tools');
    expect(defaultCategoryFor([])).toBe('');
  });
});

function bigExport(folders: number, perFolder: number): string {
  const parts = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>'];
  for (let f = 0; f < folders; f += 1) {
    parts.push(`<DT><H3>Folder ${f}</H3>\n<DL><p>`);
    for (let i = 0; i < perFolder; i += 1) {
      parts.push(`<DT><A HREF="https://f${f}-${i}.example.com/?a=1&amp;b=2">Site ${f}-${i}</A>`);
    }
    parts.push('</DL><p>');
  }
  parts.push('</DL><p>');
  return parts.join('\n');
}

describe('scanner details', () => {
  it('decodes entities in URLs and titles', () => {
    const html = `<DL><DT><A HREF="https://x.com/?a=1&amp;b=2">Tom &amp; Jerry &#39;s &#x263A;</A></DL>`;
    const [bookmark] = parseBookmarksHtml(html).bookmarks;
    expect(bookmark.url).toBe('https://x.com/?a=1&b=2');
    expect(bookmark.label).toBe("Tom & Jerry 's ☺");
  });

  it('handles single-quoted and lowercase attributes', () => {
    const html = `<dl><dt><h3>Work</h3><dl><dt><a href='https://work.example.com'>Work</a></dl></dl>`;
    expect(parseBookmarksHtml(html).bookmarks[0]).toMatchObject({
      url: 'https://work.example.com/',
      folderPath: ['Work'],
    });
  });

  it('does not treat a heading with no list after it as a folder', () => {
    const html = `<DL><DT><H3>Empty</H3><DT><A HREF="https://a.com">A</A><DT><H3>Real</H3><DL><DT><A HREF="https://b.com">B</A></DL></DL>`;
    const { bookmarks } = parseBookmarksHtml(html);
    expect(bookmarks.map((b) => b.folderPath)).toEqual([[], ['Real']]);
  });
});

describe('parseBookmarksHtmlAsync', () => {
  it('gives the same result as the synchronous parser', async () => {
    const html = bigExport(5, 300);
    await expect(parseBookmarksHtmlAsync(html)).resolves.toEqual(parseBookmarksHtml(html));
  });

  it('yields between slices and reports progress on a large export', async () => {
    const html = bigExport(40, 500);
    const progress: number[] = [];

    const result = await parseBookmarksHtmlAsync(html, { sliceMs: 0, onProgress: (n) => progress.push(n) });

    expect(result.bookmarks).toHaveLength(20000);
    expect(result.bookmarks[19999].folderPath).toEqual(['Folder 39']);
    expect(progress.length).toBeGreaterThan(10);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('stops when cancelled', async () => {
    let calls = 0;
    await expect(
      parseBookmarksHtmlAsync(bigExport(10, 500), {
        sliceMs: 0,
        isCancelled: () => {
          calls += 1;
          return calls > 2;
        },
      }),
    ).rejects.toBeInstanceOf(BookmarkParseCancelled);
  });
});
