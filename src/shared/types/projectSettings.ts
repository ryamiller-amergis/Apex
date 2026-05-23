export interface QuickSkillPill {
  label: string;
  skillPath: string;
  model?: string | null;
  /** Plain-English description shown to users when the pill is selected */
  description?: string | null;
}

export interface ProjectSkillConfig {
  project: string;
  skillRepo: string;
  skillBranch: string;
  updatedBy?: string | null;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  designDocSkillPath?: string | null;
  designDocQaSkillPath?: string | null;
  designDocAssistantSkillPath?: string | null;
  designDocValidationSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  designDocModel?: string | null;
  designDocQaModel?: string | null;
  designDocAssistantModel?: string | null;
  designDocValidationModel?: string | null;
  quickSkillPills?: QuickSkillPill[] | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpsertProjectSkillConfigRequest {
  skillRepo: string;
  skillBranch: string;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  designDocSkillPath?: string | null;
  designDocQaSkillPath?: string | null;
  designDocAssistantSkillPath?: string | null;
  designDocValidationSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  designDocModel?: string | null;
  designDocQaModel?: string | null;
  designDocAssistantModel?: string | null;
  designDocValidationModel?: string | null;
  quickSkillPills?: QuickSkillPill[] | null;
}

export interface ProjectSkillConfigResponse {
  project: string;
  skillRepo: string;
  skillBranch: string;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  designDocSkillPath?: string | null;
  designDocQaSkillPath?: string | null;
  designDocAssistantSkillPath?: string | null;
  designDocValidationSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  designDocModel?: string | null;
  designDocQaModel?: string | null;
  designDocAssistantModel?: string | null;
  designDocValidationModel?: string | null;
  quickSkillPills?: QuickSkillPill[] | null;
}
