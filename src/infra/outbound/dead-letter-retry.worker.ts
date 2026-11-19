import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRetryConfig } from '../../config/configuration';
import { RetryOutboundEventsService } from '../../services/retry-outbound-events.service';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `RetryOutboundEventsService.runBatch()` on a simple in-process timer.
 *
 * - The first run starts one interval after bootstrap; bootstrap never waits for it, so the worker
 *   never delays startup or health.
 * - Each run schedules the next only after it finishes, so runs never overlap in one instance.
 * - The timer is `unref()`'d, so it never keeps the process alive.
 * - A failed run is logged and the next run is still scheduled; the process never crashes.
 * - On shutdown it stops claiming rows and waits, bounded, for the run in progress.
 *
 * Disabled with `OUTBOUND_RETRY_ENABLED=false`.
 */
@Injectable()
export class DeadLetterRetryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeadLetterRetryWorker.name);
  private readonly settings: OutboundRetryConfig;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private destroyed = false;

  /**
   * @param retries Performs one run.
   * @param configService Provides the `outboundRetry` settings.
   */
  constructor(
    private readonly retries: RetryOutboundEventsService,
    configService: ConfigService,
  ) {
    this.settings = configService.getOrThrow<OutboundRetryConfig>('outboundRetry');
  }

  /** Schedules the first run one interval from now, unless the worker is disabled. Never waits. */
  onApplicationBootstrap(): void {
    if (!this.settings.enabled) {
      this.logger.log('Outbound retry worker disabled (OUTBOUND_RETRY_ENABLED=false)');
      return;
    }
    this.scheduleNext();
  }

  /**
   * Performs one run now, or joins the run already in progress (never two at once). Never rejects:
   * a failed run is logged at error level.
   */
  runOnce(): Promise<void> {
    if (this.running === null) {
      this.running = this.execute().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async execute(): Promise<void> {
    try {
      await this.retries.runBatch();
    } catch (error) {
      this.logger.error(`Outbound retry run failed: ${messageOf(error)}`);
    }
  }

  /**
   * Stops the worker before the Kafka producer and the database pool close (they close in
   * `onApplicationShutdown`, which Nest runs after every `onModuleDestroy`): clears the timer,
   * stops claiming rows, and waits for the run in progress for at most `shutdownTimeoutMs`.
   * After that it returns anyway; the unfinished row's transaction rolls back when the pool
   * closes, so the row stays due for another instance. No run is scheduled afterwards.
   */
  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.retries.requestStop();
    const running = this.running;
    if (running === null) {
      return;
    }
    let bound: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      bound = setTimeout(() => resolve('timeout'), this.settings.shutdownTimeoutMs);
      bound.unref();
    });
    // `running` never rejects (execute() logs failures), so abandoning it cannot leak a rejection.
    const outcome = await Promise.race([running.then(() => 'finished' as const), timedOut]);
    clearTimeout(bound);
    if (outcome === 'timeout') {
      this.logger.warn(
        `Outbound retry run still in progress after ${this.settings.shutdownTimeoutMs} ms; ` +
          'shutting down without waiting (unfinished rows stay due)',
      );
    }
  }

  private scheduleNext(): void {
    if (this.destroyed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().then(() => this.scheduleNext());
    }, this.settings.intervalMs);
    this.timer.unref();
  }
}
