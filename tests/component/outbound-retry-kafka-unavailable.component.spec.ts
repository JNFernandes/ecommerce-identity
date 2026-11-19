import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapturingLogger } from './support/capturing-logger';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';

jest.setTimeout(240_000);

const TOPIC = 'identity.user-registered';
const SEEDED = 3;

/** Retry counts of the seeded rows. */
async function seededRetryCounts(app: INestApplication): Promise<number[]> {
  const rows: { retryCount: number }[] = await app
    .get(DataSource)
    .query(`SELECT "retryCount" FROM "outbound_dead_letters" WHERE "error" = 'seeded'`);
  return rows.map((row) => row.retryCount);
}

/** Polls `check` every 100 ms until it is true or `timeoutMs` elapses. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('service stays healthy with the retry worker running and Kafka down (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication | undefined;
  let initMs: number;

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();

    // Migrate with the worker off, then seed due rows before the real start.
    const setup = await createTestApp();
    for (let i = 0; i < SEEDED; i += 1) {
      const eventId = randomUUID();
      const key = randomUUID();
      await setup.get(DataSource).query(
        `INSERT INTO "outbound_dead_letters"
           ("id", "eventId", "topic", "key", "payload", "error", "status", "retryCount", "nextRetryAt")
         VALUES ($1, $2, $3, $4, $5, 'seeded', 'PENDING_RETRY', 0, now() - interval '1 minute')`,
        [randomUUID(), eventId, TOPIC, key, JSON.stringify({ eventId, aggregateId: key })],
      );
    }
    await setup.close();

    process.env.OUTBOUND_RETRY_ENABLED = 'true';
    process.env.OUTBOUND_RETRY_INTERVAL_MS = '200';
    process.env.OUTBOUND_RETRY_BASE_DELAY_MS = '100';
    process.env.OUTBOUND_RETRY_MAX_DELAY_MS = '200';
    const started = Date.now();
    app = await createTestApp(logger);
    initMs = Date.now() - started;
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should start without waiting for Kafka or for the first retry run', async () => {
    expect(app).toBeDefined();
    expect(initMs).toBeLessThan(30_000);
  });

  it('should report healthy while Kafka is down', async () => {
    const response = await request(app?.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('should keep registering users with 201', async () => {
    const response = await request(app?.getHttpServer())
      .post('/auth/register')
      .send({ email: 'still-works@example.com', name: 'Still', password: 'correct-horse-battery' });

    expect(response.status).toBe(201);
  });

  it('should keep retrying the seeded rows in the background and stay responsive', async () => {
    const target = app as INestApplication;

    await eventually(async () => (await seededRetryCounts(target)).every((count) => count >= 2));

    await request(target.getHttpServer()).get('/health').expect(200);
    expect(
      logger.lines.filter((line) => line.includes('Outbound retry failed')).length,
    ).toBeGreaterThan(0);
    expect(logger.lines.some((line) => line.includes('Outbound retry run failed'))).toBe(false);
  });

  it('should close without hanging', async () => {
    const closing = (app as INestApplication).close();
    app = undefined;

    await expect(closing).resolves.toBeUndefined();
  });
});
