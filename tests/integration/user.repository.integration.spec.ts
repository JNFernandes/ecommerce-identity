import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Email } from '../../src/domain/email.value-object';
import { DuplicateEmailError } from '../../src/domain/errors/duplicate-email.error';
import { Role } from '../../src/domain/role.enum';
import { User } from '../../src/domain/user.aggregate';
import { UserName } from '../../src/domain/user-name.value-object';
import { UserStatus } from '../../src/domain/user-status.enum';
import { UserEntity } from '../../src/infra/database/entities/user.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { ListUsersQuery } from '../../src/queries/list-users.query';
import { UserSummaryReadModel } from '../../src/queries/user-summary.read-model';
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
});
