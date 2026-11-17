import { QueryFailedError } from 'typeorm';
import { isUniqueViolation } from '../../../src/repositories/errors/is-unique-violation';

/** Builds a TypeORM query error wrapping a driver error with the given PG code. */
function queryError(code: unknown): QueryFailedError {
  return new QueryFailedError('INSERT', [], Object.assign(new Error('db'), { code }));
}

describe('isUniqueViolation', () => {
  it('should be true for a QueryFailedError with PG code 23505', () => {
    expect(isUniqueViolation(queryError('23505'))).toBe(true);
  });

  it('should be false for a QueryFailedError with another code', () => {
    expect(isUniqueViolation(queryError('23503'))).toBe(false);
    expect(isUniqueViolation(queryError(undefined))).toBe(false);
  });

  it('should be false for errors that are not QueryFailedError', () => {
    expect(isUniqueViolation(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
