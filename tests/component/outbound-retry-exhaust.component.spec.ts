import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DeadLetterRetryWorker } from '../../src/infra/outbound/dead-letter-retry.worker';
import { CapturingLogger } from './support/capturing-logger';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';

jest.setTimeout(240_000);

const EMAIL = 'exhaust-me@example.com';

interface DeadLetterRow {
  id: string;
  eventId: string;
  status: string;
  retryCount: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  nextRetryAt: Date;
}

describe('outbound retry backs off and exhausts while Kafka is down (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let worker: DeadLetterRetryWorker;

  /** The only dead-letter row. */
  async function theRow(): Promise<DeadLetterRow> {
    const rows: DeadLetterRow[] = await app.get(DataSource).query(
      `SELECT "id", "eventId", "status"::text AS "status", "retryCount", "lastError",
              "lastAttemptAt", "nextRetryAt"
         FROM "outbound_dead_letters"`,
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /** Makes the row due now, as if its backoff delay had elapsed. */
  async function makeDue(): Promise<void> {
    await app
      .get(DataSource)
      .query(`UPDATE "outbound_dead_letters" SET "nextRetryAt" = now() - interval '1 second'`);
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    process.env.OUTBOUND_RETRY_MAX_ATTEMPTS = '3';
    process.env.OUTBOUND_RETRY_BASE_DELAY_MS = '1000';
    process.env.OUTBOUND_RETRY_MAX_DELAY_MS = '1500';
    app = await createTestApp(logger);
    worker = app.get(DeadLetterRetryWorker);

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: EMAIL, name: 'Exhaust Me', password: 'correct-horse-battery' });
    expect(response.status).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should record each failure and reschedule with growing, capped delays', async () => {
    const expectedDelays = [1000, 1500];

    for (const [index, delay] of expectedDelays.entries()) {
      await makeDue();
      await worker.runOnce();

      const row = await theRow();
      expect(row.status).toBe('PENDING_RETRY');
      expect(row.retryCount).toBe(index + 1);
      expect(row.lastError).toEqual(expect.any(String));
      expect(row.lastAttemptAt).not.toBeNull();
      expect(
        new Date(row.nextRetryAt).getTime() - new Date(row.lastAttemptAt as Date).getTime(),
      ).toBe(delay);
    }
  });

  it('should exhaust the row on the last attempt and log one error line', async () => {
    await makeDue();
    await worker.runOnce();

    const row = await theRow();
    expect(row.status).toBe('EXHAUSTED');
    expect(row.retryCount).toBe(3);
    const exhausted = logger.lines.filter(
      (line) => line.startsWith('[error]') && line.includes('Outbound event exhausted'),
    );
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toContain(`id=${row.id}`);
    expect(exhausted[0]).toContain(`eventId=${row.eventId}`);
  });

  it('should never attempt an exhausted row again', async () => {
    await makeDue();
    await worker.runOnce();

    const row = await theRow();
    expect(row.status).toBe('EXHAUSTED');
    expect(row.retryCount).toBe(3);
  });

  it('should never log the registered email', () => {
    expect(logger.text()).not.toContain(EMAIL);
  });
});
