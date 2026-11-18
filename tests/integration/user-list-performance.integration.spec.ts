import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { UserEntity } from '../../src/infra/database/entities/user.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { ListUsersQuery } from '../../src/queries/list-users.query';
import { UserRepository } from '../../src/repositories/user.repository';

jest.setTimeout(240_000);

const USER_COUNT = 10_000;
/** SC-006: a filtered page answers in under 1 second with 10,000 users. */
const BUDGET_MS = 1_000;

/** Runs `findPage` and returns how long it took, in milliseconds. */
async function timed(repository: UserRepository, query: ListUsersQuery): Promise<number> {
  const started = performance.now();
  await repository.findPage(query);
  return performance.now() - started;
}

describe('user listing with 10,000 users (integration)', () => {
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
    await dataSource.query(
      `INSERT INTO "users" ("id", "customerId", "email", "name", "passwordHash", "roles", "status", "createdAt", "updatedAt")
       SELECT gen_random_uuid(), gen_random_uuid(), 'user' || n || '@example.com', 'User ' || n,
              '$argon2id$hash', '{CUSTOMER}', 'ACTIVE',
              now() - n * interval '1 second', now() - n * interval '1 second'
       FROM generate_series(1, $1) AS n`,
      [USER_COUNT],
    );
    await dataSource.query('ANALYZE "users"');
    repository = new UserRepository(dataSource.getRepository(UserEntity));
    // Warm-up, so connection setup is not measured.
    await repository.findPage(new ListUsersQuery(1, 0));
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should hold 10,000 users', async () => {
    expect((await repository.findPage(new ListUsersQuery(1, 0))).total).toBe(USER_COUNT);
  });

  it('should answer an unfiltered page within the budget', async () => {
    expect(await timed(repository, new ListUsersQuery(20, 0))).toBeLessThan(BUDGET_MS);
  });

  it('should find users by an email prefix within the budget', async () => {
    const query = new ListUsersQuery(20, 0, undefined, undefined, 'USER4321');

    expect(await timed(repository, query)).toBeLessThan(BUDGET_MS);
    expect((await repository.findPage(query)).items.map((item) => item.email)).toContain(
      'user4321@example.com',
    );
  });

  it('should answer a deep page within the budget', async () => {
    expect(await timed(repository, new ListUsersQuery(100, 9_900))).toBeLessThan(BUDGET_MS);
  });
});
