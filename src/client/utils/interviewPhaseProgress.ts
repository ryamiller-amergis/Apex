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

const MARKER_RE = /\[\[interview-phase:(discovery|delivery|technical):(done|stopped|skipped|\d+)(?::(\d+))?\]\]/g;

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
  token: 'done' | 'stopped' | 'skipped' | number;
  total: number | null;
}

function parseLastMarker(text: string): PhaseMarker | null {
  let last: PhaseMarker | null = null;
  for (const match of text.matchAll(MARKER_RE)) {
    const phase = match[1] as InterviewPhaseId;
    const raw = match[2];
    if (raw === 'done' || raw === 'stopped' || raw === 'skipped') {
      if (raw === 'skipped' && phase !== 'technical') continue;
      last = { phase, token: raw, total: null };
      continue;
    }
    const question = Number(raw);
    const cap = QUESTION_CAP[phase];
    const total = match[3] ? Number(match[3]) : cap;
    if (!Number.isInteger(question) || question < 1) continue;
    if (total != null && (!Number.isInteger(total) || question > total)) continue;
    last = { phase, token: question, total };
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
      step('discovery', 'upcoming', '6 questions'),
      step('delivery', 'upcoming', '5 questions'),
      step('technical', 'optional', 'Optional'),
    ],
    summary: 'This interview starts in Discovery, continues through Delivery, then offers optional Technical.',
  };
}

function questionsLeft(question: number, total: number, label: string): string {
  const left = total - question + 1;
  const noun = left === 1 ? 'question' : 'questions';
  return `${left} ${noun} left in ${label}.`;
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
    const detail = total ? `Question ${question} of ${total}` : `Question ${question}`;
    return {
      steps: [
        step('discovery', 'current', detail),
        step('delivery', 'upcoming', 'Later'),
        step('technical', 'optional', 'Optional'),
      ],
      summary: total
        ? questionsLeft(question, total, 'Discovery')
        : `Discovery, question ${question}.`,
    };
  }

  if (marker.phase === 'delivery') {
    const detail = total ? `Question ${question} of ${total}` : `Question ${question}`;
    return {
      steps: [
        step('discovery', 'complete', 'Done'),
        step('delivery', 'current', detail),
        step('technical', 'optional', 'Optional'),
      ],
      summary: total
        ? questionsLeft(question, total, 'Delivery')
        : `Delivery, question ${question}.`,
    };
  }

  return {
    steps: [
      step('discovery', 'complete', 'Done'),
      step('delivery', 'complete', 'Done'),
      step('technical', 'current', `Question ${question}`),
    ],
    summary: `Technical, question ${question}.`,
  };
}
