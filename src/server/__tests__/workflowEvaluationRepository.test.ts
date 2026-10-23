jest.mock('../db/drizzle', () => ({ db: {} }));

import * as repository from '../services/workflowEvaluationRepository';

describe('workflowEvaluationRepository — TBI-007', () => {
  it('VT-11 / TBI-007 (d): exported names contain no update, delete or remove', () => {
    const names = Object.keys(repository);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/update|delete|remove/i);
    }
  });
});
