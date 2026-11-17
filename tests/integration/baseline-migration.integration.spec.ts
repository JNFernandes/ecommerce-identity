import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';

jest.setTimeout(180_000);

describe('database migrations (integration)', () => {
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
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should apply the baseline migration on an empty database and record it', async () => {
    const applied = await dataSource.runMigrations();

    expect(applied.map((migration) => migration.name)).toContain('Baseline20261117120000');
    const rows: { name: string }[] = await dataSource.query('SELECT name FROM migrations');
    expect(rows.map((row) => row.name)).toContain('Baseline20261117120000');
  });

  it('should have no pending migration once the baseline is applied', async () => {
    await expect(dataSource.showMigrations()).resolves.toBe(false);
  });

  it('should never synchronize the schema from entities', () => {
    expect(dataSource.options.synchronize).toBe(false);
  });
});
