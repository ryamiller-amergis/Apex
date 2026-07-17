import type { FeatureRequest, LinkedAdrSummary, WorkItemType } from '../../shared/types/featureRequest';

export interface FeatureRequestInterviewPrefillAdr {
  id: string;
  title: string;
  slug: string | null;
}

export interface FeatureRequestInterviewPrefill {
  id: string;
  type: WorkItemType;
  title: string;
  request: string;
  advantage: string;
  linkedAdrs: FeatureRequestInterviewPrefillAdr[];
}

export function isInterviewableWorkItemType(type: WorkItemType): boolean {
  return type === 'feature' || type === 'technical';
}

export function toFeatureRequestInterviewPrefill(
  fr: Pick<FeatureRequest, 'id' | 'type' | 'title' | 'request' | 'advantage' | 'linkedAdrs'>,
): FeatureRequestInterviewPrefill {
  return {
    id: fr.id,
    type: fr.type,
    title: fr.title,
    request: fr.request,
    advantage: fr.advantage ?? '',
    linkedAdrs: (fr.linkedAdrs ?? []).map((adr: LinkedAdrSummary) => ({
      id: adr.id,
      title: adr.title,
      slug: adr.slug,
    })),
  };
}

export function buildFeatureRequestInterviewPrefillText(
  featureRequest?: FeatureRequestInterviewPrefill,
): string {
  if (!featureRequest) return '';

  const lines = [
    featureRequest.type === 'technical'
      ? 'This interview originated from a technical work item.'
      : 'This interview originated from a feature request.',
    '',
    featureRequest.request,
  ];

  if (featureRequest.type === 'feature' && featureRequest.advantage.trim()) {
    lines.push('', 'Advantage:', featureRequest.advantage);
  }

  if (featureRequest.linkedAdrs.length > 0) {
    lines.push(
      '',
      'Linked accepted ADRs are attached as markdown files for architectural context:',
      ...featureRequest.linkedAdrs.map((adr) =>
        `- ${adr.title}${adr.slug ? ` (${adr.slug})` : ''}`,
      ),
    );
  }

  return lines.join('\n');
}

export function adrAttachmentFileName(adr: FeatureRequestInterviewPrefillAdr): string {
  const raw = (adr.slug?.trim() || adr.title.trim() || adr.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${raw || adr.id}.md`;
}
