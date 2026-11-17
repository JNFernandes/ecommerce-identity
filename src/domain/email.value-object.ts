import { UserValidationError } from './errors/user-validation.error';

/** Maximum email length in characters (standard limit). */
export const EMAIL_MAX_LENGTH = 254;

/** `local@domain.tld`: no whitespace, exactly one `@`, a domain of at least two non-empty labels. */
const EMAIL_FORMAT = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** A normalized email address: trimmed, lowercase, at most 254 characters, `local@domain.tld`. */
export class Email {
  private constructor(
    /** The normalized address. */
    readonly value: string,
  ) {}

  /**
   * Normalizes and validates a raw email.
   *
   * @param raw The address as the client sent it.
   * @returns The normalized email.
   * @throws UserValidationError When the address is too long or badly formed.
   */
  static create(raw: string): Email {
    const value = raw.trim().toLowerCase();
    if ([...value].length > EMAIL_MAX_LENGTH) {
      throw new UserValidationError(`email must be at most ${EMAIL_MAX_LENGTH} characters`);
    }
    if (!EMAIL_FORMAT.test(value)) {
      throw new UserValidationError('email must be a valid email address');
    }
    return new Email(value);
  }
}
