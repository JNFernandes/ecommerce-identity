import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ChangeUserStatusCommand } from '../../src/commands/change-user-status.command';
import { RefreshCommand } from '../../src/commands/refresh.command';
import { Email } from '../../src/domain/email.value-object';
import { InvalidAccessTokenError } from '../../src/domain/errors/invalid-access-token.error';
import { InvalidCredentialsError } from '../../src/domain/errors/invalid-credentials.error';
import { InvalidRefreshTokenError } from '../../src/domain/errors/invalid-refresh-token.error';
import { RefreshToken } from '../../src/domain/refresh-token.aggregate';
import { User } from '../../src/domain/user.aggregate';
import { UserName } from '../../src/domain/user-name.value-object';
import { UserStatus } from '../../src/domain/user-status.enum';
import { UserEntity } from '../../src/infra/database/entities/user.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { CryptoRefreshTokenGenerator } from '../../src/infra/security/crypto-refresh-token-generator';
import { SystemClock } from '../../src/infra/time/system-clock';
import {
  RefreshTokenRepository,
  RefreshTokenTx,
} from '../../src/repositories/refresh-token.repository';
import { UserRepository, UserStatusTx } from '../../src/repositories/user.repository';
import { ChangeUserStatusService } from '../../src/services/change-user-status.service';
import { RefreshService } from '../../src/services/refresh.service';
import { TokenIssuer } from '../../src/services/ports/token-issuer';

jest.setTimeout(180_000);

const HOLD_MS = 400;
const START_DELAY_MS = 100;

/** Resolves after `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Records the order in which concurrent steps happen. */
class Timeline {
  readonly events: string[] = [];

  mark(event: string): void {
    this.events.push(event);
  }
}

/** A refresh token repository whose transactions hold the user share lock for a while. */
class SlowRefreshTokenRepository extends RefreshTokenRepository {
  constructor(
    dataSource: DataSource,
    private readonly timeline: Timeline,
  ) {
    super(dataSource);
  }

  override inTransaction<T>(work: (tx: RefreshTokenTx) => Promise<T>): Promise<T> {
    return super.inTransaction((tx) => {
      const slow: RefreshTokenTx = Object.create(tx) as RefreshTokenTx;
      slow.lockUserForShare = async (userId: string): Promise<void> => {
        await tx.lockUserForShare(userId);
        this.timeline.mark('refresh holds user share lock');
        await pause(HOLD_MS);
      };
      return work(slow).then((result) => {
        this.timeline.mark('refresh committing');
        return result;
      });
    });
  }
}

/** A user repository whose status transactions hold the target row lock for a while. */
class SlowUserRepository extends UserRepository {
  constructor(
    dataSource: DataSource,
    private readonly timeline: Timeline,
  ) {
    super(dataSource.getRepository(UserEntity));
  }

  override inStatusTransaction<T>(work: (tx: UserStatusTx) => Promise<T>): Promise<T> {
    return super.inStatusTransaction((tx) => {
      const slow: UserStatusTx = Object.create(tx) as UserStatusTx;
      slow.findByIdForUpdate = async (id: string): Promise<User | null> => {
        const user = await tx.findByIdForUpdate(id);
        this.timeline.mark('disable holds target row lock');
        await pause(HOLD_MS);
        return user;
      };
      return work(slow).then((result) => {
        this.timeline.mark('disable committing');
        return result;
      });
    });
  }
}

describe('User status change locking (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let users: UserRepository;
  let tokens: RefreshTokenRepository;
  let generator: CryptoRefreshTokenGenerator;
  let admin: User;

  /** A status service whose transactions run through `repository`. */
  function statusService(repository: UserRepository): ChangeUserStatusService {
    return new ChangeUserStatusService(repository, new SystemClock());
  }

  /** A refresh service whose transactions run through `repository`. */
  function refreshService(repository: RefreshTokenRepository): RefreshService {
    const issuer = {
      issue: () => Promise.resolve({ token: 'access-token', expiresIn: 900 }),
    } as unknown as TokenIssuer;
    return new RefreshService(
      repository,
      issuer,
      generator,
      new SystemClock(),
      new ConfigService({ jwt: { refreshTtlSeconds: 604800, sessionMaxSeconds: 2592000 } }),
    );
  }

  /** Saves a new customer, stores a login token for it and returns both with the token value. */
  async function loggedInCustomer(email: string): Promise<{ user: User; value: string }> {
    const user = User.registerCustomer(Email.create(email), UserName.create('Ana'), 'h');
    await users.save(user);
    user.recordLogin(new Date());
    const generated = generator.generate();
    await tokens.saveWithLogin(
      RefreshToken.issue({
        userId: user.id,
        tokenHash: generated.hash,
        issuedAt: new Date(),
        ttlSeconds: 604800,
      }),
      user,
    );
    return { user, value: generated.value };
  }

  /** Counts the refresh tokens of a user that are not revoked. */
  async function liveTokens(userId: string): Promise<number> {
    const [row]: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*) AS "count" FROM "refresh_tokens" WHERE "userId" = $1 AND "revokedAt" IS NULL`,
      [userId],
    );
    return Number(row.count);
  }

  /** Counts every refresh token of a user. */
  async function allTokens(userId: string): Promise<number> {
    const [row]: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*) AS "count" FROM "refresh_tokens" WHERE "userId" = $1`,
      [userId],
    );
    return Number(row.count);
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    dataSource = new DataSource({
      ...buildDataSourceOptions({
        host: container.getHost(),
        port: container.getPort(),
        username: container.getUsername(),
        password: container.getPassword(),
        database: container.getDatabase(),
        migrationsRun: false,
      }),
      poolSize: 10,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    users = new UserRepository(dataSource.getRepository(UserEntity));
    tokens = new RefreshTokenRepository(dataSource);
    generator = new CryptoRefreshTokenGenerator();
    admin = User.registerAdmin(Email.create('admin@example.com'), UserName.create('Admin'), 'h');
    await users.save(admin);
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should make a disable wait for an in-flight refresh, then revoke its successor', async () => {
    const timeline = new Timeline();
    const { user, value } = await loggedInCustomer('refresh-first@example.com');

    const [refreshed] = await Promise.all([
      refreshService(new SlowRefreshTokenRepository(dataSource, timeline)).execute(
        new RefreshCommand(value, undefined),
      ),
      pause(START_DELAY_MS).then(async () => {
        await statusService(users).execute(
          new ChangeUserStatusCommand(user.id, UserStatus.DISABLED, admin.id),
        );
        timeline.mark('disable committed');
      }),
    ]);

    expect(refreshed.refreshToken).not.toBe(value);
    expect(timeline.events).toEqual([
      'refresh holds user share lock',
      'refresh committing',
      'disable committed',
    ]);
    expect(await allTokens(user.id)).toBe(2);
    expect(await liveTokens(user.id)).toBe(0);
  });

  it('should make a refresh wait for an in-flight disable, then refuse it', async () => {
    const timeline = new Timeline();
    const { user, value } = await loggedInCustomer('disable-first@example.com');

    const [, refresh] = await Promise.all([
      statusService(new SlowUserRepository(dataSource, timeline)).execute(
        new ChangeUserStatusCommand(user.id, UserStatus.DISABLED, admin.id),
      ),
      pause(START_DELAY_MS).then(() =>
        refreshService(tokens)
          .execute(new RefreshCommand(value, undefined))
          .then(
            () => 'issued',
            (error: unknown) => error,
          ),
      ),
    ]);

    expect(refresh).toBeInstanceOf(InvalidRefreshTokenError);
    expect(timeline.events).toEqual(['disable holds target row lock', 'disable committing']);
    expect(await allTokens(user.id)).toBe(1);
    expect(await liveTokens(user.id)).toBe(0);
  });

  it('should let exactly one of two admins disabling each other win, 20 times in a row', async () => {
    for (let round = 0; round < 20; round += 1) {
      const first = User.registerAdmin(
        Email.create(`cross-a-${round}@example.com`),
        UserName.create('A'),
        'h',
      );
      const second = User.registerAdmin(
        Email.create(`cross-b-${round}@example.com`),
        UserName.create('B'),
        'h',
      );
      await users.save(first);
      await users.save(second);
      const service = statusService(users);

      const results = await Promise.all(
        [
          new ChangeUserStatusCommand(second.id, UserStatus.DISABLED, first.id),
          new ChangeUserStatusCommand(first.id, UserStatus.DISABLED, second.id),
        ].map((command) =>
          service.execute(command).then(
            () => 'ok' as const,
            (error: unknown) => error,
          ),
        ),
      );

      expect(results.filter((result) => result === 'ok')).toHaveLength(1);
      const [failure] = results.filter((result) => result !== 'ok');
      expect(failure).toBeInstanceOf(InvalidAccessTokenError);
      const statuses = [
        (await users.findById(first.id))?.status,
        (await users.findById(second.id))?.status,
      ].sort();
      expect(statuses).toEqual([UserStatus.ACTIVE, UserStatus.DISABLED]);
    }
  });

  it('should store no token for a login that saves after a concurrent disable commits', async () => {
    const timeline = new Timeline();
    const user = User.registerCustomer(
      Email.create('login-race@example.com'),
      UserName.create('Ana'),
      'h',
    );
    await users.save(user);
    // The login already passed its status check: the user was ACTIVE when it was read.
    user.recordLogin(new Date());
    const token = RefreshToken.issue({
      userId: user.id,
      tokenHash: generator.generate().hash,
      issuedAt: new Date(),
      ttlSeconds: 604800,
    });

    const [, login] = await Promise.all([
      statusService(new SlowUserRepository(dataSource, timeline)).execute(
        new ChangeUserStatusCommand(user.id, UserStatus.DISABLED, admin.id),
      ),
      pause(START_DELAY_MS).then(() =>
        tokens.saveWithLogin(token, user).then(
          () => 'stored',
          (error: unknown) => error,
        ),
      ),
    ]);

    expect(login).toBeInstanceOf(InvalidCredentialsError);
    expect(await allTokens(user.id)).toBe(0);
    expect((await users.findById(user.id))?.lastLoginAt).toBeNull();
  });
});
