import { DuplicateEmailError } from '../../../src/domain/errors/duplicate-email.error';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../src/domain/errors/invalid-access-token.error';
import { InvalidCredentialsError } from '../../../src/domain/errors/invalid-credentials.error';
import {
  InvalidRefreshTokenError,
  RefreshFailureReason,
} from '../../../src/domain/errors/invalid-refresh-token.error';
import { UserNotFoundError } from '../../../src/domain/errors/user-not-found.error';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { Role } from '../../../src/domain/role.enum';
import { UserStatus } from '../../../src/domain/user-status.enum';

describe('domain errors', () => {
  it('should create a UserNotFoundError with a fixed message', () => {
    const error = new UserNotFoundError();

    expect(error).toBeInstanceOf(UserNotFoundError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UserNotFoundError');
    expect(error.message).toBe('user not found');
  });

  it.each(Object.values(AccessTokenFailureReason))(
    'should use the same fixed message and keep the reason in an InvalidAccessTokenError for %s',
    (reason) => {
      const error = new InvalidAccessTokenError(reason);

      expect(error).toBeInstanceOf(InvalidAccessTokenError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('InvalidAccessTokenError');
      expect(error.message).toBe('unauthorized');
      expect(error.reason).toBe(reason);
    },
  );

  it('should define the eleven access token failure reasons', () => {
    expect(Object.values(AccessTokenFailureReason)).toHaveLength(11);
  });

  it.each(Object.values(RefreshFailureReason))(
    'should use the same fixed message and keep the reason in an InvalidRefreshTokenError for %s',
    (reason) => {
      const error = new InvalidRefreshTokenError(reason);

      expect(error).toBeInstanceOf(InvalidRefreshTokenError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('InvalidRefreshTokenError');
      expect(error.message).toBe('invalid refresh token');
      expect(error.reason).toBe(reason);
    },
  );

  it('should carry the given message in a UserValidationError', () => {
    const error = new UserValidationError('invalid email');

    expect(error).toBeInstanceOf(UserValidationError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UserValidationError');
    expect(error.message).toBe('invalid email');
  });

  it('should use the fixed message in a DuplicateEmailError', () => {
    const error = new DuplicateEmailError();

    expect(error).toBeInstanceOf(DuplicateEmailError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DuplicateEmailError');
    expect(error.message).toBe('email already registered');
  });

  it('should use the fixed message in an InvalidCredentialsError', () => {
    const error = new InvalidCredentialsError();

    expect(error).toBeInstanceOf(InvalidCredentialsError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InvalidCredentialsError');
    expect(error.message).toBe('invalid credentials');
  });
});

describe('domain enums', () => {
  it('should define the CUSTOMER and ADMIN roles', () => {
    expect(Object.values(Role)).toEqual(['CUSTOMER', 'ADMIN']);
  });

  it('should define the ACTIVE and DISABLED statuses', () => {
    expect(Object.values(UserStatus)).toEqual(['ACTIVE', 'DISABLED']);
  });
});
