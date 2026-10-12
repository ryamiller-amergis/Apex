---
name: interview-brief-draft
description: Converts one completed interview transcript into the editable requirements brief used by a Playbook interview step.
---

# Interview brief draft

Read the interview transcript and return only one JSON object. Summarize what the Business Analyst confirmed. Do not invent detail and do not include chain-of-thought.

Use exactly these fields:

```json
{
  "problemAndOutcome": "",
  "users": "",
  "scope": "",
  "businessRules": "",
  "scenarios": "",
  "acceptanceCriteria": "",
  "assumptions": "",
  "unresolvedItems": []
}
```

All fields except `unresolvedItems` are strings. `unresolvedItems` is an array of short strings. Put missing or conflicting requirements in `unresolvedItems`; leave a section empty when the transcript does not support it.
