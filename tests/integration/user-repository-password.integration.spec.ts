import { createHash, randomBytes } from 'node:crypto';
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

const OLD_HASH = '$argon2id$v=19$m=1024,t=2,p=1$b2xkc2FsdA$b2xkaGFzaA';
const NEW_HASH = '$argon2id$v=19$m=1024,t=2,p=1$bmV3c2FsdA$bmV3aGFzaA';
const AT = new Date('2026-11-19T12:00:00.000Z');

interface TokenRow {
  id: string;
  familyId: string;
  revokedAt: Date | null;
}

/** A token issued now for the user, with a random hash. */
function tokenFor(userId: string, issuedAt = new Date()): RefreshToken {
  return RefreshToken.issue({
    userId,
    tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    issuedAt,
    ttlSeconds: 3600,
  });
}

describe('UserRepository.inPasswordChangeTransaction (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let users: UserRepository;
  let refreshTokens: RefreshTokenRepository;

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
    refreshTokens = new RefreshTokenRepository(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  /** Stores a customer with the old hash and two sessions (two families). */
  async function userWithTwoSessions(email: string): Promise<User> {
    const user = User.registerCustomer(Email.create(email), UserName.create('Ana'), OLD_HASH);
    await users.save(user);
    user.recordLogin(new Date());
    await refreshTokens.saveWithLogin(tokenFor(user.id), user);
    await refreshTokens.saveWithLogin(tokenFor(user.id), user);
    return user;
  }

  function tokensOf(userId: string): Promise<TokenRow[]> {
    return dataSource.query(
      `SELECT "id", "familyId", "revokedAt" FROM "refresh_tokens" WHERE "userId" = $1`,
      [userId],
    );
  }

  /** The documented work order: lock → hash → revoke all → insert. */
  function change(user: User, next: RefreshToken, fail = false): Promise<number> {
    return users.inPasswordChangeTransaction(async (tx) => {
      const locked = await tx.findByIdForUpdate(user.id);
      if (locked === null) {
        throw new Error('user missing');
      }
      await tx.savePasswordHash(locked.changePassword(NEW_HASH, AT));
      const revoked = await tx.revokeAllRefreshTokens(user.id, AT);
      await tx.insertRefreshToken(next);
      if (fail) {
        throw new Error('boom');
      }
      return revoked;
    });
  }

  it('should store the new hash, revoke every prior token and keep the new one active', async () => {
    const user = await userWithTwoSessions('change@example.com');
    const next = tokenFor(user.id);

    const revoked = await change(user, next);

    const stored = await users.findById(user.id);
    const rows = await tokensOf(user.id);
    expect(revoked).toBe(2);
    expect(stored?.passwordHash).toBe(NEW_HASH);
    expect(stored?.updatedAt).toEqual(AT);
    expect(stored?.roles).toEqual(user.roles);
    expect(stored?.status).toBe(user.status);
    expect(stored?.customerId).toBe(user.customerId);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.revokedAt === null).map((row) => row.id)).toEqual([next.id]);
    expect(new Set(rows.map((row) => row.familyId)).size).toBe(3);
  });

  it('should not touch the tokens of other users', async () => {
    const user = await userWithTwoSessions('owner@example.com');
    const other = await userWithTwoSessions('bystander@example.com');

    await change(user, tokenFor(user.id));

    expect((await tokensOf(other.id)).every((row) => row.revokedAt === null)).toBe(true);
  });

  it('should roll back the hash, the revocations and the new token when the work fails', async () => {
    const user = await userWithTwoSessions('rollback@example.com');
    const next = tokenFor(user.id);

    await expect(change(user, next, true)).rejects.toThrow('boom');

    const rows = await tokensOf(user.id);
    expect((await users.findById(user.id))?.passwordHash).toBe(OLD_HASH);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt === null)).toBe(true);
  });
});
