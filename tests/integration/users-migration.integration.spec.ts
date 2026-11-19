import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';

jest.setTimeout(180_000);

const MIGRATION = 'CreateUsersAndOutboundDeadLetters20261117130000';
/** Later migrations, undone first so this one can be reverted. */
const LATER_MIGRATIONS = [
  'CreateRefreshTokensAndUserLastLogin20261117140000',
  'AddUserListIndexes20261118120000',
  'CreateAuditRecords20261119120000',
];

/** Inserts a customer row with the given email. */
function insertUser(dataSource: DataSource, email: string): Promise<unknown> {
  return dataSource.query(
    `INSERT INTO "users" ("id", "customerId", "email", "name", "passwordHash", "roles", "status", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'Ana', '$argon2id$x', '{CUSTOMER}', 'ACTIVE', now(), now())`,
    [randomUUID(), randomUUID(), email],
  );
}

/** Names of the public tables. */
async function tableNames(dataSource: DataSource): Promise<string[]> {
  const rows: { table_name: string }[] = await dataSource.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  return rows.map((row) => row.table_name);
}

describe('users and outbound dead-letter migration (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;

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
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should create the users and outbound_dead_letters tables', async () => {
    const rows: { name: string }[] = await dataSource.query('SELECT name FROM migrations');

    expect(rows.map((row) => row.name)).toContain(MIGRATION);
    expect(await tableNames(dataSource)).toEqual(
      expect.arrayContaining(['users', 'outbound_dead_letters']),
    );
  });

  it('should reject an email that differs only in case', async () => {
    await insertUser(dataSource, 'a@x.io');

    await expect(insertUser(dataSource, 'A@x.io')).rejects.toMatchObject({ code: '23505' });
  });

  it('should reject a duplicate customerId', async () => {
    const customerId = randomUUID();
    const insert = (email: string): Promise<unknown> =>
      dataSource.query(
        `INSERT INTO "users" ("id", "customerId", "email", "name", "passwordHash", "roles", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'Ana', 'h', '{CUSTOMER}', 'ACTIVE', now(), now())`,
        [randomUUID(), customerId, email],
      );
    await insert('first@x.io');

    await expect(insert('second@x.io')).rejects.toMatchObject({ code: '23505' });
  });

  it('should default a dead letter to PENDING_RETRY, retryCount 0 and nextRetryAt set', async () => {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO "outbound_dead_letters" ("id", "eventId", "topic", "key", "payload", "error")
       VALUES ($1, $2, 'identity.user-registered', 'k', '{}', 'boom')`,
      [id, randomUUID()],
    );

    const [row]: { status: string; retryCount: number; nextRetryAt: Date | null }[] =
      await dataSource.query(
        `SELECT "status", "retryCount", "nextRetryAt" FROM "outbound_dead_letters" WHERE "id" = $1`,
        [id],
      );
    expect(row.status).toBe('PENDING_RETRY');
    expect(row.retryCount).toBe(0);
    expect(row.nextRetryAt).toBeInstanceOf(Date);
  });

  it('should drop everything on down and re-apply cleanly', async () => {
    for (let undone = 0; undone <= LATER_MIGRATIONS.length; undone += 1) {
      await dataSource.undoLastMigration();
    }

    const tables = await tableNames(dataSource);
    expect(tables).not.toContain('users');
    expect(tables).not.toContain('outbound_dead_letters');
    const types: { typname: string }[] = await dataSource.query(
      `SELECT typname FROM pg_type WHERE typname IN ('user_role_enum', 'user_status_enum', 'outbound_dead_letter_status_enum')`,
    );
    expect(types).toEqual([]);

    const applied = await dataSource.runMigrations();
    expect(applied.map((migration) => migration.name)).toEqual([MIGRATION, ...LATER_MIGRATIONS]);
  });
});
