import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  atsBoardDecisionRequestId,
  type AtsBoardDecision,
  type AtsBoardDeliberationSummary,
  type AtsBoardLeadershipAnswer,
  type AtsBoardLeadershipResolution,
  type AtsBoardSynopsis,
} from '../../shared/atsBoard';
import styles from './AtsBoardDecisionReview.module.css';

const answerSchema = z.object({
  resolution: z.enum(['accept_recommendation', 'direct', 'defer']),
  response: z
    .string()
    .trim()
    .min(1, 'Add the decision or follow-up owner and date.')
    .max(2000, 'Keep the response under 2,000 characters.'),
});

type AnswerValues = z.infer<typeof answerSchema>;

interface AtsBoardDecisionReviewProps {
  synopsis: AtsBoardSynopsis;
  onChange: (answers: AtsBoardLeadershipAnswer[]) => void;
  'data-testid'?: string;
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'before',
  'board',
  'choose',
  'decide',
  'decision',
  'from',
  'into',
  'leadership',
  'only',
  'phase',
  'that',
  'their',
  'this',
  'versus',
  'what',
  'when',
  'with',
  'without',
  'your',
]);

interface ReviewChoice {
  id: string;
  title: string;
  detail?: string;
  tradeoff?: string;
  boardLean: boolean;
}

function questionText(request: string): string {
  return request.replace(/^\s*D-[A-Z0-9-]+\s*(?::|—|–)\s*/i, '').trim();
}

function meaningfulTokens(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []).filter(
      (token) => token.length >= 4 && !STOP_WORDS.has(token)
    )
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  let score = 0;
  for (const token of left) {
    if (right.has(token)) score += 1;
  }
  return score;
}

function boardPositionFor(
  synopsis: AtsBoardSynopsis,
  requestId: string,
  question: string
): AtsBoardDecision | null {
  const exact = synopsis.decisions.find(
    (decision) => decision.id.toUpperCase() === requestId
  );
  if (exact) return exact;

  const questionTokens = meaningfulTokens(question);
  let best: AtsBoardDecision | null = null;
  let bestScore = 0;
  for (const decision of synopsis.decisions) {
    const score = overlap(
      questionTokens,
      meaningfulTokens(`${decision.id} ${decision.area} ${decision.decision}`)
    );
    if (score > bestScore) {
      best = decision;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : null;
}

function discussionFor(
  synopsis: AtsBoardSynopsis,
  requestId: string
): AtsBoardDeliberationSummary | null {
  const topic = /^D-(T\d+)/i.exec(requestId)?.[1]?.toUpperCase();
  if (!topic) return null;
  return (
    synopsis.deliberation.find((item) =>
      item.topic.toUpperCase().includes(`${topic} —`)
    ) ?? null
  );
}

function leansToward(choice: string, boardText: string): boolean {
  const lean = boardText.match(/favou?rs?\s+([^.;]+)/i)?.[1] ?? '';
  if (!lean) return false;
  return overlap(meaningfulTokens(choice), meaningfulTokens(lean)) >= 1;
}

function choiceResponse(choice: ReviewChoice): string {
  return [choice.title, choice.detail].filter(Boolean).join(' — ');
}

function reviewChoices(
  synopsis: AtsBoardSynopsis,
  question: string,
  boardText: string
): ReviewChoice[] {
  const questionTokens = meaningfulTokens(question);
  const matchedOptions = synopsis.options
    .map((option) => ({
      option,
      score: overlap(
        questionTokens,
        meaningfulTokens(`${option.title} ${option.description}`)
      ),
    }))
    .filter((item) => item.score >= 3)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ option }) => ({
      id: option.id,
      title: option.title,
      detail: option.description,
      tradeoff: option.tradeoffs[0],
      boardLean: option.recommended || leansToward(option.title, boardText),
    }));
  if (matchedOptions.length >= 2) return matchedOptions;

  const body = question
    .replace(/^(decide|choose|ratify|approve|confirm|name)\s+/i, '')
    .replace(/\.$/, '')
    .trim();
  const parts = body.split(/\s+versus\s+/i);
  if (parts.length !== 2) return matchedOptions;

  const shared = parts[1].match(/\s+for\s+(.+)$/i);
  const rightTitle = shared
    ? parts[1].slice(0, shared.index).trim()
    : parts[1].trim();
  return [parts[0].trim(), rightTitle].filter(Boolean).map((title, index) => {
    const label = title.charAt(0).toUpperCase() + title.slice(1);
    return {
      id: `versus-${index}`,
      title: label,
      detail: shared?.[1]?.replace(/\.$/, '').trim(),
      boardLean: leansToward(label, boardText),
    };
  });
}

export const AtsBoardDecisionReview: React.FC<AtsBoardDecisionReviewProps> = ({
  synopsis,
  onChange,
  'data-testid': dataTestId = 'ats-board-decision-review',
}) => {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AtsBoardLeadershipAnswer[]>([]);
  const [selectedResolution, setSelectedResolution] =
    useState<AtsBoardLeadershipResolution | null>(null);
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [writingCustom, setWritingCustom] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<AnswerValues>({
    resolver: zodResolver(answerSchema),
    defaultValues: { resolution: 'direct', response: '' },
  });

  const request = synopsis.decisionRequests[index];
  if (!request) return null;

  const decisionId = atsBoardDecisionRequestId(request, index);
  const question = questionText(request);
  const boardDecision = boardPositionFor(synopsis, decisionId, question);
  const recommendation = boardDecision?.decision ?? null;
  const canAcceptRecommendation =
    boardDecision?.status === 'Board approved — awaiting leadership';
  const discussion = discussionFor(synopsis, decisionId);
  const choices = reviewChoices(synopsis, question, recommendation ?? '');
  const currentAnswer = answers.find(
    (answer) => answer.decisionId === decisionId
  );
  const isLast = index === synopsis.decisionRequests.length - 1;
  const allAnswered = answers.length === synopsis.decisionRequests.length;

  const storeAnswer = (answer: AtsBoardLeadershipAnswer) => {
    const next = [
      ...answers.filter((item) => item.decisionId !== answer.decisionId),
      answer,
    ];
    setAnswers(next);
    onChange(next);
  };

  const choose = (resolution: AtsBoardLeadershipResolution) => {
    setSelectedChoiceId(null);
    setSelectedResolution(resolution);
    setValue('resolution', resolution);
    if (resolution === 'accept_recommendation') {
      if (!recommendation) return;
      setWritingCustom(false);
      const response = recommendation;
      setValue('response', response);
      storeAnswer({ decisionId, resolution, response });
      return;
    }
    setWritingCustom(true);
    reset({ resolution, response: '' });
  };

  const chooseOption = (choice: ReviewChoice) => {
    const response = choiceResponse(choice);
    setSelectedChoiceId(choice.id);
    setSelectedResolution('direct');
    setWritingCustom(false);
    setValue('resolution', 'direct');
    setValue('response', response);
    storeAnswer({ decisionId, resolution: 'direct', response });
  };

  const save = handleSubmit((values) => {
    storeAnswer({
      decisionId,
      resolution: values.resolution,
      response: values.response.trim(),
    });
  });

  const move = (nextIndex: number) => {
    const bounded = Math.max(
      0,
      Math.min(nextIndex, synopsis.decisionRequests.length - 1)
    );
    setIndex(bounded);
    const nextId = atsBoardDecisionRequestId(
      synopsis.decisionRequests[bounded],
      bounded
    );
    const saved = answers.find((answer) => answer.decisionId === nextId);
    const nextQuestion = questionText(synopsis.decisionRequests[bounded]);
    const nextChoices = reviewChoices(
      synopsis,
      nextQuestion,
      boardPositionFor(synopsis, nextId, nextQuestion)?.decision ?? ''
    );
    const savedChoice =
      nextChoices.find(
        (choice) => choiceResponse(choice) === saved?.response
      ) ?? null;
    setSelectedResolution(saved?.resolution ?? null);
    setSelectedChoiceId(savedChoice?.id ?? null);
    setWritingCustom(
      saved?.resolution === 'direct'
        ? !savedChoice
        : saved?.resolution === 'defer'
    );
    reset({
      resolution: saved?.resolution ?? 'direct',
      response: saved?.response ?? '',
    });
  };

  return (
    <section
      className={styles.review}
      aria-labelledby="ats-board-review-title"
      data-testid={dataTestId}
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Leadership review</p>
          <h4 id="ats-board-review-title">Resolve open decisions</h4>
        </div>
        <span
          className={styles.progress}
          {...{ 'data-testid': 'ats-board-review-progress' }}
        >
          {index + 1} of {synopsis.decisionRequests.length}
        </span>
      </div>

      <div
        className={styles.synopsis}
        {...{ 'data-testid': 'ats-board-review-synopsis' }}
      >
        <span>Overall recommendation</span>
        <p>{synopsis.recommendation}</p>
        {synopsis.executiveSynopsis.trim() &&
        synopsis.executiveSynopsis.trim() !== synopsis.recommendation.trim() ? (
          <details className={styles.more}>
            <summary {...{ 'data-testid': 'ats-board-review-synopsis-more' }}>
              Why the board recommends this
            </summary>
            <p>{synopsis.executiveSynopsis}</p>
          </details>
        ) : null}
      </div>

      <p
        className={styles.question}
        {...{ 'data-testid': 'ats-board-review-question' }}
      >
        {question}
      </p>

      {recommendation ? (
        <div
          className={styles.recommendation}
          {...{ 'data-testid': 'ats-board-review-finding' }}
        >
          <span>
            {boardDecision?.status === 'Open — insufficient evidence'
              ? 'Board lean — not yet settled'
              : 'Board recommendation for this decision'}
          </span>
          <p>{recommendation}</p>
          {discussion ? <p>{discussion.outcome}</p> : null}
        </div>
      ) : null}

      {choices.length > 0 ? (
        <div
          className={styles.optionList}
          {...{ 'data-testid': 'ats-board-review-options' }}
        >
          <span className={styles.optionLabel}>Choices</span>
          {choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className={
                selectedChoiceId === choice.id
                  ? styles.optionSelected
                  : styles.option
              }
              onClick={() => chooseOption(choice)}
              {...{ 'data-testid': 'ats-board-review-option' }}
            >
              <strong>{choice.title}</strong>
              {choice.boardLean ? <em>Board lean</em> : null}
              {choice.detail ? <span>{choice.detail}</span> : null}
              {choice.tradeoff ? (
                <span>Trade-off: {choice.tradeoff}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.choices} role="group" aria-label="Resolution">
        {canAcceptRecommendation && recommendation ? (
          <button
            type="button"
            className={
              selectedResolution === 'accept_recommendation'
                ? styles.choiceSelected
                : styles.choice
            }
            onClick={() => choose('accept_recommendation')}
            {...{ 'data-testid': 'ats-board-review-accept' }}
          >
            Accept recommendation
          </button>
        ) : null}
        <button
          type="button"
          className={
            writingCustom && selectedResolution === 'direct'
              ? styles.choiceSelected
              : styles.choice
          }
          onClick={() => choose('direct')}
          {...{ 'data-testid': 'ats-board-review-direction' }}
        >
          Write a different recommendation
        </button>
        <button
          type="button"
          className={
            selectedResolution === 'defer'
              ? styles.choiceSelected
              : styles.choice
          }
          onClick={() => choose('defer')}
          {...{ 'data-testid': 'ats-board-review-defer' }}
        >
          Defer with owner and date
        </button>
      </div>

      {writingCustom &&
      (selectedResolution === 'direct' || selectedResolution === 'defer') ? (
        <form
          className={styles.responseForm}
          onSubmit={save}
          {...{ 'data-testid': 'ats-board-review-form' }}
        >
          <input
            type="hidden"
            {...register('resolution')}
            {...{ 'data-testid': 'ats-board-review-resolution' }}
          />
          <label htmlFor={`ats-board-review-response-${decisionId}`}>
            {selectedResolution === 'defer'
              ? 'Who will resolve this, and by when?'
              : 'What recommendation should the team follow?'}
          </label>
          <textarea
            id={`ats-board-review-response-${decisionId}`}
            maxLength={2000}
            {...register('response')}
            {...{ 'data-testid': 'ats-board-review-response' }}
          />
          {errors.response ? (
            <p className={styles.error} role="alert">
              {errors.response.message}
            </p>
          ) : null}
          <button
            type="submit"
            className={styles.save}
            {...{ 'data-testid': 'ats-board-review-save' }}
          >
            Save response
          </button>
        </form>
      ) : null}

      <div className={styles.navigation}>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => move(index - 1)}
          disabled={index === 0}
          {...{ 'data-testid': 'ats-board-review-back' }}
        >
          Back
        </button>
        {!isLast ? (
          <button
            type="button"
            className={styles.next}
            onClick={() => move(index + 1)}
            disabled={!currentAnswer}
            {...{ 'data-testid': 'ats-board-review-next' }}
          >
            Next decision
          </button>
        ) : (
          <p
            className={allAnswered ? styles.complete : styles.incomplete}
            {...{ 'data-testid': 'ats-board-review-completion' }}
          >
            {allAnswered
              ? 'All decisions are recorded. Review the note below, then ratify.'
              : 'Record this decision before ratifying.'}
          </p>
        )}
      </div>
    </section>
  );
};
