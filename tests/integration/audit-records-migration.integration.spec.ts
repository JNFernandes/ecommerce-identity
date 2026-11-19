import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';

jest.setTimeout(180_000);

const MIGRATION = 'CreateAuditRecords20261119120000';
const INDEX_MIGRATION = 'AddAuditRecordIndexes20261119130000';

/** Definitions of the US-11 indexes on `audit_records`, keyed by name. */
async function listIndexes(dataSource: DataSource): Promise<Record<string, string>> {
  const rows: { indexname: string; indexdef: string }[] = await dataSource.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'audit_records' AND indexname LIKE 'IDX_audit_records_%'`,
  );
  return Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
}

/** Inserts one audit row and returns its id. */
async function insertRecord(dataSource: DataSource): Promise<string> {
  const id = randomUUID();
  await dataSource.query(
    `INSERT INTO "audit_records" ("id", "actorId", "action", "targetId", "before", "after", "occurredAt")
     VALUES ($1, $2, 'USER_CREATED', $3, NULL, '{"roles":["ADMIN"]}', now())`,
    [id, randomUUID(), randomUUID()],
  );
  return id;
}

describe('audit_records migration (integration)', () => {
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

  it('should create the table with the expected columns and nullability', async () => {
    const columns: ColumnRow[] = await dataSource.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'audit_records' ORDER BY ordinal_position`,
    );

    expect(columns).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'actorId', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'action', data_type: 'character varying', is_nullable: 'NO' },
      { column_name: 'targetId', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'before', data_type: 'jsonb', is_nullable: 'YES' },
      { column_name: 'after', data_type: 'jsonb', is_nullable: 'NO' },
      { column_name: 'occurredAt', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    ]);
  });

  it('should accept inserts and read them back', async () => {
    const id = await insertRecord(dataSource);

    const rows: { after: unknown; before: unknown }[] = await dataSource.query(
      `SELECT "before", "after" FROM "audit_records" WHERE "id" = $1`,
      [id],
    );
    expect(rows).toEqual([{ before: null, after: { roles: ['ADMIN'] } }]);
  });

  it('should reject updates and keep the row unchanged', async () => {
    const id = await insertRecord(dataSource);

    await expect(
      dataSource.query(`UPDATE "audit_records" SET "action" = 'TAMPERED' WHERE "id" = $1`, [id]),
    ).rejects.toThrow('audit records are append-only');

    const rows: { action: string }[] = await dataSource.query(
      `SELECT "action" FROM "audit_records" WHERE "id" = $1`,
      [id],
    );
    expect(rows).toEqual([{ action: 'USER_CREATED' }]);
  });

  it('should reject deletes and keep the row', async () => {
    const id = await insertRecord(dataSource);

    await expect(
      dataSource.query(`DELETE FROM "audit_records" WHERE "id" = $1`, [id]),
    ).rejects.toThrow('audit records are append-only');

    const rows: unknown[] = await dataSource.query(
      `SELECT 1 FROM "audit_records" WHERE "id" = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
  });

  it('should create the paging index and the actor and target filter indexes', async () => {
    const indexes = await listIndexes(dataSource);

    expect(Object.keys(indexes).sort()).toEqual([
      'IDX_audit_records_actor_occurred_at_id',
      'IDX_audit_records_occurred_at_id',
      'IDX_audit_records_target_occurred_at_id',
    ]);
    expect(indexes.IDX_audit_records_occurred_at_id).toContain('("occurredAt" DESC, id DESC)');
    expect(indexes.IDX_audit_records_actor_occurred_at_id).toContain(
      '("actorId", "occurredAt" DESC, id DESC)',
    );
    expect(indexes.IDX_audit_records_target_occurred_at_id).toContain(
      '("targetId", "occurredAt" DESC, id DESC)',
    );
  });

  it('should drop the table, trigger, function and indexes on down and re-apply cleanly', async () => {
    await dataSource.undoLastMigration();
    expect(await listIndexes(dataSource)).toEqual({});
    await dataSource.undoLastMigration();

    const tables: unknown[] = await dataSource.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_records'`,
    );
    const functions: unknown[] = await dataSource.query(
      `SELECT 1 FROM pg_proc WHERE proname = 'audit_records_reject_change'`,
    );
    expect(tables).toEqual([]);
    expect(functions).toEqual([]);

    const applied = await dataSource.runMigrations();
    expect(applied.map((migration) => migration.name)).toEqual([MIGRATION, INDEX_MIGRATION]);
  });
});
