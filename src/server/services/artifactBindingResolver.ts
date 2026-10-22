/**
 * Canonical artifact hashes for human workflow evaluation.
 * The version tag lets a later canonical form coexist with stored hashes.
 */
import { createHash } from 'crypto';
import type { WorkflowEvaluationSubjectType } from '../../shared/types/workflowEvaluation';
import { WorkflowEvaluationError } from './workflowEvaluationError';

const ARTIFACT_HASH_TAG = 'apex-eval-artifact/v1';

export type LinkedContextIds = {
  adrIds: readonly string[];
  designModuleIds: readonly string[];
};

export type PhaseTranscriptMessage = {
  role: string;
  text: string;
};

export type ArtifactBinding = {
  project: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  phaseIndex: number | null;
  artifactHash: string;
  lineage: {
    skillPath: string | null;
    skillVersion: string | null;
    model: string | null;
    interviewId: string | null;
    prdId: string | null;
  };
  /** Live PRD markdown when the subject is a ready PRD. The client cannot supply this. */
  prdMarkdown: string | null;
};

/** Sorted keys, stable arrays, no whitespace. `undefined` and `null` both become `null`. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item === undefined ? null : item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`).join(',')}}`;
  }
  return 'null';
}

function sha256Parts(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}

export function hashPrdArtifact(markdown: string, backlog: unknown): string {
  return sha256Parts([
    ARTIFACT_HASH_TAG,
    'prd',
    markdown ?? '',
    canonicalJson(backlog === undefined ? null : backlog),
  ]);
}

export type DesignDocArtifactParts = {
  designContent: string;
  techSpecContent: string;
  assumptionsContent: string;
};

export function hashDesignDocArtifact(parts: DesignDocArtifactParts): string {
  return sha256Parts([
    ARTIFACT_HASH_TAG,
    'design_doc',
    parts.designContent ?? '',
    parts.techSpecContent ?? '',
    parts.assumptionsContent ?? '',
  ]);
}

export type TestCaseArtifactParts = {
  testCasesMd: string | null;
  testCasesJson: unknown;
};

export function hashTestCasesArtifact(parts: TestCaseArtifactParts): string {
  return sha256Parts([
    ARTIFACT_HASH_TAG,
    'test_cases',
    parts.testCasesMd ?? '',
    canonicalJson(parts.testCasesJson === undefined ? null : parts.testCasesJson),
  ]);
}

/** The markdown handoff when there is one; otherwise the JSON suite, so older records still evaluate. */
export function renderTestCasesMarkdown(parts: TestCaseArtifactParts): string {
  if (parts.testCasesMd?.trim()) return parts.testCasesMd;
  if (parts.testCasesJson === null || parts.testCasesJson === undefined) return '';
  return `# Test Cases\n\n\`\`\`json\n${JSON.stringify(parts.testCasesJson, null, 2)}\n\`\`\`\n`;
}

export function hashInterviewPhaseArtifact(
  messages: readonly PhaseTranscriptMessage[],
  linked: LinkedContextIds,
): string {
  const slice = messages.map((message) => ({ role: message.role, text: message.text }));
  const ids = {
    adrIds: [...linked.adrIds].sort(),
    designModuleIds: [...linked.designModuleIds].sort(),
  };
  return sha256Parts([
    ARTIFACT_HASH_TAG,
    'interview_phase',
    canonicalJson(slice),
    canonicalJson(ids),
  ]);
}

export async function resolveCurrentArtifactBinding(input: {
  project: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  phaseIndex: number | null;
}): Promise<ArtifactBinding> {
  if (input.subjectType === 'prd') {
    const { getPrdEvaluationInputs } = await import('./prdService');
    const prd = await getPrdEvaluationInputs(input.subjectId);
    if (!prd || prd.project !== input.project) {
      throw new WorkflowEvaluationError('SUBJECT_NOT_FOUND', 'Subject was not found in this project.');
    }
    if (!prd.content.trim()) {
      throw new WorkflowEvaluationError('ARTIFACT_NOT_READY', 'The PRD has no content yet.');
    }
    return {
      project: prd.project,
      subjectType: 'prd',
      subjectId: prd.id,
      phaseIndex: null,
      artifactHash: hashPrdArtifact(prd.content, prd.backlogJson),
      lineage: {
        skillPath: prd.skillPath,
        skillVersion: prd.skillVersion,
        model: prd.model,
        interviewId: prd.interviewId,
        prdId: prd.id,
      },
      prdMarkdown: prd.content,
    };
  }

  if (input.subjectType === 'design_doc') {
    const { getDesignDocEvaluationInputs } = await import('./designDocService');
    const doc = await getDesignDocEvaluationInputs(input.subjectId);
    if (!doc || doc.project !== input.project) {
      throw new WorkflowEvaluationError('SUBJECT_NOT_FOUND', 'Subject was not found in this project.');
    }
    if (!doc.designContent.trim() && !doc.techSpecContent.trim()) {
      throw new WorkflowEvaluationError('ARTIFACT_NOT_READY', 'The design doc has no content yet.');
    }
    return {
      project: doc.project,
      subjectType: 'design_doc',
      subjectId: doc.id,
      phaseIndex: null,
      artifactHash: hashDesignDocArtifact(doc),
      lineage: {
        skillPath: doc.skillPath,
        skillVersion: doc.skillVersion,
        model: doc.model,
        interviewId: doc.interviewId,
        prdId: doc.prdId,
      },
      prdMarkdown: null,
    };
  }

  if (input.subjectType === 'test_cases') {
    const { getTestCaseEvaluationInputs } = await import('./testCaseService');
    const record = await getTestCaseEvaluationInputs(input.subjectId);
    if (!record || record.project !== input.project) {
      throw new WorkflowEvaluationError('SUBJECT_NOT_FOUND', 'Subject was not found in this project.');
    }
    if (record.status !== 'ready' || !renderTestCasesMarkdown(record).trim()) {
      throw new WorkflowEvaluationError('ARTIFACT_NOT_READY', 'The test cases are not ready yet.');
    }
    return {
      project: record.project,
      subjectType: 'test_cases',
      subjectId: record.id,
      phaseIndex: null,
      artifactHash: hashTestCasesArtifact(record),
      lineage: {
        skillPath: record.skillPath,
        skillVersion: record.skillVersion,
        model: record.model,
        interviewId: record.interviewId,
        prdId: record.prdId,
      },
      prdMarkdown: null,
    };
  }

  const { getInterviewEvaluationInputs } = await import('./interviewService');
  const interview = await getInterviewEvaluationInputs(input.subjectId);
  if (!interview || interview.project !== input.project) {
    throw new WorkflowEvaluationError('SUBJECT_NOT_FOUND', 'Subject was not found in this project.');
  }
  const phase = interview.phases.find((item) => item.phaseIndex === input.phaseIndex);
  if (!phase || phase.messages.length === 0) {
    throw new WorkflowEvaluationError('PHASE_NOT_STARTED', 'That interview phase has not started.');
  }
  return {
    project: interview.project,
    subjectType: 'interview_phase',
    subjectId: interview.id,
    phaseIndex: phase.phaseIndex,
    artifactHash: hashInterviewPhaseArtifact(phase.messages, interview.linkedContextIds),
    lineage: {
      skillPath: interview.skillPath,
      skillVersion: interview.skillVersion,
      model: interview.model,
      interviewId: interview.id,
      prdId: null,
    },
    prdMarkdown: null,
  };
}
