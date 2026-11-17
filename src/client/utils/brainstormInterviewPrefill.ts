import type { BrainstormArtifactType } from '../../shared/types/brainstormArtifact';
import { brainstormLinkTitle } from '../../shared/utils/brainstormArtifactTitle';

export function brainstormInterviewTitle(markdown: string, sessionTitle: string | null): string {
  return brainstormLinkTitle(markdown, sessionTitle);
}

/** A technical design goes to grill-design; anything else keeps the project's interview skill. */
export function brainstormInterviewSkillName(type: BrainstormArtifactType | null): 'grill-design' | null {
  return type === 'technical_design' ? 'grill-design' : null;
}

export function brainstormInterviewOpeningPrompt(title: string): string {
  return `Start from the linked brainstorm "${title}". Confirm what it already settles, then ask about what is still open.`;
}
