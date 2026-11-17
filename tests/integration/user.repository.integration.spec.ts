import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Email } from '../../src/domain/email.value-object';
import { DuplicateEmailError } from '../../src/domain/errors/duplicate-email.error';
import { User } from '../../src/domain/user.aggregate';
import { UserName } from '../../src/domain/user-name.value-object';
import { UserEntity } from '../../src/infra/database/entities/user.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { UserRepository } from '../../src/repositories/user.repository';

jest.setTimeout(180_000);

/** Builds a new customer with the given email. */
function customer(email: string): User {
  return User.registerCustomer(Email.create(email), UserName.create('Ana'), '$argon2id$hash');
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
});
