import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Email } from '../../src/domain/email.value-object';
import { InvalidCredentialsError } from '../../src/domain/errors/invalid-credentials.error';
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

  it('should refuse to store a login for a DISABLED user and write nothing', async () => {
    const user = await savedCustomer('disabled-login@example.com');
    const loginAt = new Date('2026-11-17T14:00:00.000Z');
    user.recordLogin(loginAt);
    // The user passed the status check, then got disabled before the token was stored.
    await dataSource.query(`UPDATE "users" SET "status" = 'DISABLED' WHERE "id" = $1`, [user.id]);

    await expect(
      repository.saveWithLogin(tokenFor(user, 'd'.repeat(64), loginAt), user),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    const rows: TokenRow[] = await dataSource.query(
      `SELECT * FROM "refresh_tokens" WHERE "userId" = $1`,
      [user.id],
    );
    expect(rows).toEqual([]);
    expect(await lastLoginAt(user.id)).toBeNull();
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

  describe('inTransaction', () => {
    const LOGIN_AT = new Date('2026-11-18T10:00:00.000Z');
    const ROTATED_AT = new Date('2026-11-18T10:05:00.000Z');

    /** A random 64-hex-character hash, unique per call. */
    const newHash = (): string => randomBytes(32).toString('hex');

    /** Stores a login token for a new customer and returns both. */
    async function loggedIn(email: string): Promise<{ user: User; token: RefreshToken }> {
      const user = await savedCustomer(email);
      user.recordLogin(LOGIN_AT);
      const token = tokenFor(user, newHash(), LOGIN_AT);
      await repository.saveWithLogin(token, user);
      return { user, token };
    }

    /** Reads every row of a family, oldest first. */
    async function familyRows(familyId: string): Promise<TokenRow[]> {
      return dataSource.query(
        `SELECT * FROM "refresh_tokens" WHERE "familyId" = $1 ORDER BY "createdAt", "id"`,
        [familyId],
      );
    }

    /** Builds the successor of `token` issued at `ROTATED_AT`. */
    function successorOf(token: RefreshToken): RefreshToken {
      return RefreshToken.issueInFamily({
        userId: token.userId,
        familyId: token.familyId,
        tokenHash: newHash(),
        issuedAt: ROTATED_AT,
        expiresAt: new Date('2026-11-25T10:05:00.000Z'),
      });
    }

    it('should commit the rotated token and its successor together', async () => {
      const { token } = await loggedIn('rotate@example.com');

      const next = await repository.inTransaction(async (tx) => {
        const locked = await tx.findByHashForUpdate(token.tokenHash);
        if (locked === null) {
          throw new Error('token not found');
        }
        const successor = successorOf(locked);
        locked.rotate(successor.id, ROTATED_AT);
        await tx.saveRotation(locked, successor);
        return successor;
      });

      const rows = await familyRows(token.familyId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: token.id, revokedAt: ROTATED_AT, replacedBy: next.id });
      expect(rows[1]).toMatchObject({
        id: next.id,
        tokenHash: next.tokenHash,
        familyId: token.familyId,
        createdAt: ROTATED_AT,
        revokedAt: null,
        replacedBy: null,
      });
    });

    it('should roll back both rows when the work fails', async () => {
      const { token } = await loggedIn('rollback@example.com');

      await expect(
        repository.inTransaction(async (tx) => {
          const successor = successorOf(token);
          token.rotate(successor.id, ROTATED_AT);
          await tx.saveRotation(token, successor);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const rows = await familyRows(token.familyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: token.id, revokedAt: null, replacedBy: null });
    });

    it('should revoke only the unrevoked tokens of the given family', async () => {
      const { token } = await loggedIn('revoke@example.com');
      const { token: other } = await loggedIn('other-family@example.com');
      const next = successorOf(token);
      await repository.inTransaction(async (tx) => {
        token.rotate(next.id, ROTATED_AT);
        await tx.saveRotation(token, next);
      });
      const revokeAt = new Date('2026-11-18T11:00:00.000Z');

      const revoked = await repository.inTransaction((tx) =>
        tx.revokeFamily(token.familyId, revokeAt),
      );

      expect(revoked).toBe(1);
      const rows = await familyRows(token.familyId);
      expect(rows[0]).toMatchObject({ id: token.id, revokedAt: ROTATED_AT, replacedBy: next.id });
      expect(rows[1]).toMatchObject({ id: next.id, revokedAt: revokeAt, replacedBy: null });
      expect(await familyRows(other.familyId)).toEqual([
        expect.objectContaining({ id: other.id, revokedAt: null }),
      ]);
    });

    it('should return the login time as the start of the family', async () => {
      const { token } = await loggedIn('started@example.com');
      const next = successorOf(token);
      await repository.inTransaction(async (tx) => {
        token.rotate(next.id, ROTATED_AT);
        await tx.saveRotation(token, next);
      });

      await expect(
        repository.inTransaction((tx) => tx.familyStartedAt(token.familyId)),
      ).resolves.toEqual(LOGIN_AT);
    });

    it('should return no start for an unknown family', async () => {
      await expect(
        repository.inTransaction((tx) => tx.familyStartedAt(randomUUID())),
      ).resolves.toBeNull();
    });

    it('should find a token by hash with and without a lock', async () => {
      const { token } = await loggedIn('find@example.com');

      const [plain, locked] = await repository.inTransaction(async (tx) => {
        const found = await tx.findByHash(token.tokenHash);
        await tx.lockFamily(token.familyId);
        return [found, await tx.findByHashForUpdate(token.tokenHash)];
      });

      expect(plain?.id).toBe(token.id);
      expect(locked?.id).toBe(token.id);
      expect(locked?.familyId).toBe(token.familyId);
      expect(locked?.expiresAt).toEqual(token.expiresAt);
    });

    it('should return null for an unknown hash', async () => {
      const [plain, locked] = await repository.inTransaction(async (tx) => [
        await tx.findByHash(newHash()),
        await tx.findByHashForUpdate(newHash()),
      ]);

      expect(plain).toBeNull();
      expect(locked).toBeNull();
    });

    it('should read the current user inside the transaction', async () => {
      const { user } = await loggedIn('owner@example.com');

      const found = await repository.inTransaction((tx) => tx.findUserById(user.id));

      expect(found?.id).toBe(user.id);
      expect(found?.roles).toEqual(user.roles);
      expect(found?.customerId).toBe(user.customerId);
      await expect(
        repository.inTransaction((tx) => tx.findUserById(randomUUID())),
      ).resolves.toBeNull();
    });
  });
});
