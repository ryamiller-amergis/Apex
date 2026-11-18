import { useCallback, useState } from 'react';
import type { WorkflowEvaluationSubjectType } from '../../shared/types/workflowEvaluation';

function readFlag(storage: () => Storage, key: string): boolean {
  try {
    return storage().getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(storage: () => Storage, key: string): void {
  try {
    storage().setItem(key, '1');
  } catch {
    // Storage can be full or blocked; component state still remembers for this page.
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

export function qualityFeedbackPromptKeys(scope: {
  userId: string;
  project: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
}): { modalSeen: string; bannerDismissed: string } {
  const suffix = `v1:${scope.userId}:${scope.project}:${scope.subjectType}:${scope.subjectId}:${scope.stageKey}`;
  return {
    modalSeen: `apex:quality-feedback:modal-seen:${suffix}`,
    bannerDismissed: `apex:quality-feedback:banner-dismissed:${suffix}`,
  };
}

type FlagSnapshot = { key: string; value: boolean };

/** Reads the flag once per key, so a write made while the modal is open does not close it. */
function useStoredFlag(storage: () => Storage, key: string): [boolean, () => void] {
  const [snapshot, setSnapshot] = useState<FlagSnapshot>(() => ({ key, value: readFlag(storage, key) }));
  let current = snapshot;
  if (snapshot.key !== key) {
    current = { key, value: readFlag(storage, key) };
    setSnapshot(current);
  }
  const set = useCallback(() => {
    writeFlag(storage, key);
    setSnapshot({ key, value: true });
  }, [storage, key]);
  return [current.value, set];
}

/** Modal "seen" lasts per browser (localStorage); banner dismissal lasts for the session. */
export function useQualityFeedbackPromptState(scope: {
  userId: string;
  project: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
}) {
  const keys = qualityFeedbackPromptKeys(scope);
  const [modalSeen, markModalSeen] = useStoredFlag(local, keys.modalSeen);
  const [bannerDismissed, dismissBanner] = useStoredFlag(session, keys.bannerDismissed);

  /** Persists "seen" as soon as the modal renders, without closing it. */
  const recordModalShown = useCallback(() => writeFlag(local, keys.modalSeen), [keys.modalSeen]);

  return { modalSeen, bannerDismissed, markModalSeen, recordModalShown, dismissBanner };
}
