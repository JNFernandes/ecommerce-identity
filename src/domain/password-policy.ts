import { Email } from './email.value-object';
import { UserValidationError } from './errors/user-validation.error';

/** Minimum password length in Unicode code points. */
export const PASSWORD_MIN_LENGTH = 10;

/** Maximum password length in Unicode code points. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Rules a new password must meet. The password is never trimmed or changed, and error messages
 * never contain it.
 */
export class PasswordPolicy {
  /**
   * Checks a plain password against the policy.
   *
   * @param password The plain password, exactly as sent.
   * @param email The account's normalized email.
   * @throws UserValidationError When the password is outside 10–128 code points or equals the
   * email (case-insensitive, ignoring surrounding whitespace).
   */
  static assertAcceptable(password: string, email: Email): void {
    const length = [...password].length;
    if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
      throw new UserValidationError(
        `password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
      );
    }
    if (password.trim().toLowerCase() === email.value) {
      throw new UserValidationError('password must not be the same as the email');
    }
  }
}
