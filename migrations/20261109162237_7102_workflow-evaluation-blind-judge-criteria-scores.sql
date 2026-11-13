-- Up Migration
-- Blind judge, definition version 2 for every human-review stage. The judge no
-- longer sees the person's scores and must return its own 1–5 score for every
-- criterion (criteriaScores), so Skill Learning can measure judge–human
-- agreement. Rubric and Promptfoo suite are copied from version 1 unchanged.
-- Events already stored keep their version 1 definition.

UPDATE workflow_evaluation_definitions v1
SET active = false
WHERE v1.process_key = 'orchestrated_workflow'
  AND v1.evaluator_key = 'human_review'
  AND v1.benchmark_key = 'baseline'
  AND v1.version = 1
  AND v1.active
  AND NOT EXISTS (
    SELECT 1 FROM workflow_evaluation_definitions v2
    WHERE v2.process_key = v1.process_key
      AND v2.stage_key = v1.stage_key
      AND v2.evaluator_key = v1.evaluator_key
      AND v2.benchmark_key = v1.benchmark_key
      AND v2.version = 2
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
)
SELECT
  v1.process_key,
  v1.stage_key,
  v1.evaluator_key,
  v1.benchmark_key,
  2,
  v1.rubric,
  v1.promptfoo_suite_ref,
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
    },
    "criteriaScores": {
      "type": "object",
      "properties": {
        "intent_alignment": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        },
        "requirements_coverage": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        },
        "scope_alignment": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        },
        "acceptance_criteria": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        },
        "readiness": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        }
      },
      "required": [
        "intent_alignment",
        "requirements_coverage",
        "scope_alignment",
        "acceptance_criteria",
        "readiness"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "missedRequirements",
    "inventedRequirements",
    "recommendedImprovements",
    "confidence",
    "criteriaScores"
  ],
  "additionalProperties": false
}$judge$::jsonb,
  true
FROM workflow_evaluation_definitions v1
WHERE v1.process_key = 'orchestrated_workflow'
  AND v1.evaluator_key = 'human_review'
  AND v1.benchmark_key = 'baseline'
  AND v1.version = 1
ON CONFLICT (process_key, stage_key, evaluator_key, benchmark_key, version) DO NOTHING;

-- Down Migration
UPDATE workflow_evaluation_definitions
SET active = false
WHERE process_key = 'orchestrated_workflow'
  AND evaluator_key = 'human_review'
  AND benchmark_key = 'baseline'
  AND version = 2;

UPDATE workflow_evaluation_definitions
SET active = true
WHERE process_key = 'orchestrated_workflow'
  AND evaluator_key = 'human_review'
  AND benchmark_key = 'baseline'
  AND version = 1;

DELETE FROM workflow_evaluation_definitions d
WHERE d.process_key = 'orchestrated_workflow'
  AND d.evaluator_key = 'human_review'
  AND d.benchmark_key = 'baseline'
  AND d.version = 2
  AND NOT EXISTS (SELECT 1 FROM workflow_evaluation_events e WHERE e.definition_id = d.id);
