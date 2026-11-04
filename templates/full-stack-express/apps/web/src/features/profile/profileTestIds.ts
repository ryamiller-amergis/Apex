import { testId } from '@project-scope/ui';

export const profileTestIds = {
  heading: testId('profile', 'heading'),
  loading: testId('profile', 'loading'),
  error: testId('profile', 'error'),
  retry: testId('profile', 'retry'),
  unauthenticated: testId('profile', 'unauthenticated'),
  savedMessage: testId('profile', 'saved-message'),
  details: testId('profile', 'details'),
  displayName: testId('profile', 'display-name'),
  email: testId('profile', 'email'),
  emailEmpty: testId('profile', 'email-empty'),
  status: testId('profile', 'status'),
  editButton: testId('profile', 'edit-button'),
  form: testId('profile', 'form'),
  displayNameInput: testId('profile', 'display-name-input'),
  emailInput: testId('profile', 'email-input'),
  saveButton: testId('profile', 'save-button'),
  cancelButton: testId('profile', 'cancel-button'),
  saveError: testId('profile', 'save-error'),
  saveRetry: testId('profile', 'save-retry'),
} as const;
