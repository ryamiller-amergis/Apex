export interface ProjectSkillConfig {
  project: string;
  skillRepo: string;
  skillBranch: string;
  updatedBy?: string | null;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  designDocSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  designDocModel?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpsertProjectSkillConfigRequest {
  skillRepo: string;
  skillBranch: string;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  designDocSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  designDocModel?: string | null;
}

export interface ProjectSkillConfigResponse {
  project: string;
  skillRepo: string;
  skillBranch: string;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  designDocSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  designDocModel?: string | null;
}
