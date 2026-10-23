-- Up Migration
-- Platform seeds for human workflow evaluation (FEAT-001 / TBI-002).
-- Four version-1 rows under process orchestrated_workflow. Re-runs do nothing.
-- A later rubric change is a new migration that inserts version 2 and sets
-- version 1 inactive. This file does not UPDATE an existing rubric.
-- Registry keys, Interview phase wording and Promptfoo suite refs follow the
-- recommended defaults in the design-spec assumptions.

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
  'prd_human_review',
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
      "helpText": "Does the PRD state the problem and outcome you meant?"
    },
    {
      "key": "requirements_coverage",
      "label": "Requirements coverage",
      "helpText": "Does the PRD and Backlog include every requirement you expected?"
    },
    {
      "key": "scope_alignment",
      "label": "Scope alignment",
      "helpText": "Does the PRD stay inside the scope you agreed, with nothing invented?"
    },
    {
      "key": "acceptance_criteria",
      "label": "Acceptance criteria",
      "helpText": "Can a tester check each acceptance criterion?"
    },
    {
      "key": "readiness",
      "label": "Readiness",
      "helpText": "Could the team start design and delivery from this PRD without rework?"
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
  'orchestrated_workflow/prd_human_review/structural@1',
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
),
(
  'orchestrated_workflow',
  'interview_phase_1',
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
      "helpText": "Does this phase capture the problem and outcome you meant to explore?"
    },
    {
      "key": "requirements_coverage",
      "label": "Requirements coverage",
      "helpText": "Did this phase surface every requirement you discussed?"
    },
    {
      "key": "scope_alignment",
      "label": "Scope alignment",
      "helpText": "Did this phase stay inside the scope you agreed?"
    },
    {
      "key": "acceptance_criteria",
      "label": "Acceptance criteria",
      "helpText": "Are the success conditions in this phase specific enough to test?"
    },
    {
      "key": "readiness",
      "label": "Readiness",
      "helpText": "Is this phase complete enough to move to the next one?"
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
  'orchestrated_workflow/interview_phase_1/structural@1',
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
),
(
  'orchestrated_workflow',
  'interview_phase_2',
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
      "helpText": "Does this phase capture the problem and outcome you meant to explore?"
    },
    {
      "key": "requirements_coverage",
      "label": "Requirements coverage",
      "helpText": "Did this phase surface every requirement you discussed?"
    },
    {
      "key": "scope_alignment",
      "label": "Scope alignment",
      "helpText": "Did this phase stay inside the scope you agreed?"
    },
    {
      "key": "acceptance_criteria",
      "label": "Acceptance criteria",
      "helpText": "Are the success conditions in this phase specific enough to test?"
    },
    {
      "key": "readiness",
      "label": "Readiness",
      "helpText": "Is this phase complete enough to move to the next one?"
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
  'orchestrated_workflow/interview_phase_2/structural@1',
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
),
(
  'orchestrated_workflow',
  'interview_phase_3',
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
      "helpText": "Does this phase capture the problem and outcome you meant to explore?"
    },
    {
      "key": "requirements_coverage",
      "label": "Requirements coverage",
      "helpText": "Did this phase surface every requirement you discussed?"
    },
    {
      "key": "scope_alignment",
      "label": "Scope alignment",
      "helpText": "Did this phase stay inside the scope you agreed?"
    },
    {
      "key": "acceptance_criteria",
      "label": "Acceptance criteria",
      "helpText": "Are the success conditions in this phase specific enough to test?"
    },
    {
      "key": "readiness",
      "label": "Readiness",
      "helpText": "Is this phase complete enough to move to the next one?"
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
  'orchestrated_workflow/interview_phase_3/structural@1',
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
-- Events are append-only, so DELETE is rejected by the immutability trigger.
-- TRUNCATE does not fire that trigger. Clear jobs and events before the seeded
-- definitions, or the restrict foreign key blocks this down. This down is for
-- test databases and pre-release rollback; it removes every stored evaluation.

TRUNCATE workflow_evaluation_jobs, workflow_evaluation_events;

DELETE FROM workflow_evaluation_definitions
WHERE process_key = 'orchestrated_workflow'
  AND evaluator_key = 'human_review'
  AND benchmark_key = 'baseline'
  AND version = 1
  AND stage_key IN (
    'prd_human_review',
    'interview_phase_1',
    'interview_phase_2',
    'interview_phase_3'
  );
