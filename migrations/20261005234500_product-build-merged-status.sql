-- A merged pull request is finished. Home can then open the next feature prompt.

-- Up Migration

ALTER TABLE product_builds DROP CONSTRAINT IF EXISTS product_builds_status_check;
ALTER TABLE product_builds ADD CONSTRAINT product_builds_status_check CHECK (
  status IN (
    'discovery',
    'brief-confirmed',
    'prototype',
    'approved',
    'building',
    'pr-open',
    'merged',
    'failed'
  )
);

-- Down Migration

UPDATE product_builds SET status = 'pr-open' WHERE status = 'merged';
ALTER TABLE product_builds DROP CONSTRAINT IF EXISTS product_builds_status_check;
ALTER TABLE product_builds ADD CONSTRAINT product_builds_status_check CHECK (
  status IN (
    'discovery',
    'brief-confirmed',
    'prototype',
    'approved',
    'building',
    'pr-open',
    'failed'
  )
);
