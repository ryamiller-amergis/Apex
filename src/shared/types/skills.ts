export interface AdoProject {
  id: string;
  name: string;
  description?: string;
}

export interface AdoRepo {
  id: string;
  name: string;
  defaultBranch: string;
  webUrl: string;
  project: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface SkillEntry {
  /** Stable identifier: "{project}/{repo}/{path}" */
  id: string;
  name: string;
  description: string;
  project: string;
  repo: string;
  path: string;
  branch: string;
  frontmatter: SkillFrontmatter;
}

export interface SkillDetail extends SkillEntry {
  content: string;
  /** Sibling files in the same folder (e.g. PRD-FORMAT.md, examples/) */
  supportingFiles: SupportingFile[];
}

export interface SupportingFile {
  path: string;
  name: string;
  /** True when this entry was added from the skill's apex-skill.json `managedFoundationFiles` list. */
  isFoundationDep?: boolean;
}

export interface WikiInfo {
  id: string;
  name: string;
  type: 'projectWiki' | 'codeWiki';
  project: string;
  mappedPath?: string;
  remoteUrl?: string;
}

export interface WikiPage {
  id?: number;
  path: string;
  content: string;
  gitItemPath?: string;
  url?: string;
  remoteUrl?: string;
  order?: number;
  isParentPage?: boolean;
  subPages?: WikiPage[];
}

export interface SaveWikiPageRequest {
  project: string;
  wikiId: string;
  path: string;
  content: string;
  comment?: string;
  version?: string;
}

export interface SaveWikiPageResult {
  path: string;
  url: string;
  version: string;
}
