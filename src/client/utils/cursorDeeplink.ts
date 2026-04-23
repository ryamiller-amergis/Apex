const MAXVIEW_REPO_URL = 'https://dev.azure.com/amergis/_git/MaxView';

export function buildDesignDocKickoffPrompt(adoWorkItemId: number): string {
  return `/design-doc-kickoff ${adoWorkItemId}`;
}

export function buildCursorPromptDeeplink(promptText: string): {
  desktop: string;
  web: string;
} {
  const encoded = encodeURIComponent(promptText);
  return {
    desktop: `cursor://anysphere.cursor-deeplink/prompt?text=${encoded}`,
    web: `https://cursor.com/link/prompt?text=${encoded}`,
  };
}

export function getMaxViewRepoUrl(): string {
  return MAXVIEW_REPO_URL;
}
