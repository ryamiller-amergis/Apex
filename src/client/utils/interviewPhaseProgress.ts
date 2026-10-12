export type InterviewPhaseId = 'discovery' | 'delivery' | 'technical';

export type InterviewPhaseState = 'current' | 'complete' | 'upcoming' | 'optional' | 'skipped';

export interface InterviewPhaseStep {
  id: InterviewPhaseId;
  label: string;
  state: InterviewPhaseState;
  detail: string;
}

export interface InterviewPhaseProgress {
  steps: InterviewPhaseStep[];
  summary: string;
}

const PHASE_LABEL: Record<InterviewPhaseId, string> = {
  discovery: 'Discovery',
  delivery: 'Delivery',
  technical: 'Technical',
};

const QUESTION_CAP: Record<InterviewPhaseId, number | null> = {
  discovery: 6,
  delivery: 5,
  technical: null,
};

const MARKER_RE = /\[\[interview-phase:(discovery|delivery|technical):(done|stopped|skipped|wrapup|\d+)(?::(\d+))?(?::(followup))?\]\]/g;

export function usesGuidedInterviewPhases(skillPath: string | null | undefined): boolean {
  if (!skillPath) return false;
  return skillPath.replace(/\\/g, '/').toLowerCase().includes('grill-with-docs');
}

/** Remove the phase marker the interview screen reads. Leaves a partial marker out of the bubble while streaming. */
export function stripInterviewPhaseMarkers(text: string): string {
  return text
    .replace(/\[\[interview-phase:[^\]]*\]\][ \t]*\n?/g, '')
    .replace(/\[\[interview-phase:[^\]]*$/g, '')
    .replace(/^\s+/, '');
}

interface PhaseMarker {
  phase: InterviewPhaseId;
  token: 'done' | 'stopped' | 'skipped' | 'wrapup' | number;
  total: number | null;
  followUp: boolean;
}

function parseLastMarker(text: string): PhaseMarker | null {
  let last: PhaseMarker | null = null;
  for (const match of text.matchAll(MARKER_RE)) {
    const phase = match[1] as InterviewPhaseId;
    const raw = match[2];
    if (raw === 'done' || raw === 'stopped' || raw === 'skipped' || raw === 'wrapup') {
      if ((raw === 'skipped' || raw === 'wrapup') && phase !== 'technical') continue;
      last = { phase, token: raw, total: null, followUp: false };
      continue;
    }
    const question = Number(raw);
    const cap = QUESTION_CAP[phase];
    const total = match[3] ? Number(match[3]) : cap;
    if (!Number.isInteger(question) || question < 1) continue;
    if (total != null && (!Number.isInteger(total) || question > total)) continue;
    last = { phase, token: question, total, followUp: match[4] === 'followup' };
  }
  return last;
}

function step(
  id: InterviewPhaseId,
  state: InterviewPhaseState,
  detail: string,
): InterviewPhaseStep {
  return { id, label: PHASE_LABEL[id], state, detail };
}

export function previewInterviewPhaseProgress(): InterviewPhaseProgress {
  return {
    steps: [
      step('discovery', 'upcoming', '6 topics'),
      step('delivery', 'upcoming', '5 topics'),
      step('technical', 'optional', 'Optional, 5 topics'),
    ],
    summary: 'This interview starts in Discovery, continues through Delivery, then offers optional Technical.',
  };
}

function topicsLeft(question: number, total: number, label: string): string {
  const left = total - question + 1;
  const noun = left === 1 ? 'topic' : 'topics';
  return `${left} ${noun} left in ${label}.`;
}

function topicDetail(question: number, total: number | null, followUp: boolean): string {
  const base = total ? `Topic ${question} of ${total}` : `Topic ${question}`;
  return followUp ? `${base} · follow-up` : base;
}

export function deriveInterviewPhaseProgress(texts: string[]): InterviewPhaseProgress {
  const marker = parseLastMarker(texts.filter(Boolean).join('\n'));
  if (!marker) {
    return {
      steps: [
        step('discovery', 'current', 'Starting'),
        step('delivery', 'upcoming', 'Later'),
        step('technical', 'optional', 'Optional'),
      ],
      summary: 'Discovery is first. Delivery follows. Technical is optional.',
    };
  }

  if (marker.token === 'stopped') {
    if (marker.phase === 'discovery') {
      return {
        steps: [
          step('discovery', 'current', 'Ended early'),
          step('delivery', 'skipped', 'Not in this interview'),
          step('technical', 'skipped', 'Not in this interview'),
        ],
        summary: 'Discovery ended early. Delivery and Technical are not part of this interview.',
      };
    }
    return {
      steps: [
        step('discovery', 'complete', 'Done'),
        step('delivery', 'current', 'Ended early'),
        step('technical', 'skipped', 'Not in this interview'),
      ],
      summary: 'Delivery ended early. Technical is not part of this interview.',
    };
  }

  if (marker.phase === 'technical' && marker.token === 'skipped') {
    return {
      steps: [
        step('discovery', 'complete', 'Done'),
        step('delivery', 'complete', 'Done'),
        step('technical', 'skipped', 'Not in this interview'),
      ],
      summary: 'Technical is not part of this interview. A PRD can be generated from Discovery and Delivery.',
    };
  }

  if (marker.phase === 'technical' && marker.token === 'done') {
    return {
      steps: [
        step('discovery', 'complete', 'Done'),
        step('delivery', 'complete', 'Done'),
        step('technical', 'complete', 'Done'),
      ],
      summary: 'Discovery, Delivery, and Technical are complete.',
    };
  }

  if (marker.phase === 'technical' && marker.token === 'wrapup') {
    return {
      steps: [
        step('discovery', 'complete', 'Done'),
        step('delivery', 'complete', 'Done'),
        step('technical', 'current', 'Wrapping up'),
      ],
      summary: 'Technical topics are covered. Finish now, or go deeper with up to 3 more questions.',
    };
  }

  if (marker.phase === 'delivery' && marker.token === 'done') {
    return {
      steps: [
        step('discovery', 'complete', 'Done'),
        step('delivery', 'complete', 'Done'),
        step('technical', 'optional', 'Optional'),
      ],
      summary: 'Delivery is done. Continue to Technical, or generate a PRD.',
    };
  }

  if (marker.phase === 'discovery' && marker.token === 'done') {
    return {
      steps: [
        step('discovery', 'complete', 'Done'),
        step('delivery', 'current', 'Starting'),
        step('technical', 'optional', 'Optional'),
      ],
      summary: 'Discovery is done. Delivery is next.',
    };
  }

  const question = marker.token as number;
  const total = marker.total;
  if (marker.phase === 'discovery') {
    const detail = topicDetail(question, total, marker.followUp);
    return {
      steps: [
        step('discovery', 'current', detail),
        step('delivery', 'upcoming', 'Later'),
        step('technical', 'optional', 'Optional'),
      ],
      summary: total
        ? topicsLeft(question, total, 'Discovery')
        : `Discovery, topic ${question}.`,
    };
  }

  if (marker.phase === 'delivery') {
    const detail = topicDetail(question, total, marker.followUp);
    return {
      steps: [
        step('discovery', 'complete', 'Done'),
        step('delivery', 'current', detail),
        step('technical', 'optional', 'Optional'),
      ],
      summary: total
        ? topicsLeft(question, total, 'Delivery')
        : `Delivery, topic ${question}.`,
    };
  }

  return {
    steps: [
      step('discovery', 'complete', 'Done'),
      step('delivery', 'complete', 'Done'),
      step('technical', 'current', topicDetail(question, total, marker.followUp)),
    ],
    summary: total
      ? topicsLeft(question, total, 'Technical')
      : `Technical, topic ${question}.`,
  };
}
