import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapturingLogger } from './support/capturing-logger';
import { closedPort, createTestApp, startPostgres } from './support/test-app';

jest.setTimeout(180_000);

const PASSWORD = 'correct-horse-battery';

interface DeadLetterRow {
  eventId: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  status: string;
  retryCount: number;
  nextRetryAt: Date | null;
  lastError: string | null;
}

/** Registration while Kafka is unreachable, with the default producer retry and timeout settings. */
describe('POST /auth/register with Kafka unreachable (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let response: request.Response;
  let elapsedMs: number;
  let deadLetters: DeadLetterRow[];
  let passwordHash: string;

  beforeAll(async () => {
    container = await startPostgres();
    process.env.KAFKA_BROKERS = `127.0.0.1:${await closedPort()}`;
    delete process.env.KAFKA_PRODUCER_RETRIES;
    delete process.env.KAFKA_CONNECTION_TIMEOUT_MS;
    app = await createTestApp(logger);

    const started = Date.now();
    response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'ana@example.com', name: 'Ana', password: PASSWORD });
    elapsedMs = Date.now() - started;

    const dataSource = app.get(DataSource);
    deadLetters = await dataSource.query(
      'SELECT "eventId", "topic", "key", "payload", "status"::text AS "status", "retryCount", ' +
        '"nextRetryAt", "lastError" FROM "outbound_dead_letters"',
    );
    const users: { passwordHash: string }[] = await dataSource.query(
      'SELECT "passwordHash" FROM "users"',
    );
    passwordHash = users[0].passwordHash;
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should still return 201 within 5 seconds', () => {
    expect(response.status).toBe(201);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('should write exactly one PENDING_RETRY dead letter for the event', () => {
    expect(deadLetters).toHaveLength(1);
    const [row] = deadLetters;
    expect(row.topic).toBe('identity.user-registered');
    expect(row.key).toBe(response.body.id);
    expect(row.status).toBe('PENDING_RETRY');
    expect(row.retryCount).toBe(0);
    expect(row.nextRetryAt).not.toBeNull();
    expect(row.lastError).toEqual(expect.any(String));
    expect(row.lastError).not.toBe('');
    expect(row.eventId).toBe(row.payload.eventId);
    expect(row.payload).toMatchObject({
      aggregateId: response.body.id,
      customerId: response.body.customerId,
      email: 'ana@example.com',
      name: 'Ana',
      version: 1,
    });
  });

  it('should log the failed publish with topic, key, eventId and aggregateId', () => {
    const [row] = deadLetters;
    const line = logger.lines.find((entry) => entry.includes(`eventId=${row.eventId}`));

    expect(line).toBeDefined();
    expect(line).toContain('identity.user-registered');
    expect(line).toContain(`key=${response.body.id}`);
    expect(line).toContain(`aggregateId=${response.body.id}`);
  });

  it('should log neither the password nor the hash', () => {
    expect(logger.text()).not.toContain(PASSWORD);
    expect(logger.text()).not.toContain(passwordHash);
  });
});
