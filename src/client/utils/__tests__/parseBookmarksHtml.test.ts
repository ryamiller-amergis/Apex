import { defaultCategoryFor, parseBookmarksHtml } from '../parseBookmarksHtml';

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
