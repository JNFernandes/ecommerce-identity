import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Email } from '../../src/domain/email.value-object';
import { Role } from '../../src/domain/role.enum';
import { User } from '../../src/domain/user.aggregate';
import { UserName } from '../../src/domain/user-name.value-object';
import { UserEntity } from '../../src/infra/database/entities/user.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { UserRepository } from '../../src/repositories/user.repository';

jest.setTimeout(180_000);

const AT = new Date('2026-11-19T12:00:00.000Z');
const ACTOR = '00000000-0000-4000-8000-000000000001';

describe('AdminTx.saveRoles (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let users: UserRepository;

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
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should store both roles and the new customerId of an admin granted CUSTOMER', async () => {
    const admin = User.registerAdmin(Email.create('bea@example.com'), UserName.create('Bea'), 'h');
    await users.save(admin);

    await users.inAdminTransaction(async (tx) => {
      const locked = await tx.findByIdForUpdate(admin.id);
      locked?.changeRoles([Role.ADMIN, Role.CUSTOMER], ACTOR, AT);
      if (locked) {
        await tx.saveRoles(locked);
      }
    });

    const reloaded = await users.findById(admin.id);
    expect(reloaded?.roles).toEqual([Role.ADMIN, Role.CUSTOMER]);
    expect(reloaded?.customerId).toEqual(expect.any(String));
    expect(reloaded?.customerId).not.toBe(admin.id);
    expect(reloaded?.updatedAt).toEqual(AT);
    expect(reloaded?.email.value).toBe('bea@example.com');
    expect(reloaded?.status).toBe(admin.status);
  });

  it('should keep the customerId when CUSTOMER is removed', async () => {
    const customer = User.registerCustomer(
      Email.create('ana@example.com'),
      UserName.create('Ana'),
      'h',
    );
    await users.save(customer);

    await users.inAdminTransaction(async (tx) => {
      const locked = await tx.findByIdForUpdate(customer.id);
      locked?.changeRoles([Role.ADMIN], ACTOR, AT);
      if (locked) {
        await tx.saveRoles(locked);
      }
    });

    const reloaded = await users.findById(customer.id);
    expect(reloaded?.roles).toEqual([Role.ADMIN]);
    expect(reloaded?.customerId).toBe(customer.customerId);
  });

  it('should roll the roles back when the transaction fails', async () => {
    const customer = User.registerCustomer(
      Email.create('rollback@example.com'),
      UserName.create('Rui'),
      'h',
    );
    await users.save(customer);

    await expect(
      users.inAdminTransaction(async (tx) => {
        const locked = await tx.findByIdForUpdate(customer.id);
        locked?.changeRoles([Role.ADMIN], ACTOR, AT);
        if (locked) {
          await tx.saveRoles(locked);
        }
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');

    expect((await users.findById(customer.id))?.roles).toEqual([Role.CUSTOMER]);
  });
});
