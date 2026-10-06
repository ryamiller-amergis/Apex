import { resolveAdoRepository } from '../services/adoRepositoryTarget';

describe('resolveAdoRepository', () => {
  it('splits a skill repo stored as ADO project plus repository', () => {
    expect(resolveAdoRepository('To Do App', 'Apex - Apps/to-do-app')).toEqual({
      project: 'Apex - Apps',
      repo: 'to-do-app',
    });
  });

  it('leaves a plain repository name on the Apex project', () => {
    expect(resolveAdoRepository('MaxView', 'MaxView')).toEqual({
      project: 'MaxView',
      repo: 'MaxView',
    });
  });
});
