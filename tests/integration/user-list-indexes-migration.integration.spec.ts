import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';

jest.setTimeout(180_000);

const MIGRATION = 'AddUserListIndexes20261118120000';
/** Later migrations, undone first so this one can be reverted. */
const LATER_MIGRATIONS = [
  'CreateAuditRecords20261119120000',
  'AddAuditRecordIndexes20261119130000',
];

/** Definitions of the US-06 indexes on `users`, keyed by name. */
async function listIndexes(dataSource: DataSource): Promise<Record<string, string>> {
  const rows: { indexname: string; indexdef: string }[] = await dataSource.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'users' AND indexname IN ('IDX_users_created_at_id', 'IDX_users_email_lower_prefix')`,
  );
  return Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
}

describe('user list indexes migration (integration)', () => {
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

  it('should create the paging index and the email prefix index', async () => {
    const indexes = await listIndexes(dataSource);

    expect(indexes.IDX_users_created_at_id).toContain('("createdAt" DESC, id DESC)');
    expect(indexes.IDX_users_email_lower_prefix).toContain(
      '(lower((email)::text) text_pattern_ops)',
    );
  });

  it('should drop both indexes on down and re-apply cleanly', async () => {
    for (let undone = 0; undone <= LATER_MIGRATIONS.length; undone += 1) {
      await dataSource.undoLastMigration();
    }

    expect(await listIndexes(dataSource)).toEqual({});

    const applied = await dataSource.runMigrations();
    expect(applied.map((migration) => migration.name)).toEqual([MIGRATION, ...LATER_MIGRATIONS]);
  });
});
