import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Email } from '../../src/domain/email.value-object';
import { DuplicateEmailError } from '../../src/domain/errors/duplicate-email.error';
import { RefreshToken } from '../../src/domain/refresh-token.aggregate';
import { Role } from '../../src/domain/role.enum';
import { User } from '../../src/domain/user.aggregate';
import { UserName } from '../../src/domain/user-name.value-object';
import { UserStatus } from '../../src/domain/user-status.enum';
import { UserEntity } from '../../src/infra/database/entities/user.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { ListUsersQuery } from '../../src/queries/list-users.query';
import { UserSummaryReadModel } from '../../src/queries/user-summary.read-model';
import { RefreshTokenRepository } from '../../src/repositories/refresh-token.repository';
import { UserRepository } from '../../src/repositories/user.repository';

jest.setTimeout(180_000);

/** Builds a new customer with the given email. */
function customer(email: string): User {
  return User.registerCustomer(Email.create(email), UserName.create('Ana'), '$argon2id$hash');
}

/** Builds an admin with the given email and status. */
function admin(email: string, status: UserStatus = UserStatus.ACTIVE): User {
  const seeded = User.registerAdmin(
    Email.create(email),
    UserName.create('Admin'),
    '$argon2id$hash',
  );
  return User.restore({
    id: seeded.id,
    customerId: null,
    email: seeded.email,
    name: seeded.name,
    passwordHash: seeded.passwordHash,
    roles: seeded.roles,
    status,
    createdAt: seeded.createdAt,
    updatedAt: seeded.updatedAt,
    lastLoginAt: null,
  });
}

/** A stored user with chosen email, role, status and creation time. */
function stored(
  email: string,
  createdAt: string,
  options: { role?: Role; status?: UserStatus; id?: string } = {},
): User {
  const role = options.role ?? Role.CUSTOMER;
  const base = customer(email);
  return User.restore({
    id: options.id ?? base.id,
    customerId: role === Role.ADMIN ? null : base.customerId,
    email: base.email,
    name: base.name,
    passwordHash: base.passwordHash,
    roles: [role],
    status: options.status ?? UserStatus.ACTIVE,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    lastLoginAt: null,
  });
}

/** A copy of `user` with another status and `updatedAt`, as `disable`/`enable` would leave it. */
function withStatus(user: User, status: UserStatus, updatedAt: Date): User {
  return User.restore({
    id: user.id,
    customerId: user.customerId,
    email: user.email,
    name: user.name,
    passwordHash: user.passwordHash,
    roles: user.roles,
    status,
    createdAt: user.createdAt,
    updatedAt,
    lastLoginAt: user.lastLoginAt,
  });
}

/** Resolves after `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Emails of a page, in order. */
function emails(items: UserSummaryReadModel[]): string[] {
  return items.map((item) => item.email);
}

describe('UserRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: UserRepository;

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
    repository = new UserRepository(dataSource.getRepository(UserEntity));
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should round trip every field', async () => {
    const user = customer('ana@example.com');

    await repository.save(user);
    const loaded = await repository.findById(user.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(user.id);
    expect(loaded?.customerId).toBe(user.customerId);
    expect(loaded?.email.value).toBe('ana@example.com');
    expect(loaded?.name.value).toBe('Ana');
    expect(loaded?.passwordHash).toBe('$argon2id$hash');
    expect(loaded?.roles).toEqual(user.roles);
    expect(loaded?.status).toBe(user.status);
    expect(loaded?.createdAt.getTime()).toBe(user.createdAt.getTime());
    expect(loaded?.updatedAt.getTime()).toBe(user.updatedAt.getTime());
    expect(loaded?.pullDomainEvents()).toEqual([]);
  });

  it('should round trip lastLoginAt', async () => {
    const user = customer('last-login@example.com');
    await repository.save(user);
    expect((await repository.findById(user.id))?.lastLoginAt).toBeNull();

    const loginAt = new Date('2026-11-17T12:00:00.000Z');
    user.recordLogin(loginAt);
    await repository.save(user);

    expect((await repository.findById(user.id))?.lastLoginAt).toEqual(loginAt);
  });

  it('should find a user by its normalized email', async () => {
    const user = customer('find-me@example.com');
    await repository.save(user);

    const loaded = await repository.findByEmail('find-me@example.com');

    expect(loaded?.id).toBe(user.id);
    expect(loaded?.passwordHash).toBe('$argon2id$hash');
  });

  it('should find a user stored with another case', async () => {
    const fresh = customer('placeholder@example.com');
    // Bypass normalization to prove the lookup compares on lower(email).
    await repository.save(
      User.restore({
        id: fresh.id,
        customerId: fresh.customerId,
        email: { value: 'Mixed.Case@Example.com' } as Email,
        name: fresh.name,
        passwordHash: fresh.passwordHash,
        roles: fresh.roles,
        status: fresh.status,
        createdAt: fresh.createdAt,
        updatedAt: fresh.updatedAt,
        lastLoginAt: null,
      }),
    );

    await expect(repository.findByEmail('mixed.case@example.com')).resolves.not.toBeNull();
  });

  it('should return null for an unknown email', async () => {
    await expect(repository.findByEmail('nobody@example.com')).resolves.toBeNull();
  });

  it('should return null for an unknown id', async () => {
    await expect(repository.findById('00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
  });

  it('should throw DuplicateEmailError for the same email in another case', async () => {
    await repository.save(customer('dup@example.com'));
    const fresh = customer('other@example.com');
    // Bypass normalization so the database index, not the value object, has to catch the case.
    const upperCase = User.restore({
      id: fresh.id,
      customerId: fresh.customerId,
      email: { value: 'DUP@example.com' } as Email,
      name: fresh.name,
      passwordHash: fresh.passwordHash,
      roles: fresh.roles,
      status: fresh.status,
      createdAt: fresh.createdAt,
      updatedAt: fresh.updatedAt,
      lastLoginAt: fresh.lastLoginAt,
    });

    await expect(repository.save(upperCase)).rejects.toBeInstanceOf(DuplicateEmailError);
  });

  describe('existsWithRole', () => {
    beforeEach(async () => {
      await dataSource.query('DELETE FROM "users"');
    });

    it('should return false on an empty table', async () => {
      expect(await repository.existsWithRole(Role.ADMIN)).toBe(false);
    });

    it('should return false for ADMIN when only customers exist', async () => {
      await repository.save(customer('only-customer@example.com'));

      expect(await repository.existsWithRole(Role.ADMIN)).toBe(false);
      expect(await repository.existsWithRole(Role.CUSTOMER)).toBe(true);
    });

    it('should return true when an ACTIVE admin exists', async () => {
      await repository.save(admin('active-admin@example.com'));

      expect(await repository.existsWithRole(Role.ADMIN)).toBe(true);
    });

    it('should return true when only a DISABLED admin exists', async () => {
      await repository.save(admin('disabled-admin@example.com', UserStatus.DISABLED));

      expect(await repository.existsWithRole(Role.ADMIN)).toBe(true);
    });
  });

  describe('findPage', () => {
    const TIE = '2026-11-18T10:05:00.000Z';
    const LOW_ID = '00000000-0000-4000-8000-000000000001';
    const HIGH_ID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';

    beforeEach(async () => {
      await dataSource.query('DELETE FROM "users"');
      for (const user of [
        stored('ana@example.com', '2026-11-18T10:01:00.000Z'),
        stored('anabela@example.com', '2026-11-18T10:02:00.000Z', { status: UserStatus.DISABLED }),
        stored('admin@example.com', '2026-11-18T10:03:00.000Z', { role: Role.ADMIN }),
        stored('bob@example.com', '2026-11-18T10:04:00.000Z'),
        stored('an%x@example.com', TIE, { id: LOW_ID }),
        stored('an_y@example.com', TIE, { id: HIGH_ID }),
      ]) {
        await repository.save(user);
      }
    });

    const ALL_NEWEST_FIRST = [
      'an_y@example.com',
      'an%x@example.com',
      'bob@example.com',
      'admin@example.com',
      'anabela@example.com',
      'ana@example.com',
    ];

    it('should list every user newest first with the total', async () => {
      const page = await repository.findPage(new ListUsersQuery(20, 0));

      expect(emails(page.items)).toEqual(ALL_NEWEST_FIRST);
      expect(page).toMatchObject({ total: 6, limit: 20, offset: 0 });
    });

    it('should break creation time ties by id, descending', async () => {
      const page = await repository.findPage(new ListUsersQuery(2, 0));

      expect(page.items.map((item) => item.id)).toEqual([HIGH_ID, LOW_ID]);
    });

    it.each([1, 2, 3, 4])(
      'should return every user exactly once when paging by %i',
      async (limit) => {
        const seen: string[] = [];
        for (let offset = 0; offset < 6; offset += limit) {
          const page = await repository.findPage(new ListUsersQuery(limit, offset));
          expect(page.total).toBe(6);
          expect(page.items.length).toBeLessThanOrEqual(limit);
          seen.push(...emails(page.items));
        }

        expect(seen).toEqual(ALL_NEWEST_FIRST);
      },
    );

    it('should return the requested slice and echo limit and offset', async () => {
      const page = await repository.findPage(new ListUsersQuery(2, 2));

      expect(emails(page.items)).toEqual(['bob@example.com', 'admin@example.com']);
      expect(page).toMatchObject({ total: 6, limit: 2, offset: 2 });
    });

    it('should return no items but the real total for an offset past the end', async () => {
      const page = await repository.findPage(new ListUsersQuery(20, 50));

      expect(page.items).toEqual([]);
      expect(page.total).toBe(6);
    });

    it('should filter by role', async () => {
      const admins = await repository.findPage(new ListUsersQuery(20, 0, Role.ADMIN));
      const customers = await repository.findPage(new ListUsersQuery(20, 0, Role.CUSTOMER));

      expect(emails(admins.items)).toEqual(['admin@example.com']);
      expect(admins.total).toBe(1);
      expect(customers.total).toBe(5);
    });

    it('should filter by status', async () => {
      const page = await repository.findPage(
        new ListUsersQuery(20, 0, undefined, UserStatus.DISABLED),
      );

      expect(emails(page.items)).toEqual(['anabela@example.com']);
      expect(page.total).toBe(1);
    });

    it('should filter by email prefix, ignoring case', async () => {
      const page = await repository.findPage(new ListUsersQuery(20, 0, undefined, undefined, 'AN'));

      expect(emails(page.items)).toEqual([
        'an_y@example.com',
        'an%x@example.com',
        'anabela@example.com',
        'ana@example.com',
      ]);
      expect(page.total).toBe(4);
    });

    it.each([
      ['an%', 'an%x@example.com'],
      ['an_', 'an_y@example.com'],
    ])('should match the wildcard in %s literally', async (prefix, only) => {
      const page = await repository.findPage(
        new ListUsersQuery(20, 0, undefined, undefined, prefix),
      );

      expect(emails(page.items)).toEqual([only]);
    });

    it('should match a backslash literally', async () => {
      const page = await repository.findPage(
        new ListUsersQuery(20, 0, undefined, undefined, 'an\\'),
      );

      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });

    it('should combine every filter with AND', async () => {
      const page = await repository.findPage(
        new ListUsersQuery(20, 0, Role.CUSTOMER, UserStatus.ACTIVE, 'an'),
      );

      expect(emails(page.items)).toEqual([
        'an_y@example.com',
        'an%x@example.com',
        'ana@example.com',
      ]);
      expect(page.total).toBe(3);
    });

    it('should map exactly the read model fields, without the hash', async () => {
      const page = await repository.findPage(new ListUsersQuery(1, 3, Role.ADMIN));
      const [admin] = (await repository.findPage(new ListUsersQuery(1, 0, Role.ADMIN))).items;

      expect(page.items).toEqual([]);
      expect(Object.keys(admin).sort()).toEqual(
        ['createdAt', 'customerId', 'email', 'id', 'lastLoginAt', 'name', 'roles', 'status'].sort(),
      );
      expect(admin).toMatchObject({
        customerId: null,
        roles: [Role.ADMIN],
        status: UserStatus.ACTIVE,
        lastLoginAt: null,
      });
      expect(admin.createdAt).toEqual(new Date('2026-11-18T10:03:00.000Z'));
    });
  });

  describe('findSummaryById', () => {
    it('should return the same read model as the list item', async () => {
      await dataSource.query('DELETE FROM "users"');
      const user = stored('summary@example.com', '2026-11-18T11:00:00.000Z');
      await repository.save(user);

      const summary = await repository.findSummaryById(user.id);
      const [item] = (await repository.findPage(new ListUsersQuery(1, 0))).items;

      expect(summary).toEqual(item);
      expect(summary).not.toHaveProperty('passwordHash');
    });

    it('should return null for an unknown id', async () => {
      await expect(
        repository.findSummaryById('00000000-0000-4000-8000-0000000000ff'),
      ).resolves.toBeNull();
    });
  });

  describe('inStatusTransaction', () => {
    const NOW = new Date('2026-11-18T12:00:00.000Z');
    let tokens: RefreshTokenRepository;

    beforeAll(() => {
      tokens = new RefreshTokenRepository(dataSource);
    });

    beforeEach(async () => {
      await dataSource.query('DELETE FROM "refresh_tokens"');
      await dataSource.query('DELETE FROM "users"');
    });

    /** Stores a login token for the user and returns it. */
    async function login(user: User, at: Date): Promise<RefreshToken> {
      user.recordLogin(at);
      const token = RefreshToken.issue({
        userId: user.id,
        tokenHash: randomBytes(32).toString('hex'),
        issuedAt: at,
        ttlSeconds: 604800,
      });
      await tokens.saveWithLogin(token, user);
      return token;
    }

    /** Reads `revokedAt` and `replacedBy` of every token of a user, keyed by token id. */
    async function tokenRows(
      userId: string,
    ): Promise<Map<string, { id: string; revokedAt: Date | null; replacedBy: string | null }>> {
      const rows: { id: string; revokedAt: Date | null; replacedBy: string | null }[] =
        await dataSource.query(
          'SELECT "id", "revokedAt", "replacedBy" FROM "refresh_tokens" WHERE "userId" = $1',
          [userId],
        );
      return new Map(rows.map((row) => [row.id, row]));
    }

    it('should map findByIdForUpdate to the aggregate and return null for an unknown id', async () => {
      const user = customer('for-update@example.com');
      await repository.save(user);

      const [found, missing] = await repository.inStatusTransaction(async (tx) => [
        await tx.findByIdForUpdate(user.id),
        await tx.findByIdForUpdate('00000000-0000-4000-8000-0000000000aa'),
      ]);

      expect(found).toBeInstanceOf(User);
      expect(found?.id).toBe(user.id);
      expect(found?.email.value).toBe('for-update@example.com');
      expect(found?.status).toBe(UserStatus.ACTIVE);
      expect(missing).toBeNull();
    });

    it('should map findById to the aggregate', async () => {
      const user = customer('find-tx@example.com');
      await repository.save(user);

      const found = await repository.inStatusTransaction((tx) => tx.findById(user.id));

      expect(found?.id).toBe(user.id);
    });

    it('should count only ACTIVE admins', async () => {
      await repository.save(admin('a1@example.com'));
      await repository.save(admin('a2@example.com'));
      await repository.save(admin('a3@example.com', UserStatus.DISABLED));
      await repository.save(customer('c1@example.com'));

      await expect(repository.inStatusTransaction((tx) => tx.countActiveAdmins())).resolves.toBe(2);
    });

    it('should write only status and updatedAt in saveStatus', async () => {
      const user = customer('save-status@example.com');
      await repository.save(user);
      await login(user, new Date('2026-11-18T09:00:00.000Z'));
      const before = await repository.findById(user.id);
      if (before === null) {
        throw new Error('setup failed');
      }
      // A copy holding other values in every other column proves those columns are not written.
      const changed = User.restore({
        id: user.id,
        customerId: user.customerId,
        email: Email.create('changed@example.com'),
        name: UserName.create('Changed'),
        passwordHash: '$argon2id$other',
        roles: [Role.ADMIN],
        status: UserStatus.DISABLED,
        createdAt: user.createdAt,
        updatedAt: NOW,
        lastLoginAt: null,
      });

      await repository.inStatusTransaction((tx) => tx.saveStatus(changed));
      const after = await repository.findById(user.id);

      expect(after?.status).toBe(UserStatus.DISABLED);
      expect(after?.updatedAt).toEqual(NOW);
      expect(after?.email.value).toBe(before.email.value);
      expect(after?.name.value).toBe(before.name.value);
      expect(after?.roles).toEqual(before.roles);
      expect(after?.passwordHash).toBe(before.passwordHash);
      expect(after?.lastLoginAt).toEqual(before.lastLoginAt);
      expect(after?.customerId).toBe(before.customerId);
    });

    it("should revoke every family of the user and leave other users' tokens alone", async () => {
      const user = customer('revoke-all@example.com');
      const other = customer('keep@example.com');
      await repository.save(user);
      await repository.save(other);
      const first = await login(user, new Date('2026-11-18T09:00:00.000Z'));
      const second = await login(user, new Date('2026-11-18T09:01:00.000Z'));
      const third = await login(user, new Date('2026-11-18T09:02:00.000Z'));
      const alreadyRevokedAt = new Date('2026-11-18T09:02:30.000Z');
      const replacement = '00000000-0000-4000-8000-0000000000bb';
      await dataSource.query(
        'UPDATE "refresh_tokens" SET "revokedAt" = $2, "replacedBy" = $3 WHERE "id" = $1',
        [third.id, alreadyRevokedAt, replacement],
      );
      const othersToken = await login(other, new Date('2026-11-18T09:03:00.000Z'));

      const revoked = await repository.inStatusTransaction((tx) =>
        tx.revokeAllRefreshTokens(user.id, NOW),
      );
      const rows = await tokenRows(user.id);

      expect(revoked).toBe(2);
      expect(first.familyId).not.toBe(second.familyId);
      expect(rows.get(first.id)?.revokedAt).toEqual(NOW);
      expect(rows.get(second.id)?.revokedAt).toEqual(NOW);
      expect(rows.get(third.id)).toEqual({
        id: third.id,
        revokedAt: alreadyRevokedAt,
        replacedBy: replacement,
      });
      expect((await tokenRows(other.id)).get(othersToken.id)?.revokedAt).toBeNull();
    });

    it('should roll back every write when work rejects', async () => {
      const user = customer('rollback@example.com');
      await repository.save(user);
      await login(user, new Date('2026-11-18T09:00:00.000Z'));

      await expect(
        repository.inStatusTransaction(async (tx) => {
          await tx.saveStatus(withStatus(user, UserStatus.DISABLED, NOW));
          await tx.revokeAllRefreshTokens(user.id, NOW);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect((await repository.findById(user.id))?.status).toBe(UserStatus.ACTIVE);
      expect([...(await tokenRows(user.id)).values()].map((row) => row.revokedAt)).toEqual([null]);
    });

    it('should make a second lockStatusChanges wait until the first transaction commits', async () => {
      const order: string[] = [];

      await Promise.all([
        repository.inStatusTransaction(async (tx) => {
          await tx.lockStatusChanges();
          order.push('first locked');
          await pause(300);
          order.push('first done');
        }),
        pause(50).then(() =>
          repository.inStatusTransaction(async (tx) => {
            await tx.lockStatusChanges();
            order.push('second locked');
          }),
        ),
      ]);

      expect(order).toEqual(['first locked', 'first done', 'second locked']);
    });
  });
});
