import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRetryConfig } from '../../../src/config/configuration';
import { OutboundRetryStatus, RetryDecision } from '../../../src/domain/outbound/retry-policy';
import {
  OutboundDeadLetterRepository,
  OutboundDeadLetterRow,
  ProcessedRow,
} from '../../../src/repositories/outbound-dead-letter.repository';
import { RetryOutboundEventsService } from '../../../src/services/retry-outbound-events.service';
import { Clock } from '../../../src/services/ports/clock';
import { UserEventPublisher } from '../../../src/services/ports/user-event-publisher';

const NOW = new Date('2026-11-19T10:00:00.000Z');
const TOPIC = 'identity.user-registered';

const SETTINGS: OutboundRetryConfig = {
  enabled: true,
  intervalMs: 30000,
  batchSize: 3,
  maxAttempts: 10,
  baseDelayMs: 5000,
  multiplier: 2,
  maxDelayMs: 300000,
  shutdownTimeoutMs: 10000,
};

type Handler = (row: OutboundDeadLetterRow) => Promise<RetryDecision>;

/** A due row with a payload holding personal data that must never be logged. */
function rowOf(n: number, overrides: Partial<OutboundDeadLetterRow> = {}): OutboundDeadLetterRow {
  return {
    id: `row-${n}`,
    eventId: `event-${n}`,
    topic: TOPIC,
    key: `user-${n}`,
    payload: {
      eventId: `event-${n}`,
      aggregateId: `user-${n}`,
      customerId: `secret-customer-${n}`,
      email: `secret-${n}@example.com`,
      name: `Secret Name ${n}`,
    },
    retryCount: 0,
    ...overrides,
  };
}

describe('RetryOutboundEventsService', () => {
  let queue: OutboundDeadLetterRow[];
  let processNextDue: jest.Mock<Promise<ProcessedRow | null>, [string, Date, Handler]>;
  let republish: jest.Mock<Promise<void>, [string, string, Record<string, unknown>]>;
  let log: jest.SpyInstance;
  let service: RetryOutboundEventsService;

  /** Builds the service; `processNextDue` hands out rows from `queue` like the real repository. */
  function build(settings: OutboundRetryConfig = SETTINGS): RetryOutboundEventsService {
    return new RetryOutboundEventsService(
      { processNextDue } as unknown as OutboundDeadLetterRepository,
      { publishUserRegistered: jest.fn(), republish } as UserEventPublisher,
      { now: () => NOW } as Clock,
      { getOrThrow: () => settings } as unknown as ConfigService,
    );
  }

  beforeEach(() => {
    queue = [];
    processNextDue = jest.fn(async (_topic: string, _now: Date, handler: Handler) => {
      const row = queue.shift();
      if (row === undefined) {
        return null;
      }
      return { row, decision: await handler(row) };
    });
    republish = jest.fn().mockResolvedValue(undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should claim only identity.user-registered rows due at the current time', async () => {
    await service.runBatch();

    expect(processNextDue).toHaveBeenCalledWith(TOPIC, NOW, expect.any(Function));
  });

  it('should republish the stored topic, key and payload unchanged and resolve the row', async () => {
    const row = rowOf(1, { retryCount: 2 });
    queue.push(row);

    const summary = await service.runBatch();

    expect(republish).toHaveBeenCalledWith(TOPIC, 'user-1', row.payload);
    const decision = await processNextDue.mock.results[0].value;
    expect(decision).toEqual({
      row,
      decision: {
        status: OutboundRetryStatus.RESOLVED,
        retryCount: 3,
        lastAttemptAt: NOW,
        lastError: null,
        resolvedAt: NOW,
      },
    });
    expect(summary).toEqual({ claimed: 1, resolved: 1, failed: 0, exhausted: 0 });
  });

  it('should attempt at most batchSize rows per run, leaving the rest for later runs', async () => {
    queue.push(rowOf(1), rowOf(2), rowOf(3), rowOf(4), rowOf(5));

    const first = await service.runBatch();
    const second = await service.runBatch();

    expect(first.claimed).toBe(3);
    expect(second.claimed).toBe(2);
    expect(republish.mock.calls.map(([, key]) => key)).toEqual([
      'user-1',
      'user-2',
      'user-3',
      'user-4',
      'user-5',
    ]);
  });

  it('should stop at the first empty claim', async () => {
    queue.push(rowOf(1));

    await service.runBatch();

    expect(processNextDue).toHaveBeenCalledTimes(2);
  });

  it('should log one summary line with the counts for a non-empty run', async () => {
    queue.push(rowOf(1), rowOf(2));

    await service.runBatch();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'Outbound retry run: claimed=2 resolved=2 failed=0 exhausted=0',
    );
  });

  describe('failures', () => {
    let warn: jest.SpyInstance;
    let error: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    /** Every captured line, at every level. */
    function allLines(): string[] {
      return [log, warn, error].flatMap((spy) =>
        spy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')),
      );
    }

    it('should reschedule a failed publish with the backoff delay and warn once', async () => {
      queue.push(rowOf(1, { retryCount: 1 }));
      republish.mockRejectedValue(new Error('broker down'));

      const summary = await service.runBatch();

      const { decision } = (await processNextDue.mock.results[0].value) as ProcessedRow;
      expect(decision).toEqual({
        status: OutboundRetryStatus.PENDING_RETRY,
        retryCount: 2,
        lastAttemptAt: NOW,
        lastError: 'broker down',
        nextRetryAt: new Date(NOW.getTime() + 10000),
      });
      expect(summary).toEqual({ claimed: 1, resolved: 0, failed: 1, exhausted: 0 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Outbound retry failed: id=row-1 eventId=event-1 topic=identity.user-registered ' +
          'key=user-1 attempt=2 nextAttemptAt=2026-11-19T10:00:10.000Z error=broker down',
      );
      expect(error).not.toHaveBeenCalled();
    });

    it('should exhaust a row whose failure reaches the maximum and log one error line', async () => {
      queue.push(rowOf(1, { retryCount: 9 }));
      republish.mockRejectedValue(new Error('broker down'));

      const summary = await service.runBatch();

      const { decision } = (await processNextDue.mock.results[0].value) as ProcessedRow;
      expect(decision.status).toBe(OutboundRetryStatus.EXHAUSTED);
      expect(decision.retryCount).toBe(10);
      expect(summary).toEqual({ claimed: 1, resolved: 0, failed: 0, exhausted: 1 });
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        'Outbound event exhausted, left for manual inspection: id=row-1 eventId=event-1 ' +
          'topic=identity.user-registered key=user-1 attempts=10 lastError=broker down',
      );
    });

    it.each([
      ['no eventId', { aggregateId: 'user-1' }],
      ['a non-string eventId', { eventId: 42 }],
      ['an array', ['event-1']],
      ['a string', 'event-1'],
      ['null', null],
    ])('should exhaust a row whose payload has %s without publishing', async (_label, payload) => {
      queue.push(rowOf(1, { payload }));

      const summary = await service.runBatch();

      const { decision } = (await processNextDue.mock.results[0].value) as ProcessedRow;
      expect(republish).not.toHaveBeenCalled();
      expect(decision.status).toBe(OutboundRetryStatus.EXHAUSTED);
      expect(decision.retryCount).toBe(1);
      expect(decision.lastError).toBe('malformed payload: no string eventId');
      expect(summary.exhausted).toBe(1);
    });

    it('should give each row of a mixed batch its own outcome', async () => {
      queue.push(rowOf(1), rowOf(2), rowOf(3));
      republish
        .mockRejectedValueOnce(new Error('broker down'))
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('timeout'));

      const summary = await service.runBatch();

      const statuses = await Promise.all(
        processNextDue.mock.results.map(
          async (result) => ((await result.value) as ProcessedRow).decision.status,
        ),
      );
      expect(statuses).toEqual([
        OutboundRetryStatus.PENDING_RETRY,
        OutboundRetryStatus.RESOLVED,
        OutboundRetryStatus.PENDING_RETRY,
      ]);
      expect(summary).toEqual({ claimed: 3, resolved: 1, failed: 2, exhausted: 0 });
      expect(log).toHaveBeenCalledWith(
        'Outbound retry run: claimed=3 resolved=1 failed=2 exhausted=0',
      );
    });

    it('should end the run without throwing when a row cannot be processed', async () => {
      queue.push(rowOf(1), rowOf(2));
      processNextDue.mockRejectedValueOnce(new Error('connection terminated'));

      const summary = await service.runBatch();

      expect(summary).toEqual({ claimed: 0, resolved: 0, failed: 0, exhausted: 0 });
      expect(processNextDue).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith('Outbound retry run stopped: connection terminated');
    });

    it('should keep the rows processed before a failure and report them', async () => {
      queue.push(rowOf(1), rowOf(2));
      processNextDue
        .mockImplementationOnce(async (_t, _n, handler) => {
          const row = queue.shift() as OutboundDeadLetterRow;
          return { row, decision: await handler(row) };
        })
        .mockRejectedValueOnce(new Error('connection terminated'));

      const summary = await service.runBatch();

      expect(summary).toEqual({ claimed: 1, resolved: 1, failed: 0, exhausted: 0 });
    });

    it('should never log the payload or any of its personal fields', async () => {
      queue.push(rowOf(1, { retryCount: 9 }), rowOf(2), rowOf(3));
      republish
        .mockRejectedValueOnce(new Error('broker down'))
        .mockRejectedValueOnce(new Error('broker down'))
        .mockResolvedValueOnce(undefined);

      await service.runBatch();

      const text = allLines().join('\n');
      expect(text.length).toBeGreaterThan(0);
      for (const n of [1, 2, 3]) {
        expect(text).not.toContain(`secret-${n}@example.com`);
        expect(text).not.toContain(`Secret Name ${n}`);
        expect(text).not.toContain(`secret-customer-${n}`);
      }
    });
  });

  it('should claim no further row once a stop is requested, nor in later runs', async () => {
    queue.push(rowOf(1), rowOf(2), rowOf(3));
    republish.mockImplementationOnce(async () => {
      service.requestStop();
    });

    const first = await service.runBatch();
    const second = await service.runBatch();

    expect(first.claimed).toBe(1);
    expect(second.claimed).toBe(0);
    expect(processNextDue).toHaveBeenCalledTimes(1);
  });

  it('should log nothing at log level for an empty run', async () => {
    const summary = await service.runBatch();

    expect(summary).toEqual({ claimed: 0, resolved: 0, failed: 0, exhausted: 0 });
    expect(log).not.toHaveBeenCalled();
  });
});
