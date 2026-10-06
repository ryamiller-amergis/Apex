import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ProductSetupCandidate } from '../hooks/useProductSetup';
import styles from './ProductSetup.module.css';

export interface FoundationReview {
  reply: string | null;
  error: string | null;
  progressLabel: string | null;
  saved?: boolean;
}

interface FoundationReply {
  draft: string | null;
  note: string | null;
}

const MARKDOWN_FENCE = /```(markdown|md)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n```|$)/i;
const ROUTING_NOTE = /^>\s*Auto routed to[^\n]*(\r?\n)+/i;
const CONFIRM_TAIL = /\n[^\n]*(please confirm|confirm or correct)[\s\S]*$/i;

export function splitFoundationReply(text: string): FoundationReply {
  const cleaned = text.replace(ROUTING_NOTE, '').trim();
  const fence = cleaned.match(MARKDOWN_FENCE);
  if (fence && (fence[1] || /^\s*#/.test(fence[2]))) {
    return { draft: fence[2].trim(), note: null };
  }
  if (/^#{1,2} (Product|Problem)\b/m.test(cleaned)) {
    const start = cleaned.search(/^#/m);
    return { draft: cleaned.slice(start).replace(CONFIRM_TAIL, '').trim(), note: null };
  }
  return { draft: null, note: cleaned || null };
}

interface ProductSetupProps {
  step: 'people' | 'chat';
  /** When false, the viewer cannot add teammates, so only the foundation step is shown. */
  canInviteTeammates?: boolean;
  candidates: ProductSetupCandidate[];
  adding: boolean;
  error: string | null;
  onAddEmail: (email: string) => void;
  onAddExisting: (email: string) => void;
  onSkip: () => void;
  onContinue: () => void;
  onChooseStep: (step: 'people' | 'chat') => void;
  onCompleteFoundation: (answers: string[]) => void;
  initialFoundationAnswers?: string[];
  creatingDraft?: boolean;
  conversationStarted?: boolean;
  review?: FoundationReview;
  onConfirmDraft?: () => void;
  onReviseDraft?: (text: string) => void;
  onRetryDraft?: () => void;
}

const STEPS = [
  { id: 'people' as const, number: '1', label: 'Add people' },
  { id: 'chat' as const, number: '2', label: 'Review product foundation' },
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FOUNDATION_QUESTIONS = [
  {
    topic: 'Product and people',
    prompt: 'Does this clearly describe the product and who it is for?',
    hint: 'This came from the approved product request. Edit it if anything changed.',
  },
  {
    topic: 'Problem',
    prompt: 'Is this the problem the product needs to solve?',
    hint: 'Keep the focus on the problem, not how the system will be built.',
  },
  {
    topic: 'First release',
    prompt: 'Is this the right outcome for the first useful release?',
    hint: 'This uses the approved proposal scope when one is available.',
  },
  {
    topic: 'Success',
    prompt: 'What are two to four clear signs that the first release worked?',
    hint: 'Use checks that two people would judge the same way.',
  },
] as const;

function splitEmails(value: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    emails.push(trimmed);
  }
  return emails;
}

function findCandidate(candidates: ProductSetupCandidate[], email: string): ProductSetupCandidate | undefined {
  const key = email.toLowerCase();
  return candidates.find((person) => person.email.toLowerCase() === key);
}

function personLabel(person: ProductSetupCandidate): string {
  return person.displayName ? `${person.displayName} (${person.email})` : person.email;
}

interface FoundationReviewStepProps {
  review: FoundationReview;
  working: boolean;
  onConfirm?: () => void;
  onRevise?: (text: string) => void;
  onRetry?: () => void;
}

const FoundationReviewStep: React.FC<FoundationReviewStepProps> = ({
  review,
  working,
  onConfirm,
  onRevise,
  onRetry,
}) => {
  const [editing, setEditing] = useState(false);
  const [changes, setChanges] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const { draft, note } = useMemo(
    () => (review.reply ? splitFoundationReply(review.reply) : { draft: null, note: null }),
    [review.reply],
  );

  const submitChanges = () => {
    const text = changes.trim();
    if (!text) return;
    onRevise?.(text);
    setChanges('');
    setEditing(false);
  };

  const heading = review.saved
    ? 'PRODUCT.md is saved'
    : working
      ? (confirmed ? 'Saving PRODUCT.md…' : draft ? 'Updating your product draft…' : 'Creating your product draft…')
      : review.error
        ? 'The draft could not be created'
        : draft
          ? 'Review your product draft'
          : 'Almost done';
  const subtitle = review.saved
    ? 'Your project is ready.'
    : working
      ? (review.progressLabel ?? 'This usually takes a few moments.')
      : review.error
        ? 'Try again. Your answers are kept.'
        : draft
          ? 'Nothing is saved until you confirm.'
          : 'Reply below if Apex needs anything else.';

  return (
    <div className={styles.review} {...{ 'data-testid': 'product-setup-chat-ready' }}>
      <div className={styles.reviewStatus} role="status" aria-live="polite">
        {working && (
          <span className={styles.workingDots} aria-hidden="true">
            <span /><span /><span />
          </span>
        )}
        <div className={styles.reviewStatusText}>
          <strong>{heading}</strong>
          <span>{subtitle}</span>
        </div>
      </div>

      {review.error && !working && (
        <p className={styles.error} role="alert" {...{ 'data-testid': 'product-setup-review-error' }}>
          {review.error}
        </p>
      )}

      {(draft || note) && (
        <article
          className={`${styles.document}${working ? ` ${styles.documentWorking}` : ''}`}
          {...{ 'data-testid': draft ? 'product-setup-draft' : 'product-setup-note' }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft ?? note ?? ''}</ReactMarkdown>
        </article>
      )}

      {!working && review.error && onRetry && (
        <div className={styles.guidedActions}>
          <span />
          <button type="button" className={styles.primaryButton} onClick={onRetry} {...{ 'data-testid': 'product-setup-retry' }}>
            Try again
          </button>
        </div>
      )}

      {!working && !review.error && !review.saved && (draft || note) && (
        editing || !draft ? (
          <form
            className={styles.questionBlock}
            onSubmit={(event) => {
              event.preventDefault();
              submitChanges();
            }}
            {...{ 'data-testid': 'product-setup-changes-form' }}
          >
            <label className={styles.question} htmlFor="product-setup-changes">
              {draft ? 'What should change?' : 'Your reply'}
            </label>
            <textarea
              id="product-setup-changes"
              className={styles.answer}
              value={changes}
              onChange={(event) => setChanges(event.target.value)}
              placeholder={draft ? 'Example: Add "No mobile app" to out of scope.' : 'Type your answer in your own words'}
              rows={3}
              {...{ 'data-testid': 'product-setup-changes' }}
            />
            <div className={styles.guidedActions}>
              {draft ? (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setEditing(false)}
                  {...{ 'data-testid': 'product-setup-cancel-changes' }}
                >
                  Cancel
                </button>
              ) : <span />}
              <button
                type="submit"
                className={styles.primaryButton}
                disabled={!changes.trim()}
                {...{ 'data-testid': 'product-setup-send-changes' }}
              >
                {draft ? 'Update draft' : 'Send'}
              </button>
            </div>
          </form>
        ) : (
          <div className={styles.guidedActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setEditing(true)}
              {...{ 'data-testid': 'product-setup-request-changes' }}
            >
              Ask for changes
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                setConfirmed(true);
                onConfirm?.();
              }}
              {...{ 'data-testid': 'product-setup-confirm-draft' }}
            >
              Looks good — save PRODUCT.md
            </button>
          </div>
        )
      )}
    </div>
  );
};

export const ProductSetup: React.FC<ProductSetupProps> = ({
  step,
  canInviteTeammates = true,
  candidates,
  adding,
  error,
  onAddEmail,
  onAddExisting,
  onSkip,
  onContinue,
  onChooseStep,
  onCompleteFoundation,
  initialFoundationAnswers = [],
  creatingDraft = false,
  conversationStarted = false,
  review,
  onConfirmDraft,
  onReviseDraft,
  onRetryDraft,
}) => {
  const [email, setEmail] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [flagged, setFlagged] = useState<ProductSetupCandidate[]>([]);
  const [emailError, setEmailError] = useState<string | null>(null);
  const initialAnswers = () => FOUNDATION_QUESTIONS.map((_, index) =>
    initialFoundationAnswers[index]?.trim() ?? '',
  );
  const [questionIndex, setQuestionIndex] = useState(0);
  const [foundationAnswer, setFoundationAnswer] = useState(
    () => initialFoundationAnswers[0]?.trim() ?? '',
  );
  const [foundationAnswers, setFoundationAnswers] = useState<string[]>(
    initialAnswers,
  );

  const visibleSteps = canInviteTeammates
    ? STEPS
    : STEPS.filter((item) => item.id === 'chat').map((item) => ({ ...item, number: '1' }));

  const toggle = (userId: string) => {
    setSelected((current) => (
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]
    ));
  };

  const query = peopleQuery.trim().toLowerCase();
  const visiblePeople = query
    ? candidates.filter((person) => (
      person.displayName.toLowerCase().includes(query) || person.email.toLowerCase().includes(query)
    ))
    : candidates;

  const knownInField = useMemo(
    () => splitEmails(email)
      .map((address) => findCandidate(candidates, address))
      .filter((person): person is ProductSetupCandidate => Boolean(person)),
    [email, candidates],
  );

  const flaggedIds = new Set(flagged.map((person) => person.userId));

  const submitEmails = () => {
    const parts = splitEmails(email);
    if (parts.length === 0) return;

    const known: ProductSetupCandidate[] = [];
    const fresh: string[] = [];
    const invalid: string[] = [];
    for (const address of parts) {
      const match = findCandidate(candidates, address);
      if (match) known.push(match);
      else if (!EMAIL_PATTERN.test(address)) invalid.push(address);
      else fresh.push(address);
    }

    setFlagged(known);
    if (known.length > 0) {
      setSelected((current) => [...new Set([...current, ...known.map((person) => person.userId)])]);
    }
    setEmailError(invalid.length > 0 ? `Check these addresses: ${invalid.join(', ')}` : null);
    for (const address of fresh) onAddEmail(address);
    setEmail(invalid.join(', '));
  };

  const saveFoundationAnswer = () => {
    const answer = foundationAnswer.trim();
    if (!answer) return;
    const nextAnswers = [...foundationAnswers];
    nextAnswers[questionIndex] = answer;
    setFoundationAnswers(nextAnswers);
    if (questionIndex === FOUNDATION_QUESTIONS.length - 1) {
      onCompleteFoundation(nextAnswers);
      return;
    }
    const nextIndex = questionIndex + 1;
    setQuestionIndex(nextIndex);
    setFoundationAnswer(nextAnswers[nextIndex] ?? '');
  };

  const goBack = () => {
    if (questionIndex === 0) return;
    const nextAnswers = [...foundationAnswers];
    nextAnswers[questionIndex] = foundationAnswer.trim();
    const previousIndex = questionIndex - 1;
    setFoundationAnswers(nextAnswers);
    setQuestionIndex(previousIndex);
    setFoundationAnswer(nextAnswers[previousIndex] ?? '');
  };

  return (
    <section className={styles.panel} {...{ 'data-testid': 'product-setup' }}>
      <header className={styles.header}>
        <h1 className={styles.heading}>Product setup</h1>
        <p className={styles.subtitle}>
          {canInviteTeammates
            ? 'Two steps before your project opens: add your team, then review its foundation.'
            : 'Review the product foundation before your project opens.'}
        </p>
      </header>

      <ol className={styles.stepper} aria-label="Product setup steps">
        {visibleSteps.map((item) => (
          <li key={item.id} className={styles.stepItem}>
            <button
              type="button"
              className={`${styles.stepButton}${step === item.id ? ` ${styles.stepButtonActive}` : ''}`}
              aria-current={step === item.id ? 'step' : undefined}
              onClick={() => onChooseStep(item.id)}
              {...{ 'data-testid': `product-setup-step-${item.number}` }}
            >
              <span className={styles.stepNumber}>{item.number}</span>
              {item.label}
            </button>
          </li>
        ))}
      </ol>

      <div className={styles.body}>
        {step === 'people' ? (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              submitEmails();
            }}
            {...{ 'data-testid': 'product-setup-people-form' }}
          >
            {candidates.length > 0 && (
              <div className={styles.people} {...{ 'data-testid': 'product-setup-people' }}>
                <p className={styles.label} id="product-setup-people-label">People already in Apex</p>
                <input
                  className={styles.input}
                  type="search"
                  value={peopleQuery}
                  onChange={(event) => setPeopleQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.preventDefault();
                  }}
                  placeholder="Search by name or email"
                  aria-label="Search people already in Apex"
                  {...{ 'data-testid': 'product-setup-people-search' }}
                />
                {visiblePeople.length > 0 ? (
                  <ul className={styles.list} aria-labelledby="product-setup-people-label">
                    {visiblePeople.map((person) => {
                      const isSelected = selected.includes(person.userId);
                      const isFlagged = flaggedIds.has(person.userId);
                      return (
                        <li key={person.userId}>
                          <label
                            className={`${styles.person}${isSelected ? ` ${styles.personSelected}` : ''}${isFlagged ? ` ${styles.personFlagged}` : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggle(person.userId)}
                              {...{ 'data-testid': `product-setup-person-${person.userId}` }}
                            />
                            <span className={styles.personText}>
                              <span className={styles.personName}>{person.displayName || person.email}</span>
                              {person.displayName && (
                                <span className={styles.personEmail}>{person.email}</span>
                              )}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className={styles.empty}>No one matches that search.</p>
                )}
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={adding || selected.length === 0}
                  onClick={() => {
                    for (const userId of selected) {
                      const person = candidates.find((item) => item.userId === userId);
                      if (person?.email) onAddExisting(person.email);
                    }
                    setSelected([]);
                    setFlagged([]);
                  }}
                  {...{ 'data-testid': 'product-setup-add-selected' }}
                >
                  {selected.length > 0 ? `Add selected people (${selected.length})` : 'Add selected people'}
                </button>
              </div>
            )}

            <div className={styles.emailBlock}>
              <div className={styles.emailRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="product-setup-email">Work email</label>
                  <input
                    id="product-setup-email"
                    className={styles.input}
                    type="text"
                    inputMode="email"
                    autoComplete="off"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="name@company.com, other@company.com"
                    aria-describedby="product-setup-email-hint"
                    {...{ 'data-testid': 'product-setup-email' }}
                  />
                </div>
                <button
                  type="submit"
                  className={styles.primaryButton}
                  disabled={adding || !email.trim()}
                  {...{ 'data-testid': 'product-setup-add-email' }}
                >
                  {adding ? 'Adding…' : 'Add by email'}
                </button>
              </div>
              <p className={styles.hint} id="product-setup-email-hint">Separate addresses with commas.</p>
            </div>

            {(knownInField.length > 0 || flagged.length > 0) && (
              <p className={styles.flag} role="status" {...{ 'data-testid': 'product-setup-known-email' }}>
                {(knownInField.length > 0 ? knownInField : flagged).map(personLabel).join(', ')}
                {' '}
                {(knownInField.length > 1 || (knownInField.length === 0 && flagged.length > 1))
                  ? 'are already in Apex. Select them above instead of adding them by email.'
                  : 'is already in Apex. Select them above instead of adding them by email.'}
              </p>
            )}

            {(emailError || error) && (
              <p className={styles.error} role="alert" {...{ 'data-testid': 'product-setup-error' }}>
                {emailError || error}
              </p>
            )}
          </form>
        ) : conversationStarted ? (
          <FoundationReviewStep
            review={review ?? { reply: null, error: null, progressLabel: null }}
            working={creatingDraft}
            onConfirm={onConfirmDraft}
            onRevise={onReviseDraft}
            onRetry={onRetryDraft}
          />
        ) : (
          <form
            className={styles.guidedForm}
            onSubmit={(event) => {
              event.preventDefault();
              saveFoundationAnswer();
            }}
            {...{ 'data-testid': 'product-setup-guided-form' }}
          >
            <div className={styles.guideSummary}>
              <strong>Review your product foundation</strong>
              <span>We carried forward the approved request · edit anything that changed</span>
            </div>
            <div className={styles.progressRow} aria-label={`Question ${questionIndex + 1} of ${FOUNDATION_QUESTIONS.length}`}>
              {FOUNDATION_QUESTIONS.map((question, index) => (
                <span
                  key={question.topic}
                  className={`${styles.progressDot}${index <= questionIndex ? ` ${styles.progressDotActive}` : ''}`}
                  aria-hidden="true"
                />
              ))}
              <span className={styles.progressText}>
                {questionIndex + 1} of {FOUNDATION_QUESTIONS.length}
              </span>
            </div>
            <div className={styles.questionBlock}>
              <span className={styles.questionTopic}>{FOUNDATION_QUESTIONS[questionIndex].topic}</span>
              <label className={styles.question} htmlFor="product-setup-foundation-answer">
                {FOUNDATION_QUESTIONS[questionIndex].prompt}
              </label>
              <textarea
                id="product-setup-foundation-answer"
                className={styles.answer}
                value={foundationAnswer}
                onChange={(event) => setFoundationAnswer(event.target.value)}
                placeholder="Type your answer in your own words"
                rows={3}
                disabled={creatingDraft}
                {...{ 'data-testid': 'product-setup-foundation-answer' }}
              />
              <span className={styles.hint}>{FOUNDATION_QUESTIONS[questionIndex].hint}</span>
            </div>
            <div className={styles.guidedActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={goBack}
                disabled={questionIndex === 0 || creatingDraft}
                {...{ 'data-testid': 'product-setup-foundation-back' }}
              >
                Back
              </button>
              <button
                type="submit"
                className={styles.primaryButton}
                disabled={!foundationAnswer.trim() || creatingDraft}
                {...{ 'data-testid': 'product-setup-foundation-next' }}
              >
                {questionIndex === FOUNDATION_QUESTIONS.length - 1 ? 'Create product draft' : 'Next question'}
              </button>
            </div>
          </form>
        )}
      </div>

      {step === 'people' && (
        <div className={styles.footer}>
          {!conversationStarted && (
            <button type="button" className={styles.secondaryButton} onClick={onSkip} {...{ 'data-testid': 'product-setup-skip' }}>
              Skip
            </button>
          )}
          <button type="button" className={styles.primaryButton} onClick={onContinue} {...{ 'data-testid': 'product-setup-continue' }}>
            {conversationStarted ? 'Back to the conversation' : 'Continue'}
          </button>
        </div>
      )}
    </section>
  );
};
