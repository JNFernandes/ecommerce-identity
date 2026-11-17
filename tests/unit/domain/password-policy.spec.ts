import { Email } from '../../../src/domain/email.value-object';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { PasswordPolicy } from '../../../src/domain/password-policy';

describe('PasswordPolicy', () => {
  const email = Email.create('ana.silva@example.com');

  it.each([10, 128])('should accept %i characters', (length) => {
    expect(() => PasswordPolicy.assertAcceptable('p'.repeat(length), email)).not.toThrow();
  });

  it.each([9, 129])('should reject %i characters', (length) => {
    expect(() => PasswordPolicy.assertAcceptable('p'.repeat(length), email)).toThrow(
      UserValidationError,
    );
  });

  it('should not trim the password before counting', () => {
    expect(() => PasswordPolicy.assertAcceptable(' 12345678 ', email)).not.toThrow();
  });

  it('should count code points, not UTF-16 units', () => {
    expect(() => PasswordPolicy.assertAcceptable('😀'.repeat(9), email)).toThrow(
      UserValidationError,
    );
    expect(() => PasswordPolicy.assertAcceptable('😀'.repeat(128), email)).not.toThrow();
  });

  it.each(['ana.silva@example.com', 'ANA.Silva@Example.COM', '  ana.silva@example.com  '])(
    'should reject a password equal to the email: %p',
    (password) => {
      expect(() => PasswordPolicy.assertAcceptable(password, email)).toThrow(UserValidationError);
    },
  );

  it('should never put the password in the error message', () => {
    const password = 'short';

    expect(() => PasswordPolicy.assertAcceptable(password, email)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(password) }),
    );
  });
});
