-- Up Migration
-- One flag gates every Skill Learning surface: human workflow evaluation,
-- Skill Health, signals from the newer surfaces, replays and skill proposals.
-- Renaming the key keeps the flag row, so its project, user and group rules stay.
UPDATE feature_flags
SET
  key = 'skill-learning',
  description = 'Gates Skill Learning: workflow feedback, Skill Health, judge and Promptfoo evaluation, signals from every covered surface, replays and skill improvement proposals. Off hides the feedback surfaces and refuses their routes.'
WHERE key = 'workflow-human-evaluation'
  AND NOT EXISTS (SELECT 1 FROM feature_flags WHERE key = 'skill-learning');

-- Down Migration
UPDATE feature_flags
SET
  key = 'workflow-human-evaluation',
  description = 'Gates human workflow evaluation on Interviews and PRDs. Off hides feedback surfaces and refuses evaluation routes.'
WHERE key = 'skill-learning'
  AND NOT EXISTS (SELECT 1 FROM feature_flags WHERE key = 'workflow-human-evaluation');
