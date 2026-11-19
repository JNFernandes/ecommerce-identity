import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChangePasswordCommand } from '../../../src/commands/change-password.command';
import { Email } from '../../../src/domain/email.value-object';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../src/domain/errors/invalid-access-token.error';
import { InvalidCredentialsError } from '../../../src/domain/errors/invalid-credentials.error';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { RefreshToken } from '../../../src/domain/refresh-token.aggregate';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { PasswordChangeTx, UserRepository } from '../../../src/repositories/user.repository';
import { ChangePasswordService } from '../../../src/services/change-password.service';
import { Clock } from '../../../src/services/ports/clock';
import { PasswordHasher } from '../../../src/services/ports/password-hasher';
import {
  GeneratedRefreshToken,
  RefreshTokenGenerator,
} from '../../../src/services/ports/refresh-token-generator';
import {
  AccessTokenSubject,
  IssuedAccessToken,
  TokenIssuer,
} from '../../../src/services/ports/token-issuer';

const CURRENT = 'correct-horse-battery';
const NEW = 'brand-new-passphrase';
const OLD_HASH = '$argon2id$v=19$m=1024,t=2,p=1$old$digest';
const NEW_HASH = '$argon2id$v=19$m=1024,t=2,p=1$new$digest';
const NOW = new Date('2026-11-19T12:00:00.000Z');
const REFRESH: GeneratedRefreshToken = { value: 'clear-refresh-value', hash: 'f'.repeat(64) };
const ACCESS: IssuedAccessToken = { token: 'signed.access.token', expiresIn: 900 };

/** A stored user with the old hash. */
function storedUser(status = UserStatus.ACTIVE, roles: Role[] = [Role.CUSTOMER]): User {
  const registered = User.registerCustomer(
    Email.create('ana@example.com'),
    UserName.create('Ana'),
    OLD_HASH,
  );
  return User.restore({
    id: registered.id,
    customerId: registered.customerId,
    email: registered.email,
    name: registered.name,
    passwordHash: OLD_HASH,
    roles,
    status,
    createdAt: registered.createdAt,
    updatedAt: registered.updatedAt,
    lastLoginAt: null,
  });
}

describe('ChangePasswordService', () => {
  let user: User;
  let lockedUser: User | null;
  let findById: jest.Mock<Promise<User | null>, [string]>;
  let inTx: jest.Mock;
  let tx: jest.Mocked<PasswordChangeTx>;
  let verify: jest.Mock<Promise<boolean>, [string, string]>;
  let hash: jest.Mock<Promise<string>, [string]>;
  let issue: jest.Mock<Promise<IssuedAccessToken>, [AccessTokenSubject, Date]>;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let service: ChangePasswordService;

  const command = (current = CURRENT, next = NEW, userId = user.id): ChangePasswordCommand =>
    new ChangePasswordCommand(userId, current, next);

  beforeEach(() => {
    user = storedUser();
    lockedUser = user;
    findById = jest
      .fn<Promise<User | null>, [string]>()
      .mockImplementation(() => Promise.resolve(user));
    tx = {
      findByIdForUpdate: jest.fn().mockImplementation(() => Promise.resolve(lockedUser)),
      savePasswordHash: jest.fn().mockResolvedValue(undefined),
      revokeAllRefreshTokens: jest.fn().mockResolvedValue(2),
      insertRefreshToken: jest.fn().mockResolvedValue(undefined),
    };
    inTx = jest.fn((work: (t: PasswordChangeTx) => Promise<unknown>) => work(tx));
    verify = jest
      .fn<Promise<boolean>, [string, string]>()
      .mockImplementation((plain) => Promise.resolve(plain === CURRENT));
    hash = jest.fn<Promise<string>, [string]>().mockResolvedValue(NEW_HASH);
    issue = jest
      .fn<Promise<IssuedAccessToken>, [AccessTokenSubject, Date]>()
      .mockResolvedValue(ACCESS);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    service = new ChangePasswordService(
      { findById, inPasswordChangeTransaction: inTx } as unknown as UserRepository,
      { hash, verify, dummyHash: jest.fn() } as PasswordHasher,
      { issue } as TokenIssuer,
      { generate: () => REFRESH, hash: jest.fn() } as RefreshTokenGenerator,
      { now: () => NOW } as Clock,
      new ConfigService({ jwt: { refreshTtlSeconds: 604800 } }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return a new token pair in the login shape', async () => {
    await expect(service.execute(command())).resolves.toEqual({
      accessToken: ACCESS.token,
      refreshToken: REFRESH.value,
      tokenType: 'Bearer',
      expiresIn: ACCESS.expiresIn,
    });
  });

  it('should verify the current password once against the stored hash', async () => {
    await service.execute(command());

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(CURRENT, OLD_HASH);
    expect(hash).toHaveBeenCalledWith(NEW);
  });

  it('should lock, store the hash, revoke every token and insert the new one, in order', async () => {
    await service.execute(command());

    const order = [
      tx.findByIdForUpdate.mock.invocationCallOrder[0],
      tx.savePasswordHash.mock.invocationCallOrder[0],
      tx.revokeAllRefreshTokens.mock.invocationCallOrder[0],
      tx.insertRefreshToken.mock.invocationCallOrder[0],
      issue.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const saved = tx.savePasswordHash.mock.calls[0][0];
    expect(saved.passwordHash).toBe(NEW_HASH);
    expect(saved.updatedAt).toEqual(NOW);
    expect(tx.revokeAllRefreshTokens).toHaveBeenCalledWith(user.id, NOW);
    const token: RefreshToken = tx.insertRefreshToken.mock.calls[0][0];
    expect(token.userId).toBe(user.id);
    expect(token.tokenHash).toBe(REFRESH.hash);
    expect(token.revokedAt).toBeNull();
  });

  it('should sign the access token with the stored roles and customerId', async () => {
    user = storedUser(UserStatus.ACTIVE, [Role.CUSTOMER, Role.ADMIN]);
    lockedUser = user;

    await service.execute(command());

    expect(issue).toHaveBeenCalledWith(
      { userId: user.id, customerId: user.customerId, roles: [Role.CUSTOMER, Role.ADMIN] },
      NOW,
    );
  });

  it('should log the change once with the user id and no secret', async () => {
    await service.execute(command());

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(`password changed: userId=${user.id} sessionsRevoked=2`);
  });

  describe('refusals change nothing', () => {
    /** One refusal: what the store returns as caller, the passwords sent, the expected error. */
    type Refusal = [
      string,
      'missing' | UserStatus,
      string,
      string,
      new (...args: never[]) => Error,
    ];

    it.each<Refusal>([
      ['a missing caller', 'missing', CURRENT, NEW, InvalidAccessTokenError],
      ['a disabled caller', UserStatus.DISABLED, CURRENT, NEW, InvalidAccessTokenError],
      [
        'a wrong current password',
        UserStatus.ACTIVE,
        'wrong-password!',
        NEW,
        InvalidCredentialsError,
      ],
      ['a too short new password', UserStatus.ACTIVE, CURRENT, 'short', UserValidationError],
      ['a too long new password', UserStatus.ACTIVE, CURRENT, 'x'.repeat(129), UserValidationError],
      [
        'the email as new password',
        UserStatus.ACTIVE,
        CURRENT,
        ' ANA@example.com ',
        UserValidationError,
      ],
      [
        'the current password as new password',
        UserStatus.ACTIVE,
        CURRENT,
        CURRENT,
        UserValidationError,
      ],
    ])('should refuse %s before any write', async (_label, caller, current, next, error) => {
      const id = user.id;
      findById.mockResolvedValue(caller === 'missing' ? null : storedUser(caller));

      await expect(service.execute(command(current, next, id))).rejects.toBeInstanceOf(error);

      expect(hash).not.toHaveBeenCalled();
      expect(inTx).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('should use the US-05 reason for an unavailable caller', async () => {
      user = storedUser(UserStatus.DISABLED);

      await expect(service.execute(command())).rejects.toMatchObject({
        reason: AccessTokenFailureReason.USER_UNAVAILABLE,
      });
    });

    it('should check the current password before the new password policy', async () => {
      await expect(service.execute(command('wrong-password!', 'short'))).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    });

    it('should log a wrong current password with the user id only', async () => {
      await expect(service.execute(command('wrong-password!'))).rejects.toThrow();

      expect(warn).toHaveBeenCalledWith(
        `password change refused: reason=wrong_current_password userId=${user.id}`,
      );
    });
  });

  describe('inside the transaction', () => {
    it.each<[string, () => void]>([
      ['the caller was deleted', (): void => void (lockedUser = null)],
      ['the caller was disabled', (): void => void (lockedUser = storedUser(UserStatus.DISABLED))],
    ])('should refuse with 401 and write nothing when %s', async (_label, arrange) => {
      arrange();

      await expect(service.execute(command())).rejects.toBeInstanceOf(InvalidAccessTokenError);

      expect(tx.savePasswordHash).not.toHaveBeenCalled();
      expect(tx.revokeAllRefreshTokens).not.toHaveBeenCalled();
      expect(tx.insertRefreshToken).not.toHaveBeenCalled();
    });

    it('should refuse when another change committed after the check', async () => {
      lockedUser = User.restore({
        id: user.id,
        customerId: user.customerId,
        email: user.email,
        name: user.name,
        passwordHash: 'another-hash',
        roles: user.roles,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: null,
      });

      await expect(service.execute(command())).rejects.toBeInstanceOf(InvalidCredentialsError);

      expect(tx.savePasswordHash).not.toHaveBeenCalled();
    });

    it('should propagate a signing failure so the transaction rolls back', async () => {
      issue.mockRejectedValue(new Error('signing failed'));

      await expect(service.execute(command())).rejects.toThrow('signing failed');

      expect(log).not.toHaveBeenCalled();
    });
  });
});
