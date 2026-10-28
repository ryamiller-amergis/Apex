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
      existingPersonalCount={0}
      existingProjectCount={0}
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

    expect(await screen.findByTestId('bookmark-import-file-error')).toHaveTextContent('larger than 5 MB');
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
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('3 of 3 selected · 2 skipped (not http or https)');
    expect(screen.getByTestId('bookmark-import-confirm')).toHaveTextContent('Import 3 links');
  });

  it('renders bookmark titles as text, not HTML', async () => {
    const { container } = render(
      <BookmarkImportModal
        project="MaxView"
        canShare={false}
        existingPersonalCount={0}
        existingProjectCount={0}
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
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('1 of 3 selected');

    fireEvent.click(screen.getByTestId('bookmark-import-item-bm-1'));
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('2 of 3 selected');
    expect(screen.getByTestId('bookmark-import-folder-toggle-1')).toHaveAttribute('aria-checked', 'mixed');

    fireEvent.click(screen.getByTestId('bookmark-import-select-all'));
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('3 of 3 selected');
    fireEvent.click(screen.getByTestId('bookmark-import-select-all'));
    expect(screen.getByTestId('bookmark-import-summary')).toHaveTextContent('0 of 3 selected');
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

  it('warns when the selection is larger than the room left', async () => {
    renderModal({ existingPersonalCount: 199 });
    await upload();
    expect(screen.getByTestId('bookmark-import-cap-warning')).toHaveTextContent('room for 1 more');
  });

  it('hides the Save to choice without quick-links:manage', () => {
    renderModal();
    expect(screen.queryByTestId('bookmark-import-scope')).not.toBeInTheDocument();
  });

  it('lets managers import into the shared project links', async () => {
    const { onImported } = renderModal({ canShare: true, projectCategories: ['Tools'], existingProjectCount: 199 });
    expect(screen.getByTestId('bookmark-import-scope-personal')).toBeChecked();
    fireEvent.click(screen.getByTestId('bookmark-import-scope-project'));
    await upload();

    expect(screen.getByTestId('bookmark-import-cap-warning')).toHaveTextContent('room for 1 more shared links');
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
