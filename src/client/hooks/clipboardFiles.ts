/**
 * Clipboard files for agent composers.
 * Nameless images, the browser default `image.png`, and files with no
 * extension are renamed to `screenshot-<timestamp>-<n>.<ext>`.
 * Text items are left alone so a normal paste still lands in the field.
 */

export function filesFromClipboard(clipboard: DataTransfer | null): File[] {
  if (!clipboard) return [];
  const extracted: File[] = [];
  if (clipboard.items && clipboard.items.length > 0) {
    for (let i = 0; i < clipboard.items.length; i += 1) {
      const item = clipboard.items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) extracted.push(nameClipboardFile(file, i));
      }
    }
  } else if (clipboard.files && clipboard.files.length > 0) {
    extracted.push(...Array.from(clipboard.files));
  }
  return extracted;
}

function nameClipboardFile(file: File, index: number): File {
  const hasExt = /\.[a-z0-9]+$/i.test(file.name);
  const fallbackExt = (file.type.split('/')[1] || 'png').replace(
    /[^a-z0-9]/gi,
    ''
  );
  if (!file.name || file.name === 'image.png' || !hasExt) {
    return new File(
      [file],
      `screenshot-${Date.now()}-${index + 1}.${fallbackExt}`,
      { type: file.type || 'image/png' }
    );
  }
  return file;
}

/** Prevent the paste and hand off files when the clipboard holds any. */
export function applyPastedFiles(
  event: {
    clipboardData: DataTransfer | null;
    defaultPrevented: boolean;
    preventDefault: () => void;
  },
  onPasteFiles: (files: File[]) => void
): void {
  if (event.defaultPrevented) return;
  const extracted = filesFromClipboard(event.clipboardData);
  if (extracted.length === 0) return;
  event.preventDefault();
  onPasteFiles(extracted);
}
