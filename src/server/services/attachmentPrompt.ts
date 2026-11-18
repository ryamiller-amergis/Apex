import type { ChatAttachmentMeta } from '../../shared/types/chat';

export interface DurablePromptAttachment {
  name: string;
  contentType: string;
  sizeBytes: number;
  materializedPath: string;
}

/**
 * Sandbox prompt for a chat turn. Image files get a Read-tool hint so the
 * agent opens the workspace file instead of guessing from the filename.
 */
export function buildPromptWithAttachments(
  text: string,
  attachments: ChatAttachmentMeta[]
): string {
  if (attachments.length === 0) return text;

  const messageText =
    text.trim() || 'Please use the uploaded files as additional context.';
  const attachmentLines = attachments.map((attachment) => {
    const isImage = attachment.type.startsWith('image/');
    const hint = isImage
      ? ' [IMAGE -- use the Read tool to view this file]'
      : '';
    return `- ${attachment.name} (${attachment.type || 'text/plain'}, ${attachment.size} bytes): \`${attachment.path}\`${hint}`;
  });

  return [
    messageText,
    '',
    '# Uploaded context files for this turn',
    'The user attached these files. They have been written into the local sandbox workspace; read them before responding when they are relevant.',
    ...attachmentLines,
  ].join('\n');
}

/**
 * Durable-turn prompt. Same idea as {@link buildPromptWithAttachments}, with
 * the shorter `[IMAGE]` marker used by the durable runner.
 */
export function promptWithAttachments(
  text: string,
  attachments: ReadonlyArray<DurablePromptAttachment>
): string {
  const messageText =
    text.trim() || 'Please use the uploaded files as additional context.';
  if (attachments.length === 0) return messageText;
  return [
    messageText,
    '',
    '# Uploaded context files for this turn',
    'The user attached these files. Read them before responding when relevant.',
    ...attachments.map((attachment) => {
      const imageHint = attachment.contentType.startsWith('image/')
        ? ' [IMAGE]'
        : '';
      return `- ${attachment.name} (${attachment.contentType}, ${attachment.sizeBytes} bytes): \`${attachment.materializedPath}\`${imageHint}`;
    }),
  ].join('\n');
}
