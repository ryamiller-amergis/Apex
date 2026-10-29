import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { BookmarkImportModal } from '../BookmarkImportModal';
import { BOOKMARK_IMPORT_MAX_FILE_BYTES } from '../../../shared/types/projectQuickLinks';

const importMutate = jest.fn();
const importSharedMutate = jest.fn();

jest.mock('../../hooks/useProjectQuickLinks', () => ({
  useImportMyQuickLinks: () => ({ mutate: importMutate, isPending: false, error: null }),
  useImportProjectQuickLinks: () => ({ mutate: importSharedMutate, isPending: false, error: null }),
}));

const EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3>Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://maxview.example.com/">MaxView Prod</A>
    <DT><H3>Tools</H3>
    <DL><p>
      <DT><A HREF="https://dashboard.clerk.com/">Clerk</A>
      <DT><A HREF="https://app.pendo.io/">Pendo &lt;img src=x onerror=alert(1)&gt;</A>
      <DT><A HREF="chrome://settings/">Settings</A>
    </DL><p>
  </DL><p>
  <DT><A HREF="javascript:void(0)">Bookmarklet</A>
</DL><p>`;

if (!File.prototype.text) {
  // jsdom 20 has no Blob.text(); browsers do.
  File.prototype.text = function text(this: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

function urls(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `https://existing-${i}.example.com/`);
}

function bigExport(total: number): string {
  const rows = Array.from({ length: total }, (_, i) => `<DT><A HREF="https://big-${i}.example.com/">Big ${i}</A>`);
  return `<DL><p><DT><H3>Huge</H3><DL><p>${rows.join('\n')}</DL><p><DT><H3>Small</H3><DL><p><DT><A HREF="https://small.example.com/">Small</A></DL><p></DL>`;
}

function bookmarkFile(content = EXPORT, name = 'bookmarks.html') {
  return new File([content], name, { type: 'text/html' });
}

async function upload(file: File = bookmarkFile()) {
  fireEvent.change(screen.getByTestId('bookmark-import-file'), { target: { files: [file] } });
  await screen.findByTestId('bookmark-import-tree');
}

function renderModal(props: Partial<ComponentProps<typeof BookmarkImportModal>> = {}) {
  const onImported = jest.fn();
  const onCancel = jest.fn();
  render(
    <BookmarkImportModal
      project="MaxView"
      canShare={false}
      existingPersonalUrls={[]}
      existingProjectUrls={[]}
      personalCategories={[]}
      projectCategories={[]}
      onCancel={onCancel}
      onImported={onImported}
      {...props}
    />,
  );
  return { onImported, onCancel };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BookmarkImportModal', () => {
  it('explains how to export bookmarks from Chrome', () => {
    renderModal();
    expect(screen.getByTestId('bookmark-import-instructions')).toHaveTextContent('Export bookmarks');
    expect(screen.getByTestId('bookmark-import-confirm')).toBeDisabled();
  });

  it('rejects files over the size limit', async () => {
    renderModal();
    const file = bookmarkFile();
    Object.defineProperty(file, 'size', { value: BOOKMARK_IMPORT_MAX_FILE_BYTES + 1 });

    fireEvent.change(screen.getByTestId('bookmark-import-file'), { target: { files: [file] } });

    expect(await screen.findByTestId('bookmark-import-file-error')).toHaveTextContent('larger than 20 MB');
    expect(screen.queryByTestId('bookmark-import-tree')).not.toBeInTheDocument();
  });

  it('reports a file with no usable bookmarks', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('bookmark-import-file'), {
      target: { files: [bookmarkFile('<DL><DT><A HREF="chrome://x">x</A></DL>')] },
    });
    expect(await screen.findByTestId('bookmark-import-file-error')).toHaveTextContent('No http or https bookmarks');
  });

  it('previews bookmarks by folder, all selected, with skipped links counted', async () => {
    renderModal();
    await upload();

    expect(screen.getByTestId('bookmark-import-folder-0')).toHaveTextContent('Bookmarks bar');
    expect(screen.getByTestId('bookmark-import-folder-1')).toHaveTextContent('Bookmarks bar / Tools');
    expect(screen.getByTestId('bookmark-import-category-1-new')).toHaveValue('Tools');
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('3 selected of 3 · 2 skipped (not http or https)');
    expect(screen.getByTestId('bookmark-import-confirm')).toHaveTextContent('Import 3 links');
  });

  it('renders bookmark titles as text, not HTML', async () => {
    const { container } = render(
      <BookmarkImportModal
        project="MaxView"
        canShare={false}
        existingPersonalUrls={[]}
        existingProjectUrls={[]}
        personalCategories={[]}
        projectCategories={[]}
        onCancel={jest.fn()}
        onImported={jest.fn()}
      />,
    );
    await upload();
    expect(screen.getByText('Pendo <img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('toggles a folder, single bookmarks, and select all', async () => {
    renderModal();
    await upload();

    fireEvent.click(screen.getByTestId('bookmark-import-folder-toggle-1'));
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('1 selected of 3');

    fireEvent.click(screen.getByTestId('bookmark-import-item-bm-1'));
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('2 selected of 3');
    expect(screen.getByTestId('bookmark-import-folder-toggle-1')).toHaveAttribute('aria-checked', 'mixed');

    fireEvent.click(screen.getByTestId('bookmark-import-select-all'));
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('3 selected of 3');
    fireEvent.click(screen.getByTestId('bookmark-import-select-all'));
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('0 selected of 3');
    expect(screen.getByTestId('bookmark-import-confirm')).toBeDisabled();
  });

  it('filters the preview by search text', async () => {
    renderModal();
    await upload();

    fireEvent.change(screen.getByTestId('bookmark-import-search'), { target: { value: 'clerk' } });

    expect(screen.queryByTestId('bookmark-import-folder-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('bookmark-import-item-bm-1')).toBeInTheDocument();
    expect(screen.queryByTestId('bookmark-import-item-bm-2')).not.toBeInTheDocument();
  });

  it('imports the selected bookmarks with folder categories and reports the result', async () => {
    const { onImported } = renderModal();
    await upload();
    fireEvent.change(screen.getByTestId('bookmark-import-category-1-new'), { target: { value: 'Dev tools' } });
    fireEvent.change(screen.getByTestId('bookmark-import-category-0-new'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('bookmark-import-item-bm-2'));

    fireEvent.click(screen.getByTestId('bookmark-import-confirm'));

    expect(importMutate).toHaveBeenCalledWith(
      {
        items: [
          { label: 'MaxView Prod', url: 'https://maxview.example.com/', category: null },
          { label: 'Clerk', url: 'https://dashboard.clerk.com/', category: 'Dev tools' },
        ],
      },
      expect.any(Object),
    );

    const result = { created: 2, skippedDuplicates: 0, rejected: [] };
    importMutate.mock.calls[0][1].onSuccess(result);
    expect(onImported).toHaveBeenCalledWith(result, 'personal');
  });

  it('blocks Import until the selection fits the room left', async () => {
    renderModal({ existingPersonalUrls: urls(999) });
    await upload();

    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('0 selected of 3');
    fireEvent.click(screen.getByTestId('bookmark-import-select-all'));

    expect(screen.getByTestId('bookmark-import-cap-warning')).toHaveTextContent(
      'You can add 1 more links in MaxView. Deselect 2 to import (limit 1,000 per project).',
    );
    expect(screen.getByTestId('bookmark-import-confirm')).toBeDisabled();

    fireEvent.click(screen.getByTestId('bookmark-import-item-bm-0'));
    fireEvent.click(screen.getByTestId('bookmark-import-item-bm-1'));
    expect(screen.queryByTestId('bookmark-import-cap-warning')).not.toBeInTheDocument();
    expect(screen.getByTestId('bookmark-import-confirm')).toBeEnabled();
  });

  it('shows already-saved bookmarks but does not let them be selected', async () => {
    renderModal({ existingPersonalUrls: ['https://dashboard.clerk.com/'] });
    await upload();

    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('2 selected of 3 · 1 already saved');
    expect(screen.getByTestId('bookmark-import-item-bm-1')).toBeDisabled();
    expect(screen.getByTestId('bookmark-import-folder-count-1')).toHaveTextContent('1/1');
  });

  it('shows a reading state while it parses', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('bookmark-import-file'), { target: { files: [bookmarkFile()] } });
    expect(screen.getByTestId('bookmark-import-reading')).toHaveTextContent('Reading bookmarks…');
    expect(screen.getByTestId('bookmark-import-file')).toBeDisabled();
    await screen.findByTestId('bookmark-import-tree');
    expect(screen.queryByTestId('bookmark-import-reading')).not.toBeInTheDocument();
  });

  it('collapses folders for large exports and renders rows only when expanded', async () => {
    renderModal();
    await upload(bookmarkFile(bigExport(800)));

    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('801 selected of 801');
    expect(screen.queryByTestId('bookmark-import-item-bm-0')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('bookmark-import-folder-expand-0'));
    expect(screen.getByTestId('bookmark-import-item-bm-0')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid^="bookmark-import-item-"]')).toHaveLength(200);
    expect(screen.queryByTestId('bookmark-import-item-bm-799')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('bookmark-import-folder-show-all-0'));
    expect(screen.getByTestId('bookmark-import-item-bm-799')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('bookmark-import-folder-toggle-0'));
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('1 selected of 801');
  });

  it('starts with nothing selected when the export is bigger than the room left', async () => {
    renderModal();
    await upload(bookmarkFile(bigExport(1200)));
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('0 selected of 1,201');
    expect(screen.getByTestId('bookmark-import-confirm')).toBeDisabled();
  });

  it('hides the Save to choice without quick-links:manage', () => {
    renderModal();
    expect(screen.queryByTestId('bookmark-import-scope')).not.toBeInTheDocument();
  });

  it('lets managers import into the shared project links', async () => {
    const { onImported } = renderModal({ canShare: true, projectCategories: ['Tools'] });
    expect(screen.getByTestId('bookmark-import-scope-personal')).toBeChecked();
    fireEvent.click(screen.getByTestId('bookmark-import-scope-project'));
    await upload();

    expect(screen.getByTestId('bookmark-import-category-1')).toHaveValue('Tools');
    fireEvent.click(screen.getByTestId('bookmark-import-confirm'));

    expect(importMutate).not.toHaveBeenCalled();
    expect(importSharedMutate).toHaveBeenCalledWith(
      { items: expect.arrayContaining([{ label: 'Clerk', url: 'https://dashboard.clerk.com/', category: 'Tools' }]) },
      expect.any(Object),
    );
    const result = { created: 3, skippedDuplicates: 0, rejected: [] };
    importSharedMutate.mock.calls[0][1].onSuccess(result);
    expect(onImported).toHaveBeenCalledWith(result, 'project');
  });

  it('uses the shared cap of 200 when importing into project links', async () => {
    renderModal({ canShare: true, existingProjectUrls: urls(199) });
    fireEvent.click(screen.getByTestId('bookmark-import-scope-project'));
    await upload();
    fireEvent.click(screen.getByTestId('bookmark-import-select-all'));

    expect(screen.getByTestId('bookmark-import-cap-warning')).toHaveTextContent(
      'You can add 1 more shared links in MaxView. Deselect 2 to import (limit 200 per project).',
    );
    expect(screen.getByTestId('bookmark-import-confirm')).toBeDisabled();
  });

  it('offers existing categories in each folder picker', async () => {
    renderModal({ personalCategories: ['Work'], projectCategories: ['Tools'] });
    await upload();
    const picker = screen.getByTestId('bookmark-import-category-1');
    expect(Array.from((picker as HTMLSelectElement).options).map((o) => o.text)).toEqual([
      'No category',
      'Tools',
      'Work',
      '+ New category…',
    ]);
  });

  it('closes on Escape', () => {
    const { onCancel } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
});
