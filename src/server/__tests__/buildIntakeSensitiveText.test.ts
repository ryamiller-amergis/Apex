import { detectSensitiveClasses } from '../services/buildIntakeSensitiveText';
import { findSecretClasses } from '../services/buildRedactionService';

describe('VT-07 — detectSensitiveClasses (PBI-010 AC-0)', () => {
  it.each([
    ['bearer token', 'Use Bearer abcDEF1234567890xyz to call it', 'access_token'],
    ['JWT', 'token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'access_token'],
    ['ADO.NET connection string', 'Server=db.local;Database=app;Password=hunter22;', 'connection_string'],
    ['postgres URL', 'connect to postgres://u:p@h/db please', 'connection_string'],
    ['api_key value', 'api_key=sk_live_123456789', 'secret_key_value'],
    ['email', 'Email jane.doe@example.com when done', 'personal_email'],
    ['phone', 'Call me at (555) 123-4567', 'personal_phone'],
    ['US SSN', 'My SSN is 123-45-6789', 'personal_government_id'],
    ['Luhn card', 'Card 4111 1111 1111 1111 exp 12/30', 'personal_card_number'],
  ])('flags a %s', (_label, text, expected) => {
    expect(detectSensitiveClasses(text)).toContain(expected);
  });

  it('returns nothing for an ordinary sentence', () => {
    expect(detectSensitiveClasses('Add a dark mode toggle to the profile page for every user.')).toEqual([]);
  });

  it('does not flag a card-length number that fails the Luhn check', () => {
    expect(detectSensitiveClasses('Order 4111 1111 1111 1112')).not.toContain('personal_card_number');
  });

  it('returns each class once, in a stable order', () => {
    expect(detectSensitiveClasses('a@b.co then c@d.co and Bearer abcdefgh12345678')).toEqual([
      'access_token',
      'personal_email',
    ]);
  });
});

describe('findSecretClasses shares the redaction patterns', () => {
  it('names the class and never returns matched text', () => {
    const result = findSecretClasses('password: hunter2hunter2 and Bearer abcdefgh12345678');
    expect(result).toEqual(['access_token', 'secret_key_value']);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});
