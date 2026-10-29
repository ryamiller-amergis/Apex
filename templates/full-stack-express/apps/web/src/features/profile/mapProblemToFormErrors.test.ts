import { describe, expect, it } from 'vitest';
import { problemBody } from '../../testing/profileFixture';
import {
  firstProfileField,
  mapProblemToFormErrors,
} from './mapProblemToFormErrors';

describe('mapProblemToFormErrors', () => {
  it('VT-10 maps named pointers and ignores unknown fields', () => {
    const mapped = mapProblemToFormErrors(
      problemBody(400, [
        {
          pointer: '/email',
          code: 'invalid_format',
          message: 'The value does not have the required format.',
        },
        {
          pointer: '/subject',
          code: 'unrecognized_key',
          message: 'This field is not allowed.',
        },
        {
          pointer: '/displayName',
          code: 'too_small',
          message: 'The value is too short or too small.',
        },
      ])
    );

    expect(mapped).toEqual([
      {
        field: 'email',
        message: 'The value does not have the required format.',
      },
      {
        field: 'displayName',
        message: 'The value is too short or too small.',
      },
    ]);
    expect(firstProfileField(mapped)).toBe('displayName');
  });

  it('returns nothing for a problem with no field list', () => {
    expect(mapProblemToFormErrors(null)).toEqual([]);
    expect(mapProblemToFormErrors(problemBody(500))).toEqual([]);
  });
});
