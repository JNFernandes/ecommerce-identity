import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { OutboundDeadLetterEntity } from '../../src/infra/database/entities/outbound-dead-letter.entity';
import { OutboundDeadLetterStatus } from '../../src/infra/database/entities/outbound-dead-letter-status.enum';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { OutboundDeadLetterRepository } from '../../src/repositories/outbound-dead-letter.repository';

jest.setTimeout(180_000);

describe('OutboundDeadLetterRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: OutboundDeadLetterRepository;

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
    repository = new OutboundDeadLetterRepository(
      dataSource.getRepository(OutboundDeadLetterEntity),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should store a PENDING_RETRY row, due now, with the exact payload', async () => {
    const payload = {
      eventId: '0b8e9f3a-0000-4000-8000-000000000003',
      aggregateId: '7d6f2c1e-0000-4000-8000-000000000001',
      occurredAt: '2026-11-17T12:00:00.000Z',
      version: 1,
      customerId: '1b2c3d4e-0000-4000-8000-000000000002',
      email: 'ana@example.com',
      name: 'Ana',
    };
    const before = new Date();

    await repository.recordFailure({
      eventId: payload.eventId,
      topic: 'identity.user-registered',
      key: payload.aggregateId,
      payload,
      error: 'broker down',
    });

    const rows = await dataSource
      .getRepository(OutboundDeadLetterEntity)
      .findBy({ eventId: payload.eventId });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.topic).toBe('identity.user-registered');
    expect(row.key).toBe(payload.aggregateId);
    expect(row.payload).toEqual(payload);
    expect(row.error).toBe('broker down');
    expect(row.lastError).toBe('broker down');
    expect(row.status).toBe(OutboundDeadLetterStatus.PENDING_RETRY);
    expect(row.retryCount).toBe(0);
    expect(row.nextRetryAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row.nextRetryAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(row.lastAttemptAt).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });
});
