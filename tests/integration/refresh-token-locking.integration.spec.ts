import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Email } from '../../src/domain/email.value-object';
import { RefreshToken } from '../../src/domain/refresh-token.aggregate';
import { User } from '../../src/domain/user.aggregate';
import { UserName } from '../../src/domain/user-name.value-object';
import { UserEntity } from '../../src/infra/database/entities/user.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import {
  RefreshTokenRepository,
  RefreshTokenTx,
} from '../../src/repositories/refresh-token.repository';
import { UserRepository } from '../../src/repositories/user.repository';

jest.setTimeout(180_000);

const LOGIN_AT = new Date('2026-11-18T10:00:00.000Z');
const NOW = new Date('2026-11-18T10:05:00.000Z');
const EXPIRES_AT = new Date('2026-11-25T10:00:00.000Z');

/** Resolves after `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A random 64-hex-character hash. */
const newHash = (): string => randomBytes(32).toString('hex');

describe('RefreshTokenRepository locking (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let users: UserRepository;
  let repository: RefreshTokenRepository;

  /** Stores a login token for a new customer. */
  async function loginToken(email: string): Promise<RefreshToken> {
    const user = User.registerCustomer(Email.create(email), UserName.create('Ana'), 'h');
    await users.save(user);
    user.recordLogin(LOGIN_AT);
    const token = RefreshToken.issue({
      userId: user.id,
      tokenHash: newHash(),
      issuedAt: LOGIN_AT,
      ttlSeconds: 604800,
    });
    await repository.saveWithLogin(token, user);
    return token;
  }

  /**
   * Rotates the token with the given hash using the production lock order, holding the locks for
   * `holdMs` before saving. Returns the successor, or `null` when the token is no longer usable.
   */
  async function rotate(
    tx: RefreshTokenTx,
    hash: string,
    holdMs = 0,
  ): Promise<RefreshToken | null> {
    const found = await tx.findByHash(hash);
    if (found === null) {
      return null;
    }
    await tx.lockFamily(found.familyId);
    const locked = await tx.findByHashForUpdate(hash);
    if (locked === null || !locked.isUsable(NOW)) {
      return null;
    }
    const next = RefreshToken.issueInFamily({
      userId: locked.userId,
      familyId: locked.familyId,
      tokenHash: newHash(),
      issuedAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    locked.rotate(next.id, NOW);
    await pause(holdMs);
    await tx.saveRotation(locked, next);
    return next;
  }

  /** Revokes the family of the token with the given hash using the production lock order. */
  async function revokeFamilyOf(tx: RefreshTokenTx, hash: string): Promise<number> {
    const found = await tx.findByHash(hash);
    if (found === null) {
      return 0;
    }
    await tx.lockFamily(found.familyId);
    await tx.findByHashForUpdate(hash);
    return tx.revokeFamily(found.familyId, NOW);
  }

  /** Counts the tokens of a family that are still live (not revoked). */
  async function liveTokens(familyId: string): Promise<number> {
    const [row]: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*) AS "count" FROM "refresh_tokens"
       WHERE "familyId" = $1 AND "revokedAt" IS NULL`,
      [familyId],
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
    repository = new RefreshTokenRepository(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should let only one of two concurrent rotations of the same token succeed', async () => {
    const token = await loginToken('race@example.com');

    const results = await Promise.all([
      repository.inTransaction((tx) => rotate(tx, token.tokenHash, 200)),
      repository.inTransaction((tx) => rotate(tx, token.tokenHash, 200)),
    ]);

    expect(results.filter((next) => next !== null)).toHaveLength(1);
    expect(await liveTokens(token.familyId)).toBe(1);
  });

  it('should leave no live token when a reuse races the rotation of the newest token', async () => {
    const original = await loginToken('reuse-race@example.com');
    const newest = await repository.inTransaction((tx) => rotate(tx, original.tokenHash));
    if (newest === null) {
      throw new Error('setup rotation failed');
    }

    const [rotated, revoked] = await Promise.all([
      repository.inTransaction((tx) => rotate(tx, newest.tokenHash, 300)),
      pause(50).then(() =>
        repository.inTransaction((tx) => revokeFamilyOf(tx, original.tokenHash)),
      ),
    ]);

    expect(rotated).not.toBeNull();
    expect(revoked).toBe(1);
    expect(await liveTokens(original.familyId)).toBe(0);
  });

  it('should leave no live token when a logout races the rotation of the newest token', async () => {
    const token = await loginToken('logout-race@example.com');

    const [rotated, revoked] = await Promise.all([
      repository.inTransaction((tx) => rotate(tx, token.tokenHash, 300)),
      pause(50).then(() => repository.inTransaction((tx) => revokeFamilyOf(tx, token.tokenHash))),
    ]);

    expect(rotated).not.toBeNull();
    expect(revoked).toBe(1);
    expect(await liveTokens(token.familyId)).toBe(0);
  });
});
