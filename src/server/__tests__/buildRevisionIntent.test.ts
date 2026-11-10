import { isBuildChangeRequest } from '../../shared/buildRevisionIntent';

describe('isBuildChangeRequest', () => {
  it.each([
    'can you update dark theme to be a different token schema?',
    'Yes i would like a new dark token schema bundled with this app',
    'Make the header blue',
    'Move the save button to the right',
  ])('treats "%s" as a change', (text) => {
    expect(isBuildChangeRequest(text)).toBe(true);
  });

  it.each([
    'what is the status of this build?',
    'how long until it is done?',
    'is it still running?',
    'thanks!',
    '',
  ])('treats "%s" as a question', (text) => {
    expect(isBuildChangeRequest(text)).toBe(false);
  });
});
