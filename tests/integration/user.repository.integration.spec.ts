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
});
