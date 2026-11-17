import { UserValidationError } from './errors/user-validation.error';

/** Maximum name length in Unicode code points, after trimming. */
export const USER_NAME_MAX_LENGTH = 100;

/** A user's display name: trimmed, 1–100 Unicode code points. */
export class UserName {
  private constructor(
    /** The trimmed name. */
    readonly value: string,
  ) {}

  /**
   * Trims and validates a raw name.
   *
   * @param raw The name as the client sent it.
   * @returns The trimmed name.
   * @throws UserValidationError When the name is empty after trimming or longer than 100 code points.
   */
  static create(raw: string): UserName {
    const value = raw.trim();
    const length = [...value].length;
    if (length === 0) {
      throw new UserValidationError('name must not be empty');
    }
    if (length > USER_NAME_MAX_LENGTH) {
      throw new UserValidationError(`name must be at most ${USER_NAME_MAX_LENGTH} characters`);
    }
    return new UserName(value);
  }
}
