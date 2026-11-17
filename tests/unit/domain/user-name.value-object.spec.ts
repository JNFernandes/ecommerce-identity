import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { UserName } from '../../../src/domain/user-name.value-object';

describe('UserName', () => {
  it('should trim the name', () => {
    expect(UserName.create('  Ana Silva  ').value).toBe('Ana Silva');
  });

  it('should accept 1 character', () => {
    expect(UserName.create('A').value).toBe('A');
  });

  it('should accept 100 characters', () => {
    expect(UserName.create('a'.repeat(100)).value).toHaveLength(100);
  });

  it.each(['', '   ', '\t\n'])('should reject the empty or whitespace-only name %p', (raw) => {
    expect(() => UserName.create(raw)).toThrow(UserValidationError);
  });

  it('should reject 101 characters', () => {
    expect(() => UserName.create('a'.repeat(101))).toThrow(UserValidationError);
  });

  it('should count an emoji as one code point', () => {
    const name = '😀'.repeat(100);

    expect(UserName.create(name).value).toBe(name);
    expect(() => UserName.create('😀'.repeat(101))).toThrow(UserValidationError);
  });
});
