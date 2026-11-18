import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';

jest.setTimeout(180_000);

const MIGRATION = 'CreateRefreshTokensAndUserLastLogin20261117140000';
/** Later migrations, undone first so this one can be reverted. */
const LATER_MIGRATIONS = ['AddUserListIndexes20261118120000'];

/** Inserts a customer and returns its id. */
async function insertUser(dataSource: DataSource): Promise<string> {
  const id = randomUUID();
  await dataSource.query(
    `INSERT INTO "users" ("id", "customerId", "email", "name", "passwordHash", "roles", "status", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'Ana', 'h', '{CUSTOMER}', 'ACTIVE', now(), now())`,
    [id, randomUUID(), `${id}@x.io`],
  );
  return id;
}

/** Inserts a refresh token row for the user with the given hash. */
function insertToken(dataSource: DataSource, userId: string, tokenHash: string): Promise<unknown> {
  return dataSource.query(
    `INSERT INTO "refresh_tokens" ("id", "userId", "familyId", "tokenHash", "createdAt", "expiresAt")
     VALUES ($1, $2, $3, $4, now(), now() + interval '7 days')`,
    [randomUUID(), userId, randomUUID(), tokenHash],
  );
}

/** Names of the indexes on `refresh_tokens`. */
async function indexNames(dataSource: DataSource): Promise<string[]> {
  const rows: { indexname: string }[] = await dataSource.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'refresh_tokens'`,
  );
  return rows.map((row) => row.indexname);
}

/** Whether `users."lastLoginAt"` exists. */
async function hasLastLoginAt(dataSource: DataSource): Promise<boolean> {
  const rows: unknown[] = await dataSource.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'lastLoginAt'`,
  );
  return rows.length === 1;
}

describe('refresh tokens and last login migration (integration)', () => {
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

  it('should create the table, its indexes and users.lastLoginAt', async () => {
    const rows: { name: string }[] = await dataSource.query('SELECT name FROM migrations');

    expect(rows.map((row) => row.name)).toContain(MIGRATION);
    expect(await indexNames(dataSource)).toEqual(
      expect.arrayContaining([
        'PK_refresh_tokens_id',
        'UQ_refresh_tokens_token_hash',
        'IDX_refresh_tokens_user_id',
        'IDX_refresh_tokens_family_id',
      ]),
    );
    expect(await hasLastLoginAt(dataSource)).toBe(true);
  });

  it('should leave lastLoginAt null for a new user', async () => {
    const id = await insertUser(dataSource);

    const [row]: { lastLoginAt: Date | null }[] = await dataSource.query(
      `SELECT "lastLoginAt" FROM "users" WHERE "id" = $1`,
      [id],
    );
    expect(row.lastLoginAt).toBeNull();
  });

  it('should reject a duplicate token hash', async () => {
    const userId = await insertUser(dataSource);
    const hash = 'b'.repeat(64);
    await insertToken(dataSource, userId, hash);

    await expect(insertToken(dataSource, userId, hash)).rejects.toMatchObject({ code: '23505' });
  });

  it('should reject a token for an unknown user', async () => {
    await expect(insertToken(dataSource, randomUUID(), 'c'.repeat(64))).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('should delete the tokens with their user', async () => {
    const userId = await insertUser(dataSource);
    await insertToken(dataSource, userId, 'd'.repeat(64));

    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [userId]);

    const rows: unknown[] = await dataSource.query(
      `SELECT 1 FROM "refresh_tokens" WHERE "userId" = $1`,
      [userId],
    );
    expect(rows).toEqual([]);
  });

  it('should drop the table and the column on down and re-apply cleanly', async () => {
    for (let undone = 0; undone <= LATER_MIGRATIONS.length; undone += 1) {
      await dataSource.undoLastMigration();
    }

    const tables: unknown[] = await dataSource.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'refresh_tokens'`,
    );
    expect(tables).toEqual([]);
    expect(await hasLastLoginAt(dataSource)).toBe(false);

    const applied = await dataSource.runMigrations();
    expect(applied.map((migration) => migration.name)).toEqual([MIGRATION, ...LATER_MIGRATIONS]);
  });
});
