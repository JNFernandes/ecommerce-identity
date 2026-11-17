import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoginCommand } from '../../../src/commands/login.command';
import { Email } from '../../../src/domain/email.value-object';
import { RefreshToken } from '../../../src/domain/refresh-token.aggregate';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
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
});
