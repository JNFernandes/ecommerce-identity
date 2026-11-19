import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRetryConfig } from '../../../src/config/configuration';
import { DeadLetterRetryWorker } from '../../../src/infra/outbound/dead-letter-retry.worker';
import {
  RetryOutboundEventsService,
  RetryRunSummary,
} from '../../../src/services/retry-outbound-events.service';

const INTERVAL = 1000;
const EMPTY: RetryRunSummary = { claimed: 0, resolved: 0, failed: 0, exhausted: 0 };

const SETTINGS: OutboundRetryConfig = {
  enabled: true,
  intervalMs: INTERVAL,
  batchSize: 20,
  maxAttempts: 10,
  baseDelayMs: 5000,
  multiplier: 2,
  maxDelayMs: 300000,
  shutdownTimeoutMs: 500,
};

/** Lets pending promise callbacks run under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('DeadLetterRetryWorker', () => {
  let runBatch: jest.Mock<Promise<RetryRunSummary>, []>;
  let requestStop: jest.Mock<void, []>;

  function build(settings: OutboundRetryConfig = SETTINGS): DeadLetterRetryWorker {
    return new DeadLetterRetryWorker(
      { runBatch, requestStop } as unknown as RetryOutboundEventsService,
      { getOrThrow: () => settings } as unknown as ConfigService,
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
    runBatch = jest.fn().mockResolvedValue(EMPTY);
    requestStop = jest.fn();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should schedule nothing when disabled', () => {
    build({ ...SETTINGS, enabled: false }).onApplicationBootstrap();

    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(INTERVAL * 10);
    expect(runBatch).not.toHaveBeenCalled();
  });

  it('should return from bootstrap at once and run first after one interval', () => {
    const result: unknown = build().onApplicationBootstrap();

    expect(result).toBeUndefined();
    expect(runBatch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(INTERVAL - 1);
    expect(runBatch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(runBatch).toHaveBeenCalledTimes(1);
  });

  it('should keep running every interval', async () => {
    build().onApplicationBootstrap();

    for (let i = 0; i < 3; i += 1) {
      jest.advanceTimersByTime(INTERVAL);
      await flush();
    }

    expect(runBatch).toHaveBeenCalledTimes(3);
  });

  it('should not start a new run while the previous one is still running', async () => {
    let finish: () => void = () => undefined;
    runBatch.mockImplementationOnce(
      () =>
        new Promise<RetryRunSummary>((resolve) => {
          finish = (): void => resolve(EMPTY);
        }),
    );
    build().onApplicationBootstrap();

    jest.advanceTimersByTime(INTERVAL);
    jest.advanceTimersByTime(INTERVAL * 5);
    await flush();
    expect(runBatch).toHaveBeenCalledTimes(1);

    finish();
    await flush();
    jest.advanceTimersByTime(INTERVAL);
    expect(runBatch).toHaveBeenCalledTimes(2);
  });

  it('should join the run in progress when runOnce is called during a run', async () => {
    let finish: () => void = () => undefined;
    runBatch.mockImplementationOnce(
      () =>
        new Promise<RetryRunSummary>((resolve) => {
          finish = (): void => resolve(EMPTY);
        }),
    );
    const worker = build();

    const first = worker.runOnce();
    const second = worker.runOnce();
    finish();
    await Promise.all([first, second]);

    expect(runBatch).toHaveBeenCalledTimes(1);
  });

  it('should not keep the process alive with its timer', () => {
    const unref = jest.fn();
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
      const handle = realSetTimeout(callback, ms);
      handle.unref = unref.mockReturnValue(handle);
      return handle;
    }) as typeof setTimeout);

    build().onApplicationBootstrap();

    expect(unref).toHaveBeenCalledTimes(1);
  });

  describe('onModuleDestroy', () => {
    /** Makes the next runBatch hang until the returned functions settle it. */
    function hangNextRun(): { finish: () => void; fail: (error: Error) => void } {
      const control: { finish: () => void; fail: (error: Error) => void } = {
        finish: () => undefined,
        fail: () => undefined,
      };
      runBatch.mockImplementationOnce(
        () =>
          new Promise<RetryRunSummary>((resolve, reject) => {
            control.finish = (): void => resolve(EMPTY);
            control.fail = (error: Error): void => reject(error);
          }),
      );
      return control;
    }

    it('should clear the timer and stop claiming when idle, with no run afterwards', async () => {
      const worker = build();
      worker.onApplicationBootstrap();

      await worker.onModuleDestroy();
      jest.advanceTimersByTime(INTERVAL * 10);
      await flush();

      expect(requestStop).toHaveBeenCalledTimes(1);
      expect(runBatch).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('should wait for the run in progress and schedule nothing afterwards', async () => {
      const run = hangNextRun();
      const worker = build();
      worker.onApplicationBootstrap();
      jest.advanceTimersByTime(INTERVAL);

      let done = false;
      const destroying = worker.onModuleDestroy().then(() => {
        done = true;
      });
      await flush();
      expect(done).toBe(false);
      expect(requestStop).toHaveBeenCalledTimes(1);

      run.finish();
      await destroying;
      jest.advanceTimersByTime(INTERVAL * 10);
      await flush();

      expect(runBatch).toHaveBeenCalledTimes(1);
    });

    it('should return after the shutdown timeout when the run never finishes', async () => {
      hangNextRun();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const worker = build();
      worker.onApplicationBootstrap();
      jest.advanceTimersByTime(INTERVAL);

      const destroying = worker.onModuleDestroy();
      await flush();
      jest.advanceTimersByTime(SETTINGS.shutdownTimeoutMs);
      await destroying;

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Outbound retry run still in progress after 500 ms'),
      );
    });

    it('should log a run that fails after the timeout, without an unhandled rejection', async () => {
      const run = hangNextRun();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const worker = build();
        worker.onApplicationBootstrap();
        jest.advanceTimersByTime(INTERVAL);
        const destroying = worker.onModuleDestroy();
        await flush();
        jest.advanceTimersByTime(SETTINGS.shutdownTimeoutMs);
        await destroying;

        run.fail(new Error('pool closed'));
        await flush();

        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('Outbound retry run failed: pool closed');
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });
});
