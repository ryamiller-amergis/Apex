-- Up Migration
-- Human workflow evaluation for QA test cases. Adds the test_cases subject type
-- and seeds test_cases_human_review version 1. The rubric keeps the five
-- shared criteria keys with QA help text. subject_id is the test_cases row and
-- prd_id the PRD it was derived from. Re-running the insert does nothing.

ALTER TABLE workflow_evaluation_events
  DROP CONSTRAINT workflow_evaluation_events_subject_type_check,
  ADD CONSTRAINT workflow_evaluation_events_subject_type_check CHECK (
    subject_type IN ('interview_phase', 'prd', 'design_doc', 'test_cases')
  ),
  DROP CONSTRAINT workflow_evaluation_events_subject_coherence_check,
  ADD CONSTRAINT workflow_evaluation_events_subject_coherence_check CHECK (
    (
      subject_type = 'prd'
      AND phase_index IS NULL
      AND prd_id = subject_id
    )
    OR (
      subject_type = 'interview_phase'
      AND phase_index BETWEEN 1 AND 3
      AND interview_id = subject_id
    )
    OR (
      subject_type IN ('design_doc', 'test_cases')
      AND phase_index IS NULL
      AND prd_id IS NOT NULL
      AND prd_id <> subject_id
    )
  );

INSERT INTO workflow_evaluation_definitions (
  process_key,
  stage_key,
  evaluator_key,
  benchmark_key,
  version,
  rubric,
  promptfoo_suite_ref,
  judge_output_schema,
  active
) VALUES
(
  'orchestrated_workflow',
  'test_cases_human_review',
  'human_review',
  'baseline',
  1,
  $rubric${
  "scale": [
    {
      "score": 1,
      "label": "Missed"
    },
    {
      "score": 2,
      "label": "Major changes needed"
    },
    {
      "score": 3,
      "label": "Some changes needed"
    },
    {
      "score": 4,
      "label": "Minor changes needed"
    },
    {
      "score": 5,
      "label": "Met completely"
    }
  ],
  "criteria": [
    {
      "key": "intent_alignment",
      "label": "Intent alignment",
      "helpText": "Do the test cases check what the PRD meant, not just its wording?"
    },
    {
      "key": "requirements_coverage",
      "label": "Requirements coverage",
      "helpText": "Is every acceptance criterion and business rule covered by at least one case?"
    },
    {
      "key": "scope_alignment",
      "label": "Scope alignment",
      "helpText": "Do the cases stay inside the PRD scope, with no invented behavior?"
    },
    {
      "key": "acceptance_criteria",
      "label": "Acceptance criteria",
      "helpText": "Does each case have clear steps and an expected result a tester can check?"
    },
    {
      "key": "readiness",
      "label": "Readiness",
      "helpText": "Could QA run these cases without rewriting them?"
    }
  ],
  "reasonCodes": [
    {
      "key": "missing_requirement",
      "label": "Missing requirement"
    },
    {
      "key": "invented_requirement",
      "label": "Invented requirement"
    },
    {
      "key": "incorrect_interpretation",
      "label": "Incorrect interpretation"
    },
    {
      "key": "too_vague",
      "label": "Too vague"
    },
    {
      "key": "wrong_scope",
      "label": "Wrong scope"
    },
    {
      "key": "acceptance_criteria_not_testable",
      "label": "Acceptance criteria not testable"
    },
    {
      "key": "prd_backlog_inconsistency",
      "label": "PRD and backlog inconsistency"
    }
  ],
  "outcomes": [
    {
      "key": "accept_unchanged",
      "label": "Accept unchanged"
    },
    {
      "key": "accept_after_edits",
      "label": "Accept after edits"
    },
    {
      "key": "regenerate",
      "label": "Regenerate"
    },
    {
      "key": "reject",
      "label": "Reject"
    }
  ],
  "allowedReviewerRoles": [
    {
      "key": "product_owner",
      "label": "Product owner"
    },
    {
      "key": "ba",
      "label": "BA"
    },
    {
      "key": "manager",
      "label": "Manager"
    },
    {
      "key": "developer",
      "label": "Developer"
    },
    {
      "key": "qa",
      "label": "QA"
    },
    {
      "key": "other",
      "label": "Other"
    }
  ],
  "lowScoreThreshold": 2,
  "minLowScoreCommentLength": 20
}$rubric$::jsonb,
  'orchestrated_workflow/test_cases_human_review/structural@1',
  $judge${
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "missedRequirements": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "description": {
            "type": "string"
          },
          "evidence": {
            "type": "string"
          }
        },
        "required": [
          "description"
        ],
        "additionalProperties": false
      }
    },
    "inventedRequirements": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "description": {
            "type": "string"
          },
          "evidence": {
            "type": "string"
          }
        },
        "required": [
          "description"
        ],
        "additionalProperties": false
      }
    },
    "alignmentScore": {
      "type": "number",
      "minimum": 1,
      "maximum": 5
    },
    "recommendedImprovements": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string"
          },
          "criterion": {
            "type": "string"
          }
        },
        "required": [
          "text"
        ],
        "additionalProperties": false
      }
    },
    "confidence": {
      "type": "string",
      "enum": [
        "low",
        "medium",
        "high"
      ]
    }
  },
  "required": [
    "missedRequirements",
    "inventedRequirements",
    "recommendedImprovements",
    "confidence"
  ],
  "additionalProperties": false
}$judge$::jsonb,
  true
)
ON CONFLICT (process_key, stage_key, evaluator_key, benchmark_key, version) DO NOTHING;

-- Down Migration
-- Events are append-only, so the immutability trigger is paused only while the
-- test case rows and their jobs are removed. Other evaluations are kept.

ALTER TABLE workflow_evaluation_events DISABLE TRIGGER workflow_evaluation_events_immutable;

DELETE FROM workflow_evaluation_jobs
WHERE event_id IN (
  SELECT id FROM workflow_evaluation_events WHERE subject_type = 'test_cases'
);

DELETE FROM workflow_evaluation_events WHERE subject_type = 'test_cases';

ALTER TABLE workflow_evaluation_events ENABLE TRIGGER workflow_evaluation_events_immutable;

DELETE FROM workflow_evaluation_definitions
WHERE process_key = 'orchestrated_workflow'
  AND stage_key = 'test_cases_human_review'
  AND evaluator_key = 'human_review'
  AND benchmark_key = 'baseline';

ALTER TABLE workflow_evaluation_events
  DROP CONSTRAINT workflow_evaluation_events_subject_coherence_check,
  ADD CONSTRAINT workflow_evaluation_events_subject_coherence_check CHECK (
    (
      subject_type = 'prd'
      AND phase_index IS NULL
      AND prd_id = subject_id
    )
    OR (
      subject_type = 'interview_phase'
      AND phase_index BETWEEN 1 AND 3
      AND interview_id = subject_id
    )
    OR (
      subject_type = 'design_doc'
      AND phase_index IS NULL
      AND prd_id IS NOT NULL
      AND prd_id <> subject_id
    )
  ),
  DROP CONSTRAINT workflow_evaluation_events_subject_type_check,
  ADD CONSTRAINT workflow_evaluation_events_subject_type_check CHECK (
    subject_type IN ('interview_phase', 'prd', 'design_doc')
  );
