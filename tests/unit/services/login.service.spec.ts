import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoginCommand } from '../../../src/commands/login.command';
import { Email } from '../../../src/domain/email.value-object';
import { InvalidCredentialsError } from '../../../src/domain/errors/invalid-credentials.error';
import { RefreshToken } from '../../../src/domain/refresh-token.aggregate';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { RefreshTokenRepository } from '../../../src/repositories/refresh-token.repository';
import { UserRepository } from '../../../src/repositories/user.repository';
import { LoginService } from '../../../src/services/login.service';
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

const PASSWORD = 'correct-horse-battery';
const USER_HASH = '$argon2id$v=19$m=1024,t=2,p=1$user$digest';
const DUMMY_HASH = '$argon2id$v=19$m=1024,t=2,p=1$dummy$digest';
const NOW = new Date('2026-11-17T12:00:00.000Z');
const REFRESH: GeneratedRefreshToken = { value: 'clear-refresh-value', hash: 'f'.repeat(64) };
const ACCESS: IssuedAccessToken = { token: 'signed.access.token', expiresIn: 900 };

describe('LoginService', () => {
  let user: User;
  let findByEmail: jest.Mock<Promise<User | null>, [string]>;
  let saveWithLogin: jest.Mock<Promise<void>, [RefreshToken, User]>;
  let verify: jest.Mock<Promise<boolean>, [string, string]>;
  let dummyHash: jest.Mock<string, []>;
  let issue: jest.Mock<Promise<IssuedAccessToken>, [AccessTokenSubject, Date]>;
  let generate: jest.Mock<GeneratedRefreshToken, []>;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let service: LoginService;

  const command = (email = ' Ana@Example.com ', password = PASSWORD): LoginCommand =>
    new LoginCommand(email, password, '203.0.113.7');

  beforeEach(() => {
    user = User.registerCustomer(
      Email.create('ana@example.com'),
      UserName.create('Ana'),
      USER_HASH,
    );
    findByEmail = jest.fn<Promise<User | null>, [string]>().mockResolvedValue(user);
    saveWithLogin = jest.fn<Promise<void>, [RefreshToken, User]>().mockResolvedValue(undefined);
    verify = jest.fn<Promise<boolean>, [string, string]>().mockResolvedValue(true);
    dummyHash = jest.fn<string, []>().mockReturnValue(DUMMY_HASH);
    issue = jest
      .fn<Promise<IssuedAccessToken>, [AccessTokenSubject, Date]>()
      .mockResolvedValue(ACCESS);
    generate = jest.fn<GeneratedRefreshToken, []>().mockReturnValue(REFRESH);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    service = new LoginService(
      { findByEmail } as unknown as UserRepository,
      { saveWithLogin } as unknown as RefreshTokenRepository,
      { hash: jest.fn(), verify, dummyHash } as PasswordHasher,
      { issue } as TokenIssuer,
      { generate, hash: jest.fn() } as RefreshTokenGenerator,
      { now: () => NOW } as Clock,
      new ConfigService({ jwt: { refreshTtlSeconds: 604800 } }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return both tokens as a Bearer result', async () => {
    await expect(service.execute(command())).resolves.toEqual({
      accessToken: ACCESS.token,
      refreshToken: REFRESH.value,
      tokenType: 'Bearer',
      expiresIn: 900,
    });
  });

  it('should look the user up by the normalized email and verify the given password', async () => {
    await service.execute(command());

    expect(findByEmail).toHaveBeenCalledWith('ana@example.com');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(PASSWORD, USER_HASH);
  });

  it('should pass the stored customerId and roles to the issuer at the login time', async () => {
    await service.execute(command());

    expect(issue).toHaveBeenCalledWith(
      { userId: user.id, customerId: user.customerId, roles: [Role.CUSTOMER] },
      NOW,
    );
  });

  it('should store the refresh token hash, never the value, with the login', async () => {
    await service.execute(command());

    expect(saveWithLogin).toHaveBeenCalledTimes(1);
    const [token, saved] = saveWithLogin.mock.calls[0];
    expect(token.tokenHash).toBe(REFRESH.hash);
    expect(token.userId).toBe(user.id);
    expect(token.createdAt).toEqual(NOW);
    expect(token.expiresAt).toEqual(new Date('2026-11-24T12:00:00.000Z'));
    expect(JSON.stringify(token)).not.toContain(REFRESH.value);
    expect(saved).toBe(user);
    expect(saved.lastLoginAt).toEqual(NOW);
  });

  it('should log the success with the user id and IP only', async () => {
    await service.execute(command());

    expect(log).toHaveBeenCalledWith(`login succeeded: userId=${user.id} ip=203.0.113.7`);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(REFRESH.value);
    expect(logged).not.toContain(ACCESS.token);
    expect(logged).not.toContain('ana@example.com');
  });

  describe('failures', () => {
    /** A stored user with the given status. */
    function storedUser(status: UserStatus): User {
      return User.restore({
        id: user.id,
        customerId: user.customerId,
        email: user.email,
        name: user.name,
        passwordHash: USER_HASH,
        roles: user.roles,
        status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: null,
      });
    }

    /** Asserts nothing was issued or stored. */
    function expectNothingIssued(): void {
      expect(issue).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(saveWithLogin).not.toHaveBeenCalled();
    }

    it('should verify once against the dummy hash for an unknown email', async () => {
      findByEmail.mockResolvedValue(null);
      verify.mockResolvedValue(false);

      await expect(service.execute(command())).rejects.toBeInstanceOf(InvalidCredentialsError);

      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledWith(PASSWORD, DUMMY_HASH);
      expectNothingIssued();
      expect(warn).toHaveBeenCalledWith('login failed: reason=unknown_email ip=203.0.113.7');
    });

    it('should refuse a wrong password after one verification', async () => {
      verify.mockResolvedValue(false);

      await expect(service.execute(command())).rejects.toBeInstanceOf(InvalidCredentialsError);

      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledWith(PASSWORD, USER_HASH);
      expect(dummyHash).not.toHaveBeenCalled();
      expectNothingIssued();
      expect(warn).toHaveBeenCalledWith(
        `login failed: reason=wrong_password userId=${user.id} ip=203.0.113.7`,
      );
    });

    it('should refuse a disabled user after one verification, even with the right password', async () => {
      const disabled = storedUser(UserStatus.DISABLED);
      findByEmail.mockResolvedValue(disabled);

      await expect(service.execute(command())).rejects.toBeInstanceOf(InvalidCredentialsError);

      expect(verify).toHaveBeenCalledTimes(1);
      expect(disabled.lastLoginAt).toBeNull();
      expectNothingIssued();
      expect(warn).toHaveBeenCalledWith(
        `login failed: reason=inactive userId=${user.id} ip=203.0.113.7`,
      );
    });

    it('should raise the same error for every failure', async () => {
      const errors: unknown[] = [];
      findByEmail.mockResolvedValueOnce(null);
      verify.mockResolvedValueOnce(false);
      errors.push(await service.execute(command()).catch((caught: unknown) => caught));
      verify.mockResolvedValueOnce(false);
      errors.push(await service.execute(command()).catch((caught: unknown) => caught));
      findByEmail.mockResolvedValueOnce(storedUser(UserStatus.DISABLED));
      errors.push(await service.execute(command()).catch((caught: unknown) => caught));

      for (const error of errors) {
        expect(error).toBeInstanceOf(InvalidCredentialsError);
        expect((error as Error).message).toBe('invalid credentials');
      }
    });

    it('should never log the email, password or hash on failure', async () => {
      verify.mockResolvedValue(false);

      await service.execute(command()).catch(() => undefined);

      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('ana@example.com');
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain(USER_HASH);
    });

    it('should propagate a repository error unchanged', async () => {
      const failure = new Error('database down');
      findByEmail.mockRejectedValue(failure);

      await expect(service.execute(command())).rejects.toBe(failure);
      expect(verify).not.toHaveBeenCalled();
    });
  });
});
