import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RefreshCommand } from '../../../src/commands/refresh.command';
import { Email } from '../../../src/domain/email.value-object';
import {
  InvalidRefreshTokenError,
  RefreshFailureReason,
} from '../../../src/domain/errors/invalid-refresh-token.error';
import { RefreshToken, RefreshTokenProps } from '../../../src/domain/refresh-token.aggregate';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';
import {
  RefreshTokenRepository,
  RefreshTokenTx,
} from '../../../src/repositories/refresh-token.repository';
import { Clock } from '../../../src/services/ports/clock';
import {
  GeneratedRefreshToken,
  RefreshTokenGenerator,
} from '../../../src/services/ports/refresh-token-generator';
import {
  AccessTokenSubject,
  IssuedAccessToken,
  TokenIssuer,
} from '../../../src/services/ports/token-issuer';
import { RefreshService } from '../../../src/services/refresh.service';

const PRESENTED = 'presented-refresh-value';
const PRESENTED_HASH = 'p'.repeat(64);
const NEXT: GeneratedRefreshToken = { value: 'next-refresh-value', hash: 'n'.repeat(64) };
const ACCESS: IssuedAccessToken = { token: 'signed.access.token', expiresIn: 900 };
const LOGIN_AT = new Date('2026-11-01T00:00:00.000Z');
const NOW = new Date('2026-11-05T00:00:00.000Z');
const FAMILY_ID = '0b9d7c1e-3f4a-4c2b-8e6d-5a1f2b3c4d5e';
const IP = '203.0.113.7';
const DAY = 86400;

/** In-memory {@link RefreshTokenTx} that records every call. */
class FakeTx implements RefreshTokenTx {
  readonly calls: string[] = [];
  readonly revoked: { familyId: string; at: Date }[] = [];
  readonly rotations: { rotated: RefreshToken; next: RefreshToken }[] = [];

  constructor(
    private readonly tokens: Map<string, RefreshToken>,
    private readonly users: Map<string, User>,
    private readonly startedAt: Date | null,
  ) {}

  findByHash(hash: string): Promise<RefreshToken | null> {
    this.calls.push('findByHash');
    return Promise.resolve(this.tokens.get(hash) ?? null);
  }

  findByHashForUpdate(hash: string): Promise<RefreshToken | null> {
    this.calls.push('findByHashForUpdate');
    return Promise.resolve(this.tokens.get(hash) ?? null);
  }

  lockFamily(): Promise<void> {
    this.calls.push('lockFamily');
    return Promise.resolve();
  }

  findUserById(id: string): Promise<User | null> {
    this.calls.push('findUserById');
    return Promise.resolve(this.users.get(id) ?? null);
  }

  familyStartedAt(): Promise<Date | null> {
    this.calls.push('familyStartedAt');
    return Promise.resolve(this.startedAt);
  }

  revokeFamily(familyId: string, at: Date): Promise<number> {
    this.calls.push('revokeFamily');
    this.revoked.push({ familyId, at });
    return Promise.resolve(1);
  }

  saveRotation(rotated: RefreshToken, next: RefreshToken): Promise<void> {
    this.calls.push('saveRotation');
    this.rotations.push({ rotated, next });
    return Promise.resolve();
  }
}

/** A customer with the given status. */
function customer(status = UserStatus.ACTIVE): User {
  const registered = User.registerCustomer(
    Email.create('ana@example.com'),
    UserName.create('Ana'),
    'hash',
  );
  return User.restore({
    id: registered.id,
    customerId: registered.customerId,
    email: registered.email,
    name: registered.name,
    passwordHash: 'hash',
    roles: registered.roles,
    status,
    createdAt: registered.createdAt,
    updatedAt: registered.updatedAt,
    lastLoginAt: null,
  });
}

/** A stored token of `user` with the presented hash. */
function storedToken(user: User, overrides: Partial<RefreshTokenProps> = {}): RefreshToken {
  return RefreshToken.restore({
    id: '1d2c3b4a-5e6f-4a1b-9c2d-3e4f5a6b7c8d',
    userId: user.id,
    familyId: FAMILY_ID,
    tokenHash: PRESENTED_HASH,
    createdAt: LOGIN_AT,
    expiresAt: new Date('2026-11-08T00:00:00.000Z'),
    revokedAt: null,
    replacedBy: null,
    ...overrides,
  });
}

describe('RefreshService', () => {
  let user: User;
  let token: RefreshToken | null;
  let startedAt: Date | null;
  let tx: FakeTx;
  let issue: jest.Mock<Promise<IssuedAccessToken>, [AccessTokenSubject, Date]>;
  let generate: jest.Mock<GeneratedRefreshToken, []>;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let sessionMaxSeconds: number;

  /** Builds the service around the current fixtures. */
  function service(): RefreshService {
    const tokens = new Map<string, RefreshToken>();
    if (token !== null) {
      tokens.set(token.tokenHash, token);
    }
    tx = new FakeTx(tokens, new Map([[user.id, user]]), startedAt);
    const repository = {
      inTransaction: <T>(work: (t: RefreshTokenTx) => Promise<T>): Promise<T> => work(tx),
    } as unknown as RefreshTokenRepository;
    return new RefreshService(
      repository,
      { issue } as TokenIssuer,
      {
        generate,
        hash: (value: string) => (value === PRESENTED ? PRESENTED_HASH : 'u'.repeat(64)),
      } as RefreshTokenGenerator,
      { now: () => NOW } as Clock,
      new ConfigService({ jwt: { refreshTtlSeconds: 7 * DAY, sessionMaxSeconds } }),
    );
  }

  const refresh = (value = PRESENTED): Promise<unknown> =>
    service().execute(new RefreshCommand(value, IP));

  beforeEach(() => {
    user = customer();
    token = storedToken(user);
    startedAt = LOGIN_AT;
    sessionMaxSeconds = 30 * DAY;
    issue = jest
      .fn<Promise<IssuedAccessToken>, [AccessTokenSubject, Date]>()
      .mockResolvedValue(ACCESS);
    generate = jest.fn<GeneratedRefreshToken, []>().mockReturnValue(NEXT);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('success', () => {
    it('should return the new tokens in the login shape', async () => {
      await expect(refresh()).resolves.toEqual({
        accessToken: ACCESS.token,
        refreshToken: NEXT.value,
        tokenType: 'Bearer',
        expiresIn: 900,
      });
    });

    it('should take the family lock before locking the token row', async () => {
      await refresh();

      expect(tx.calls.slice(0, 3)).toEqual(['findByHash', 'lockFamily', 'findByHashForUpdate']);
    });

    it('should save the rotation with the successor hash, never the value', async () => {
      await refresh();

      expect(tx.rotations).toHaveLength(1);
      const { rotated, next } = tx.rotations[0];
      expect(rotated.revokedAt).toEqual(NOW);
      expect(rotated.replacedBy).toBe(next.id);
      expect(next.familyId).toBe(FAMILY_ID);
      expect(next.userId).toBe(user.id);
      expect(next.tokenHash).toBe(NEXT.hash);
      expect(next.createdAt).toEqual(NOW);
      expect(JSON.stringify(next)).not.toContain(NEXT.value);
      expect(tx.revoked).toEqual([]);
    });

    it('should pass the current roles and customerId to the issuer', async () => {
      await refresh();

      expect(issue).toHaveBeenCalledWith(
        { userId: user.id, customerId: user.customerId, roles: [Role.CUSTOMER] },
        NOW,
      );
    });

    it('should expire the successor after the refresh lifetime when far from the session end', async () => {
      await refresh();

      expect(tx.rotations[0].next.expiresAt).toEqual(new Date('2026-11-12T00:00:00.000Z'));
    });

    it('should log the success with ids and IP only', async () => {
      await refresh();

      expect(log).toHaveBeenCalledWith(
        `refresh succeeded: userId=${user.id} familyId=${FAMILY_ID} ip=${IP}`,
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });

  /** Runs a refresh expected to fail and returns the error's reason. */
  async function refusalReason(value = PRESENTED): Promise<RefreshFailureReason> {
    const error: unknown = await refresh(value).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidRefreshTokenError);
    return (error as InvalidRefreshTokenError).reason;
  }

  /** Asserts that nothing was issued or stored. */
  function expectNothingIssued(): void {
    expect(issue).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(tx.rotations).toEqual([]);
  }

  /** Every logged line, for secret checks. */
  function loggedLines(): string {
    return JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
  }

  describe('reuse', () => {
    it('should revoke the family, then refuse a used token as REUSED without issuing', async () => {
      token = storedToken(user, { revokedAt: new Date('2026-11-04T00:00:00.000Z') });

      await expect(refusalReason()).resolves.toBe(RefreshFailureReason.REUSED);

      expect(tx.revoked).toEqual([{ familyId: FAMILY_ID, at: NOW }]);
      expectNothingIssued();
    });

    it('should treat an expired and revoked token as REUSED and revoke the family', async () => {
      token = storedToken(user, {
        expiresAt: new Date('2026-11-04T00:00:00.000Z'),
        revokedAt: new Date('2026-11-03T00:00:00.000Z'),
      });

      await expect(refusalReason()).resolves.toBe(RefreshFailureReason.REUSED);

      expect(tx.revoked).toEqual([{ familyId: FAMILY_ID, at: NOW }]);
      expectNothingIssued();
    });

    it('should log the reuse with ids and IP, never the token or its hash', async () => {
      token = storedToken(user, { revokedAt: new Date('2026-11-04T00:00:00.000Z') });

      await refusalReason();

      expect(warn).toHaveBeenCalledWith(
        `refresh token reuse detected: userId=${user.id} familyId=${FAMILY_ID} ip=${IP}`,
      );
      expect(loggedLines()).not.toContain(PRESENTED);
      expect(loggedLines()).not.toContain(PRESENTED_HASH);
    });
  });

  describe('refusals', () => {
    it('should refuse an unknown hash as UNKNOWN without locking or revoking', async () => {
      await expect(refusalReason('never-issued')).resolves.toBe(RefreshFailureReason.UNKNOWN);

      expect(tx.calls).toEqual(['findByHash']);
      expect(tx.revoked).toEqual([]);
      expectNothingIssued();
    });

    it('should refuse an expired, unused token as EXPIRED without revoking the family', async () => {
      token = storedToken(user, { expiresAt: new Date('2026-11-04T00:00:00.000Z') });

      await expect(refusalReason()).resolves.toBe(RefreshFailureReason.EXPIRED);

      expect(tx.revoked).toEqual([]);
      expectNothingIssued();
    });

    it('should revoke the family, then refuse a token of a disabled user as INACTIVE_USER', async () => {
      user = customer(UserStatus.DISABLED);
      token = storedToken(user);

      await expect(refusalReason()).resolves.toBe(RefreshFailureReason.INACTIVE_USER);

      expect(tx.revoked).toEqual([{ familyId: FAMILY_ID, at: NOW }]);
      expectNothingIssued();
    });

    it.each([
      ['unknown', 'never-issued', RefreshFailureReason.UNKNOWN],
      ['presented', PRESENTED, RefreshFailureReason.EXPIRED],
    ])(
      'should log the refusal reason for an %s token without the token or its hash',
      async (_case, value, reason) => {
        token = storedToken(user, { expiresAt: new Date('2026-11-04T00:00:00.000Z') });

        await refusalReason(value);

        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`refresh refused: reason=${reason}`),
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`ip=${IP}`));
        expect(loggedLines()).not.toContain(value);
        expect(loggedLines()).not.toContain(PRESENTED_HASH);
        expect(log).not.toHaveBeenCalled();
      },
    );
  });
});
