import fs from 'fs';
import path from 'path';

export type GuidedInterviewStepPhase =
  | 'discovery'
  | 'delivery'
  | 'delivery-choice'
  | 'technical'
  | 'technical-choice'
  | 'complete';

export interface GuidedInterviewMessage {
  role: string;
  text: string;
}

export interface GuidedInterviewTurn {
  phase: GuidedInterviewStepPhase;
  question: number | null;
  total: number | null;
  topic: string;
  /** Marker used when the answer is sufficient and the interview moves on. */
  marker: string;
  /**
   * Marker for the one allowed follow-up on the topic just answered.
   * Absent once that follow-up has been asked, and absent for the optional
   * deeper Technical questions.
   */
  followUpMarker?: string;
  instruction: string;
}

const DISCOVERY_TOPICS = [
  'Problem and who has it',
  'What success looks like',
  'Who uses it and what they can do',
  'What is in scope and what is out',
  'Main scenarios and obvious exceptions',
  'Acceptance criteria in plain language',
] as const;

const DELIVERY_TOPICS = [
  'Who can do each action',
  'What a blocked user sees',
  'Sensitive information and what must be hidden',
  'Done for release 1 versus later',
  'Follow-on outputs: prototype, test cases, and design doc',
] as const;

const TECHNICAL_TOPICS = [
  'Surface: frontend, backend, or both',
  'Existing pattern to follow, extend, or replace',
  'Data model and existing storage to extend',
  'Performance bounds',
  'Rollout and feature-flag behavior',
] as const;

const MARKER_RE =
  /\[\[interview-phase:(discovery|delivery|technical):(done|stopped|skipped|wrapup|\d+)(?::(\d+))?(?::(followup))?\]\]/g;

const DEEPER_TECHNICAL_QUESTIONS = 3;
const DEEPER_TECHNICAL_TOTAL = TECHNICAL_TOPICS.length + DEEPER_TECHNICAL_QUESTIONS;

function numberedTurn(
  phase: 'discovery' | 'delivery' | 'technical',
  question: number,
): GuidedInterviewTurn {
  const topics =
    phase === 'discovery'
      ? DISCOVERY_TOPICS
      : phase === 'delivery'
        ? DELIVERY_TOPICS
        : TECHNICAL_TOPICS;
  const deeper = phase === 'technical' && question > TECHNICAL_TOPICS.length;
  const total = deeper ? DEEPER_TECHNICAL_TOTAL : topics.length;
  const topic =
    topics[question - 1] ??
    'The highest-impact technical decision still unresolved';
  const marker = `[[interview-phase:${phase}:${question}:${total}]]`;
  const instruction = phase === 'technical'
    ? deeper
      ? `Ask exactly one question about: ${topic}. Pick a decision that changes how the feature is built, not an edge-case state rule. Implementation detail is allowed in this phase.`
      : `Ask exactly one question about: ${topic}. Implementation detail is allowed in this phase.`
    : `Ask exactly one question about: ${topic}. Write it for a Business Analyst or Product Owner. Describe what a person can see and do, including what belongs in the first release versus later. Do not describe how it is built.`;
  return {
    phase,
    question,
    total,
    topic,
    marker,
    instruction,
  };
}

function deliveryChoiceTurn(): GuidedInterviewTurn {
  return {
    phase: 'delivery-choice',
    question: null,
    total: null,
    topic: 'Choose Technical or Generate PRD',
    marker: '[[interview-phase:delivery:done]]',
    instruction:
      'Briefly recap Discovery and Delivery, then ask only this choice: a. Continue to technical decisions; b. Generate the PRD.',
  };
}

function technicalWrapUpTurn(): GuidedInterviewTurn {
  return {
    phase: 'technical-choice',
    question: null,
    total: null,
    topic: 'Finish Technical or go deeper',
    marker: '[[interview-phase:technical:wrapup]]',
    instruction: [
      'Briefly recap the Technical decisions.',
      'Then list, in one short bulleted section titled "Left for the design doc", any edge cases or state rules you noticed but did not ask about.',
      `Then ask only this choice: a. Finish Technical; b. Go deeper (up to ${DEEPER_TECHNICAL_QUESTIONS} more questions).`,
    ].join(' '),
  };
}

function technicalDoneTurn(): GuidedInterviewTurn {
  return completedTurn(
    '[[interview-phase:technical:done]]',
    'Write the transcript. Record every edge case not asked about under Unresolved items as "decide in design doc". Tell the person they can generate the PRD.',
  );
}

function completedTurn(marker: string, instruction: string): GuidedInterviewTurn {
  return {
    phase: 'complete',
    question: null,
    total: null,
    topic: 'Close the interview',
    marker,
    instruction,
  };
}

function lastMarker(messages: GuidedInterviewMessage[]): {
  phase: 'discovery' | 'delivery' | 'technical';
  token: string;
  total: number | null;
  followUp: boolean;
} | null {
  let result: {
    phase: 'discovery' | 'delivery' | 'technical';
    token: string;
    total: number | null;
    followUp: boolean;
  } | null = null;
  for (const message of messages) {
    if (message.role !== 'agent') continue;
    for (const match of message.text.matchAll(MARKER_RE)) {
      result = {
        phase: match[1] as 'discovery' | 'delivery' | 'technical',
        token: match[2],
        total: match[3] ? Number(match[3]) : null,
        followUp: match[4] === 'followup',
      };
    }
  }
  return result;
}

function withOptionalFollowUp(
  current: GuidedInterviewTurn,
  advance: GuidedInterviewTurn,
): GuidedInterviewTurn {
  const followUpMarker = `${current.marker.slice(0, -2)}:followup]]`;
  return {
    ...advance,
    phase: current.phase,
    instruction: [
      `The person just answered topic ${current.question} of ${current.total}: ${current.topic}.`,
      'If that answer is clear enough to record, move on and do not add a follow-up.',
      advance.instruction,
      'If it is unclear, contradictory, or reveals an important exception, ask one follow-up about this same topic and nothing else.',
      'A topic gets at most one follow-up. Do not ask a follow-up when the answer is already sufficient.',
    ].join(' '),
    followUpMarker,
  };
}

function choseTechnical(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (/^(a|option a)\b/.test(normalized)) return true;
  return normalized.includes('continue') && normalized.includes('technical');
}

function wantsPrd(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    /^(b|option b)\b/.test(normalized) ||
    normalized.includes('generate prd') ||
    normalized.includes('generate the prd')
  );
}

function wantsDeeperTechnical(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return /^(b|option b)\b/.test(normalized) || normalized.includes('deeper');
}

function wantsToFinishTechnical(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    /^(a|option a)\b/.test(normalized) ||
    normalized.includes('finish') ||
    wantsPrd(text)
  );
}

function wantsToStop(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'done' ||
    normalized.includes('stop the interview') ||
    normalized.includes('finish the interview')
  );
}

/**
 * Selects the turn the model may produce. The latest valid marker is the
 * durable record of the topic that was asked. Each numbered topic allows one
 * follow-up, then the next topic. Technical ends at a wrap-up choice after its
 * fixed topics; choosing to go deeper allows a few more questions, then ends.
 */
export function deriveGuidedInterviewTurn(
  messagesBeforeCurrentUser: GuidedInterviewMessage[],
  currentUserText: string,
): GuidedInterviewTurn {
  const marker = lastMarker(messagesBeforeCurrentUser);
  if (!marker) return numberedTurn('discovery', 1);

  if (wantsToStop(currentUserText)) {
    const stoppedPhase =
      marker.phase === 'technical' ? 'technical' : marker.phase;
    return completedTurn(
      `[[interview-phase:${stoppedPhase}:stopped]]`,
      'Mark all remaining topics unresolved, write the transcript, and tell the person they can generate the PRD.',
    );
  }

  if (marker.token === 'stopped' || marker.token === 'skipped') {
    return completedTurn(
      `[[interview-phase:${marker.phase}:${marker.token}]]`,
      'The interview is closed. Do not ask another question.',
    );
  }
  if (marker.phase === 'technical' && marker.token === 'done') {
    return completedTurn(
      '[[interview-phase:technical:done]]',
      'Write the transcript and tell the person they can generate the PRD.',
    );
  }
  if (marker.phase === 'technical' && marker.token === 'wrapup') {
    if (wantsDeeperTechnical(currentUserText)) {
      return numberedTurn('technical', TECHNICAL_TOPICS.length + 1);
    }
    if (wantsToFinishTechnical(currentUserText)) return technicalDoneTurn();
    return technicalWrapUpTurn();
  }
  if (marker.phase === 'delivery' && marker.token === 'done') {
    if (choseTechnical(currentUserText)) return numberedTurn('technical', 1);
    if (wantsPrd(currentUserText)) {
      return completedTurn(
        '[[interview-phase:technical:skipped]]',
        'Leave Technical as unresolved, write the transcript, and tell the person to use Generate PRD.',
      );
    }
    return deliveryChoiceTurn();
  }

  const question = Number(marker.token);
  if (!Number.isInteger(question)) return numberedTurn('discovery', 1);

  if (marker.phase === 'technical') {
    if (marker.total === DEEPER_TECHNICAL_TOTAL) {
      return question < DEEPER_TECHNICAL_TOTAL
        ? numberedTurn('technical', question + 1)
        : technicalDoneTurn();
    }
    // Older open-ended interviews have no total; past the fixed topics they wrap up.
    if (question > TECHNICAL_TOPICS.length) return technicalWrapUpTurn();
  }

  const advance = marker.phase === 'discovery'
    ? (question < DISCOVERY_TOPICS.length
      ? numberedTurn('discovery', question + 1)
      : numberedTurn('delivery', 1))
    : marker.phase === 'delivery'
      ? (question < DELIVERY_TOPICS.length
        ? numberedTurn('delivery', question + 1)
        : deliveryChoiceTurn())
      : question < TECHNICAL_TOPICS.length
        ? numberedTurn('technical', question + 1)
        : technicalWrapUpTurn();

  if (!marker.followUp) {
    return withOptionalFollowUp(numberedTurn(marker.phase, question), advance);
  }
  return advance;
}

function transcriptExcerpt(messages: GuidedInterviewMessage[]): string {
  const relevant = messages.filter(
    (message) => message.role === 'user' || message.role === 'agent',
  );
  const parts = relevant.map((message) => {
    const text =
      message.text.length > 2_500
        ? `${message.text.slice(0, 2_500).trimEnd()}\n[message truncated]`
        : message.text;
    return `### ${message.role === 'agent' ? 'Interviewer' : 'Person'}\n${text}`;
  });
  let excerpt = parts.join('\n\n');
  if (excerpt.length > 20_000) {
    excerpt = `[Earlier messages omitted]\n\n${excerpt.slice(-20_000)}`;
  }
  return excerpt || 'No prior Q&A. The current user message describes the feature.';
}

export function buildGuidedInterviewTurnPrompt(
  messagesBeforeCurrentUser: GuidedInterviewMessage[],
  currentUserPrompt: string,
  turn: GuidedInterviewTurn,
): string {
  return [
    '# Server-controlled interview turn',
    '',
    `Phase: ${turn.phase}`,
    `Topic: ${turn.topic}`,
    turn.followUpMarker
      ? `First line when the answer is sufficient: ${turn.marker}`
      : `Required first line: ${turn.marker}`,
    ...(turn.followUpMarker
      ? [`First line when one follow-up is needed: ${turn.followUpMarker}`]
      : []),
    '',
    turn.instruction,
    'Ask exactly one question and then stop.',
    ...(turn.phase === 'technical'
      ? []
      : [
          'This turn is for a Business Analyst or Product Owner.',
          'Use the words a person would use for what they can see and do.',
          'Do not mention persistence, CRUD, databases, APIs, schemas, MCP, skills, agent context, routes, components, endpoints, or permission keys.',
          'Use product names such as Home, My Work, and Work Board.',
          'Each option is one short plain sentence, without markdown bold.',
        ]),
    'Do not combine topics, add quick clarifications, preview later questions, or renumber the topic.',
    'Do not reopen a decision already recorded below.',
    'The Q&A below is authoritative. Never claim that prior context or choices are missing.',
    turn.followUpMarker
      ? 'Use exactly one of the two first lines above. The server and interview UI use it to record the turn.'
      : 'Use the exact required first line. The server and interview UI use it to advance the state.',
    '',
    '# Prior interview Q&A',
    '',
    transcriptExcerpt(messagesBeforeCurrentUser),
    '',
    '# Current user message',
    '',
    currentUserPrompt,
  ].join('\n');
}

export function normalizeGuidedInterviewResponse(
  text: string,
  turn: GuidedInterviewTurn,
): string {
  const withoutMarkers = text
    .replace(
      /\[\[interview-phase:(?:discovery|delivery|technical):(?:done|stopped|skipped|wrapup|\d+)(?::\d+)?(?::followup)?\]\][ \t]*\n?/g,
      '',
    )
    .trimStart();
  const marker = turn.followUpMarker && text.includes(turn.followUpMarker)
    ? turn.followUpMarker
    : turn.marker;
  return `${marker}\n\n${withoutMarkers}`;
}

export function writeGuidedInterviewState(
  workspaceDir: string,
  turn: GuidedInterviewTurn,
): void {
  const statePath = path.join(
    workspaceDir,
    '.ai-pilot',
    'guided-interview-state.json',
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        phase: turn.phase,
        question: turn.question,
        total: turn.total,
        topic: turn.topic,
        expectedMarker: turn.marker,
        followUpMarker: turn.followUpMarker ?? null,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}
