import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Email } from '../../src/domain/email.value-object';
import { RefreshToken } from '../../src/domain/refresh-token.aggregate';
import { User } from '../../src/domain/user.aggregate';
import { UserName } from '../../src/domain/user-name.value-object';
import { UserEntity } from '../../src/infra/database/entities/user.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { RefreshTokenRepository } from '../../src/repositories/refresh-token.repository';
import { UserRepository } from '../../src/repositories/user.repository';

jest.setTimeout(180_000);

interface TokenRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

describe('RefreshTokenRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let users: UserRepository;
  let repository: RefreshTokenRepository;

  /** Saves a new customer and returns it. */
  async function savedCustomer(email: string): Promise<User> {
    const user = User.registerCustomer(Email.create(email), UserName.create('Ana'), 'h');
    await users.save(user);
    return user;
  }

  /** Issues a token for the user with the given hash. */
  function tokenFor(user: User, tokenHash: string, issuedAt: Date): RefreshToken {
    return RefreshToken.issue({ userId: user.id, tokenHash, issuedAt, ttlSeconds: 604800 });
  }

  /** Reads the stored `lastLoginAt` of a user. */
  async function lastLoginAt(userId: string): Promise<Date | null> {
    const [row]: { lastLoginAt: Date | null }[] = await dataSource.query(
      `SELECT "lastLoginAt" FROM "users" WHERE "id" = $1`,
      [userId],
    );
    return row.lastLoginAt;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    dataSource = new DataSource(
      buildDataSourceOptions({
        host: container.getHost(),
        port: container.getPort(),
        username: container.getUsername(),
        password: container.getPassword(),
        database: container.getDatabase(),
        migrationsRun: false,
      }),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
    users = new UserRepository(dataSource.getRepository(UserEntity));
    repository = new RefreshTokenRepository(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should store the token and the last login time together', async () => {
    const user = await savedCustomer('ana@example.com');
    const loginAt = new Date('2026-11-17T12:00:00.000Z');
    user.recordLogin(loginAt);
    const token = tokenFor(user, 'a'.repeat(64), loginAt);

    await repository.saveWithLogin(token, user);

    const rows: TokenRow[] = await dataSource.query(
      `SELECT * FROM "refresh_tokens" WHERE "userId" = $1`,
      [user.id],
    );
    expect(rows).toEqual([
      {
        id: token.id,
        userId: user.id,
        familyId: token.familyId,
        tokenHash: 'a'.repeat(64),
        createdAt: loginAt,
        expiresAt: new Date('2026-11-24T12:00:00.000Z'),
        revokedAt: null,
        replacedBy: null,
      },
    ]);
    expect(await lastLoginAt(user.id)).toEqual(loginAt);
  });

  it('should roll back the last login time when the token cannot be stored', async () => {
    const first = await savedCustomer('first@example.com');
    const second = await savedCustomer('second@example.com');
    const hash = 'b'.repeat(64);
    const loginAt = new Date('2026-11-17T13:00:00.000Z');
    first.recordLogin(loginAt);
    await repository.saveWithLogin(tokenFor(first, hash, loginAt), first);
    second.recordLogin(loginAt);

    await expect(
      repository.saveWithLogin(tokenFor(second, hash, loginAt), second),
    ).rejects.toMatchObject({ code: '23505' });

    expect(await lastLoginAt(second.id)).toBeNull();
  });
});
