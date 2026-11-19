import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
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
 *
 * Disabled with `OUTBOUND_RETRY_ENABLED=false`.
 */
@Injectable()
export class DeadLetterRetryWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeadLetterRetryWorker.name);
  private readonly settings: OutboundRetryConfig;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

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

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().then(() => this.scheduleNext());
    }, this.settings.intervalMs);
    this.timer.unref();
  }
}
