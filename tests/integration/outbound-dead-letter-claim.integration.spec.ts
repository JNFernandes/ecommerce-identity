import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { OutboundDeadLetterEntity } from '../../src/infra/database/entities/outbound-dead-letter.entity';
import { OutboundDeadLetterStatus } from '../../src/infra/database/entities/outbound-dead-letter-status.enum';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { OutboundRetryStatus, RetryDecision } from '../../src/domain/outbound/retry-policy';
import {
  OutboundDeadLetterRepository,
  OutboundDeadLetterRow,
} from '../../src/repositories/outbound-dead-letter.repository';

jest.setTimeout(180_000);

const TOPIC = 'identity.user-registered';
const NOW = new Date('2026-11-19T10:00:00.000Z');

/** Builds a row with sensible defaults; `overrides` win. */
function rowOf(overrides: Partial<OutboundDeadLetterEntity> = {}): OutboundDeadLetterEntity {
  const entity = new OutboundDeadLetterEntity();
  const eventId = randomUUID();
  entity.id = randomUUID();
  entity.eventId = eventId;
  entity.topic = TOPIC;
  entity.key = randomUUID();
  entity.payload = { eventId, email: 'ana@example.com' };
  entity.error = 'original failure';
  entity.status = OutboundDeadLetterStatus.PENDING_RETRY;
  entity.retryCount = 0;
  entity.nextRetryAt = new Date(NOW.getTime() - 60_000);
  entity.lastAttemptAt = null;
  entity.lastError = 'original failure';
  entity.resolvedAt = null;
  return Object.assign(entity, overrides);
}

/** A decision that resolves the row at `NOW`. */
function resolved(row: OutboundDeadLetterRow): RetryDecision {
  return {
    status: OutboundRetryStatus.RESOLVED,
    retryCount: row.retryCount + 1,
    lastAttemptAt: NOW,
    lastError: null,
    resolvedAt: NOW,
  };
}

describe('OutboundDeadLetterRepository.processNextDue (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let entities: Repository<OutboundDeadLetterEntity>;
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
    entities = dataSource.getRepository(OutboundDeadLetterEntity);
    repository = new OutboundDeadLetterRepository(entities);
  });

  beforeEach(async () => {
    await entities.clear();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should return null and not call the handler when no row exists', async () => {
    const handler = jest.fn(async (row: OutboundDeadLetterRow) => resolved(row));

    await expect(repository.processNextDue(TOPIC, NOW, handler)).resolves.toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it('should skip rows that are not due, final, or of another topic', async () => {
    await entities.save([
      rowOf({ nextRetryAt: new Date(NOW.getTime() + 1000) }),
      rowOf({ status: OutboundDeadLetterStatus.RESOLVED }),
      rowOf({ status: OutboundDeadLetterStatus.EXHAUSTED }),
      rowOf({ topic: 'identity.something-else' }),
    ]);
    const handler = jest.fn(async (row: OutboundDeadLetterRow) => resolved(row));

    await expect(repository.processNextDue(TOPIC, NOW, handler)).resolves.toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it('should claim a row due exactly now', async () => {
    const due = rowOf({ nextRetryAt: NOW });
    await entities.save(due);

    const result = await repository.processNextDue(TOPIC, NOW, async (row) => resolved(row));

    expect(result?.row.id).toBe(due.id);
  });

  it('should claim the oldest due row first', async () => {
    const newer = rowOf({ nextRetryAt: new Date(NOW.getTime() - 1000) });
    const oldest = rowOf({ nextRetryAt: new Date(NOW.getTime() - 5000) });
    const middle = rowOf({ nextRetryAt: new Date(NOW.getTime() - 3000) });
    await entities.save([newer, oldest, middle]);
    const claimed: string[] = [];

    for (let i = 0; i < 3; i += 1) {
      const result = await repository.processNextDue(TOPIC, NOW, async (row) => resolved(row));
      claimed.push(result?.row.id ?? 'none');
    }

    expect(claimed).toEqual([oldest.id, middle.id, newer.id]);
  });

  it('should hand the stored fields to the handler without ORM internals', async () => {
    const stored = rowOf({ retryCount: 2 });
    await entities.save(stored);
    const handler = jest.fn(async (row: OutboundDeadLetterRow) => resolved(row));

    await repository.processNextDue(TOPIC, NOW, handler);

    expect(handler).toHaveBeenCalledWith({
      id: stored.id,
      eventId: stored.eventId,
      topic: TOPIC,
      key: stored.key,
      payload: stored.payload,
      retryCount: 2,
    });
  });

  it('should write a resolved decision and leave error, payload and key unchanged', async () => {
    const stored = rowOf();
    await entities.save(stored);

    const result = await repository.processNextDue(TOPIC, NOW, async (row) => resolved(row));

    const after = await entities.findOneByOrFail({ id: stored.id });
    expect(result?.decision.status).toBe(OutboundRetryStatus.RESOLVED);
    expect(after.status).toBe(OutboundDeadLetterStatus.RESOLVED);
    expect(after.retryCount).toBe(1);
    expect(after.lastAttemptAt).toEqual(NOW);
    expect(after.resolvedAt).toEqual(NOW);
    expect(after.lastError).toBeNull();
    expect(after.nextRetryAt).toEqual(stored.nextRetryAt);
    expect(after.error).toBe('original failure');
    expect(after.payload).toEqual(stored.payload);
    expect(after.key).toBe(stored.key);
  });

  it('should write a rescheduled decision with the new due time', async () => {
    const stored = rowOf();
    await entities.save(stored);
    const next = new Date(NOW.getTime() + 5000);

    await repository.processNextDue(TOPIC, NOW, async () => ({
      status: OutboundRetryStatus.PENDING_RETRY,
      retryCount: 1,
      lastAttemptAt: NOW,
      lastError: 'broker down',
      nextRetryAt: next,
    }));

    const after = await entities.findOneByOrFail({ id: stored.id });
    expect(after.status).toBe(OutboundDeadLetterStatus.PENDING_RETRY);
    expect(after.retryCount).toBe(1);
    expect(after.lastError).toBe('broker down');
    expect(after.nextRetryAt).toEqual(next);
    expect(after.resolvedAt).toBeNull();
  });

  it('should write an exhausted decision', async () => {
    const stored = rowOf({ retryCount: 9 });
    await entities.save(stored);

    await repository.processNextDue(TOPIC, NOW, async () => ({
      status: OutboundRetryStatus.EXHAUSTED,
      retryCount: 10,
      lastAttemptAt: NOW,
      lastError: 'broker down',
    }));

    const after = await entities.findOneByOrFail({ id: stored.id });
    expect(after.status).toBe(OutboundDeadLetterStatus.EXHAUSTED);
    expect(after.retryCount).toBe(10);
  });

  describe('concurrent claimers', () => {
    /** A promise plus the function that resolves it. */
    function gate(): { opened: Promise<void>; open: () => void } {
      let open: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { opened, open };
    }

    it('should never hand the same row to two concurrent claimers', async () => {
      await entities.save(
        Array.from({ length: 10 }, (_, i) =>
          rowOf({ nextRetryAt: new Date(NOW.getTime() - 1000 * (i + 1)) }),
        ),
      );
      const claimed: string[] = [];

      /** Claims until nothing is due, holding each lock briefly. */
      async function drain(): Promise<void> {
        for (;;) {
          const result = await repository.processNextDue(TOPIC, NOW, async (row) => {
            claimed.push(row.id);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return resolved(row);
          });
          if (result === null) {
            return;
          }
        }
      }

      await Promise.all([drain(), drain()]);

      expect(new Set(claimed).size).toBe(claimed.length);
      expect(claimed).toHaveLength(10);
    });

    it('should skip a locked row instead of waiting for it', async () => {
      const first = rowOf({ nextRetryAt: new Date(NOW.getTime() - 2000) });
      const second = rowOf({ nextRetryAt: new Date(NOW.getTime() - 1000) });
      await entities.save([first, second]);
      const entered = gate();
      const release = gate();

      const holding = repository.processNextDue(TOPIC, NOW, async (row) => {
        entered.open();
        await release.opened;
        return resolved(row);
      });
      await entered.opened;
      const other = await repository.processNextDue(TOPIC, NOW, async (row) => resolved(row));
      const none = await repository.processNextDue(TOPIC, NOW, async (row) => resolved(row));
      release.open();
      const held = await holding;

      expect(held?.row.id).toBe(first.id);
      expect(other?.row.id).toBe(second.id);
      expect(none).toBeNull();
    });

    it('should release a row whose processing crashed so a later claim gets it', async () => {
      const stored = rowOf();
      await entities.save(stored);

      await expect(
        repository.processNextDue(TOPIC, NOW, async () => {
          throw new Error('instance crashed');
        }),
      ).rejects.toThrow('instance crashed');
      const retried = await repository.processNextDue(TOPIC, NOW, async (row) => resolved(row));

      expect(retried?.row.id).toBe(stored.id);
      expect(retried?.row.retryCount).toBe(0);
    });
  });

  it('should roll back and leave the row exactly as before when the handler throws', async () => {
    const stored = rowOf({ retryCount: 3 });
    await entities.save(stored);
    const before = await entities.findOneByOrFail({ id: stored.id });

    await expect(
      repository.processNextDue(TOPIC, NOW, async () => {
        throw new Error('handler crashed');
      }),
    ).rejects.toThrow('handler crashed');

    await expect(entities.findOneByOrFail({ id: stored.id })).resolves.toEqual(before);
  });
});
