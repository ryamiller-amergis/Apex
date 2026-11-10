import { classifyBuildRevisionFastEdit } from '../services/build/buildRevisionFastEditClassifier';

describe('build revision fast-edit classifier', () => {
  it.each([
    'Move the Cancel button to the right edge of the cards.',
    'Change the heading copy to Upcoming shifts.',
    'Use a calendar icon in the Schedule menu.',
    'Reduce the card padding and make the border softer.',
    'Switch the app to a dark theme with a calmer palette.',
    'Place the approved logo in the top navigation.',
  ])('routes obvious contained UI work to the fast lane: %s', (feedback) => {
    expect(classifyBuildRevisionFastEdit(feedback)).toMatchObject({
      route: 'fast_edit',
      certain: true,
    });
  });

  it.each([
    'Add an endpoint and database table for saved filters.',
    'Change authentication so managers can impersonate users.',
    'Install a new chart dependency.',
    'Update the Azure infrastructure and environment variables.',
    'Integrate this page with Workday.',
  ])('escalates structural work: %s', (feedback) => {
    expect(classifyBuildRevisionFastEdit(feedback)).toMatchObject({
      route: 'full_build',
      certain: true,
    });
  });

  it.each(['Make it better.', 'Update how this works.', 'Fix the experience.'])(
    'tries the fast preview first when the scope is unclear: %s',
    (feedback) => {
      expect(classifyBuildRevisionFastEdit(feedback)).toMatchObject({
        route: 'fast_edit',
        certain: false,
        reason: 'uncertain_scope',
      });
    }
  );

  it('keeps a theme or token change on the fast path', () => {
    expect(
      classifyBuildRevisionFastEdit(
        'Update the dark theme to a different token schema.'
      )
    ).toMatchObject({ route: 'fast_edit', certain: true });
  });

  it('lets a repository inspection escalate a request classified as visual', () => {
    const classification = classifyBuildRevisionFastEdit(
      'Add a status icon to each card.'
    );

    expect(classification.route).toBe('fast_edit');
    expect(classification.agentMayEscalate).toBe(true);
  });
});
