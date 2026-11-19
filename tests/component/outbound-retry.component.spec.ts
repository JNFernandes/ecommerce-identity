import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DeadLetterRetryWorker } from '../../src/infra/outbound/dead-letter-retry.worker';
import { CapturingLogger } from './support/capturing-logger';
import { TopicObserver } from './support/kafka-testing';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';

jest.setTimeout(240_000);

const TOPIC = 'identity.user-registered';

interface DeadLetterRow {
  id: string;
  eventId: string;
  key: string;
  payload: Record<string, unknown>;
  status: string;
  retryCount: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  resolvedAt: Date | null;
}

/** Every dead-letter row, oldest first. */
function deadLetters(app: INestApplication): Promise<DeadLetterRow[]> {
  return app.get(DataSource).query(
    `SELECT "id", "eventId", "key", "payload", "status"::text AS "status", "retryCount",
            "lastError", "lastAttemptAt", "resolvedAt"
       FROM "outbound_dead_letters" ORDER BY "createdAt", "nextRetryAt"`,
  );
}

/** Inserts a pending row of `identity.user-registered` due at `nextRetryAt`. */
async function insertPending(app: INestApplication, nextRetryAt: Date): Promise<string> {
  const eventId = randomUUID();
  const key = randomUUID();
  await app.get(DataSource).query(
    `INSERT INTO "outbound_dead_letters"
       ("id", "eventId", "topic", "key", "payload", "error", "status", "retryCount", "nextRetryAt", "lastError")
     VALUES ($1, $2, $3, $4, $5, 'original failure', 'PENDING_RETRY', 0, $6, 'original failure')`,
    [
      randomUUID(),
      eventId,
      TOPIC,
      key,
      JSON.stringify({ eventId, aggregateId: key, version: 1 }),
      nextRetryAt.toISOString(),
    ],
  );
  return eventId;
}

describe('outbound retry worker redelivers after Kafka returns (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let kafka: StartedKafkaContainer;
  let broker: string;
  let observer: TopicObserver;
  let app: INestApplication;
  let worker: DeadLetterRetryWorker;
  let registered: { id: string };
  let stored: DeadLetterRow;

  beforeAll(async () => {
    [postgres, kafka] = await Promise.all([
      startPostgres(),
      new KafkaContainer('confluentinc/cp-kafka:7.6.1').start(),
    ]);
    broker = `${kafka.getHost()}:${kafka.getMappedPort(9093)}`;
    process.env.OUTBOUND_RETRY_BATCH_SIZE = '2';

    // App A: Kafka unreachable, so the registration event is dead-lettered.
    await useUnreachableKafka();
    const appA = await createTestApp(new CapturingLogger());
    const response = await request(appA.getHttpServer())
      .post('/auth/register')
      .send({ email: 'ana@example.com', name: 'Ana', password: 'correct-horse-battery' });
    expect(response.status).toBe(201);
    registered = response.body as { id: string };
    [stored] = await deadLetters(appA);
    await appA.close();

    // App B: same database, Kafka reachable again.
    process.env.KAFKA_BROKERS = broker;
    process.env.KAFKA_PRODUCER_RETRIES = '2';
    process.env.KAFKA_CONNECTION_TIMEOUT_MS = '5000';
    observer = await TopicObserver.start(broker, TOPIC);
    app = await createTestApp(new CapturingLogger());
    worker = app.get(DeadLetterRetryWorker);
  });

  afterAll(async () => {
    await observer?.stop();
    await app?.close();
    await Promise.all([kafka?.stop(), postgres?.stop()]);
    process.env = savedEnv;
  });

  it('should have stored the failed registration event as a due pending row', () => {
    expect(stored).toBeDefined();
    expect(stored.status).toBe('PENDING_RETRY');
    expect(stored.retryCount).toBe(0);
    expect(stored.key).toBe(registered.id);
  });

  it('should republish exactly the stored message and resolve the row', async () => {
    await worker.runOnce();
    await observer.waitForMessages(1);

    expect(observer.messages).toHaveLength(1);
    const [message] = observer.messages;
    expect(message.key).toBe(stored.key);
    expect(message.value).toEqual(stored.payload);
    expect(message.value.eventId).toBe(stored.eventId);

    const [row] = await deadLetters(app);
    expect(row.status).toBe('RESOLVED');
    expect(row.retryCount).toBe(1);
    expect(row.lastError).toBeNull();
    expect(row.resolvedAt).not.toBeNull();
    expect(row.lastAttemptAt).not.toBeNull();
  });

  it('should never publish a resolved row again', async () => {
    await worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(observer.messages).toHaveLength(1);
  });

  it('should not attempt a row whose next retry time is in the future', async () => {
    const eventId = await insertPending(app, new Date(Date.now() + 3_600_000));

    await worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const row = (await deadLetters(app)).find((r) => r.eventId === eventId);
    expect(row?.status).toBe('PENDING_RETRY');
    expect(row?.retryCount).toBe(0);
    expect(observer.messages).toHaveLength(1);
  });

  it('should attempt at most one batch per run, oldest due first', async () => {
    const now = Date.now();
    const oldest = await insertPending(app, new Date(now - 30_000));
    const middle = await insertPending(app, new Date(now - 20_000));
    const newest = await insertPending(app, new Date(now - 10_000));

    await worker.runOnce();
    await observer.waitForMessages(3);
    const afterFirst = observer.messages.slice(1).map((m) => m.value.eventId);

    await worker.runOnce();
    await observer.waitForMessages(4);
    const afterSecond = observer.messages.slice(3).map((m) => m.value.eventId);

    expect(afterFirst).toEqual([oldest, middle]);
    expect(afterSecond).toEqual([newest]);
    const statuses = (await deadLetters(app))
      .filter((r) => [oldest, middle, newest].includes(r.eventId))
      .map((r) => r.status);
    expect(statuses).toEqual(['RESOLVED', 'RESOLVED', 'RESOLVED']);
  });
});
