-- Up Migration
-- Seed a draft, project-scoped walkthrough that tells the Apex product story
-- over the real application. It remains a draft so Platform Admin can preview
-- and publish it deliberately instead of interrupting users on deployment.

DO $seed_why_apex_walkthrough$
DECLARE
  v_walkthrough_id CONSTANT UUID := '3f493b4c-7ad6-4aa5-a951-98c6ab0bd8aa';
BEGIN
  IF EXISTS (
    SELECT 1
    FROM walkthroughs
    WHERE id = v_walkthrough_id
       OR internal_name = 'why-apex-guided-tour'
  ) THEN
    RAISE NOTICE 'Walkthrough why-apex-guided-tour already exists; skipping seed';
    RETURN;
  END IF;

  INSERT INTO walkthroughs (
    id,
    internal_name,
    user_title,
    why_it_matters,
    lifecycle,
    priority,
    is_required,
    revision,
    created_by,
    updated_by
  )
  VALUES (
    v_walkthrough_id,
    'why-apex-guided-tour',
    'See how Apex turns ideas into decisions',
    'Follow an idea from its first conversation through requirements, prototypes, and technical design. Along the way, see how Apex gives your team stronger context for asking better questions and making deliberate decisions.',
    'draft',
    80,
    FALSE,
    1,
    'system',
    'system'
  );

  INSERT INTO walkthrough_steps (
    walkthrough_id,
    ordinal,
    heading,
    body_markdown,
    target_route,
    image_url,
    image_alt,
    anchor_key,
    placement,
    cta_label,
    cta_route
  )
  VALUES
  (
    v_walkthrough_id,
    0,
    'Start with the idea',
    'Apex connects the conversations and artifacts behind product delivery. This short tour follows that path and shows where your judgment makes the work stronger.',
    '/home',
    '/brand-lockup.svg',
    'Apex logo',
    NULL,
    NULL,
    NULL,
    NULL
  ),
  (
    v_walkthrough_id,
    1,
    'Bring the right assistant into the work',
    'Agent Home keeps project-grounded conversations in one place. Project-configured skill shortcuts help you start with the right process, while thread history lets you return to the reasoning behind earlier decisions.',
    '/home',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  ),
  (
    v_walkthrough_id,
    2,
    'Strengthen requirements through dialogue',
    'A design interview does more than record an idea. The agent challenges assumptions, asks focused follow-up questions, and uses project context to expose gaps before they become delivery problems.',
    '/backlog?tab=interviews',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  ),
  (
    v_walkthrough_id,
    3,
    'Turn the conversation into an actionable plan',
    'Apex turns the completed interview into a structured PRD and backlog. Review comments, readiness checks, and explicit approvals give the team concrete material to question, refine, and agree on.',
    '/backlog?tab=prds',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  ),
  (
    v_walkthrough_id,
    4,
    'Make assumptions visible early',
    'Interactive design prototypes give reviewers something tangible to explore before implementation. That makes unclear flows and competing expectations easier to spot while change is still inexpensive.',
    '/backlog?tab=design-prototypes',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  ),
  (
    v_walkthrough_id,
    5,
    'Carry intent into technical design',
    'Design documents stay grounded in the interview, PRD, and approved prototype. Per-feature documents, diagrams, validation, and review help engineers test the proposed approach instead of reconstructing product intent from scratch.',
    '/backlog?tab=design-docs',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  ),
  (
    v_walkthrough_id,
    6,
    'Fit the assistant to the project',
    'Apex is not limited to one fixed AI workflow. Project admins can choose skill paths and models for each capability, so teams can apply their own standards while keeping a consistent product experience.',
    '/home',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  ),
  (
    v_walkthrough_id,
    7,
    'Use AI to think more critically',
    'The goal is not to replace team judgment. Apex creates a shared trail of questions, evidence, prototypes, and technical choices so people can challenge the work earlier and make better-informed decisions together.',
    '/home',
    NULL,
    NULL,
    NULL,
    NULL,
    'Explore interviews',
    '/backlog?tab=interviews'
  );

  INSERT INTO walkthrough_targeting_rules (
    walkthrough_id,
    type,
    value
  )
  VALUES (
    v_walkthrough_id,
    'project',
    'Apex'
  );
END
$seed_why_apex_walkthrough$;

-- Down Migration
DELETE FROM walkthroughs
WHERE id = '3f493b4c-7ad6-4aa5-a951-98c6ab0bd8aa';
