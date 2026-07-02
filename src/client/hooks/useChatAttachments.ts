import { useCallback, useMemo, useState } from 'react';
import type { ChatAttachment } from '../../shared/types/chat';

export const MAX_CHAT_ATTACHMENTS = 5;
export const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 4 * 1024 * 1024;

function makeAttachmentId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useChatAttachments() {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const totalAttachmentBytes = useMemo(
    () => attachments.reduce((sum, attachment) => sum + attachment.size, 0),
    [attachments],
  );

  const addFiles = useCallback(async (fileList: FileList | File[] | null) => {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    const remainingSlots = MAX_CHAT_ATTACHMENTS - attachments.length;
    if (remainingSlots <= 0) {
      setAttachmentError(`You can attach up to ${MAX_CHAT_ATTACHMENTS} files.`);
      return;
    }

    const selectedFiles = files.slice(0, remainingSlots);
    const nextAttachments: ChatAttachment[] = [];
    let nextTotalBytes = totalAttachmentBytes;
    let error: string | null = files.length > remainingSlots
      ? `Only ${remainingSlots} more file${remainingSlots === 1 ? '' : 's'} can be attached.`
      : null;

    for (const file of selectedFiles) {
      if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
        error = `${file.name} is larger than ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_BYTES)}.`;
        continue;
      }

      if (nextTotalBytes + file.size > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
        error = `Attachments can total up to ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_TOTAL_BYTES)}.`;
        continue;
      }

      const isImage = file.type.startsWith('image/');
      const isBinary = isImage || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || file.name.toLowerCase().endsWith('.docx');
      let content: string;
      let encoding: 'base64' | undefined;

      if (isBinary) {
        content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            resolve(dataUrl.split(',')[1]);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        encoding = 'base64';
      } else {
        content = await file.text();
      }

      nextAttachments.push({
        id: makeAttachmentId(),
        name: file.name,
        type: file.type || 'text/plain',
        size: file.size,
        content,
        encoding,
      });
      nextTotalBytes += file.size;
    }

    if (nextAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...nextAttachments]);
    }
    setAttachmentError(error);
  }, [attachments.length, totalAttachmentBytes]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
    setAttachmentError(null);
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
    setAttachmentError(null);
  }, []);

  return {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  };
}
