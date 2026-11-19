import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRetryConfig } from '../config/configuration';
import {
  decideRetry,
  OutboundRetryStatus,
  RetryAttemptResult,
  RetryDecision,
} from '../domain/outbound/retry-policy';
import { USER_REGISTERED_TOPIC } from '../infra/kafka/kafka.constants';
import {
  OutboundDeadLetterRepository,
  OutboundDeadLetterRow,
} from '../repositories/outbound-dead-letter.repository';
import { Clock } from './ports/clock';
import { UserEventPublisher } from './ports/user-event-publisher';

/** Counts of one retry run. */
export interface RetryRunSummary {
  /** Rows claimed and attempted. */
  claimed: number;
  /** Rows delivered and marked `RESOLVED`. */
  resolved: number;
  /** Rows that failed and were rescheduled. */
  failed: number;
  /** Rows marked `EXHAUSTED`. */
  exhausted: number;
}

/** A stored payload the worker can republish: a JSON object with a string `eventId`. */
type EventPayload = Record<string, unknown> & { eventId: string };

function isEventPayload(payload: unknown): payload is EventPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).eventId === 'string'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Redelivers `identity.user-registered` events that failed to publish after their commit
 * (outbound dead-letter rows). Orchestration only: claim (repository) → republish (publisher port)
 * → next state (domain `decideRetry`) → log. The payload is never logged.
 */
@Injectable()
export class RetryOutboundEventsService {
  private readonly logger = new Logger(RetryOutboundEventsService.name);
  private readonly settings: OutboundRetryConfig;
  private stopRequested = false;

  /**
   * @param deadLetters Claims due rows and writes their next state.
   * @param publisher Republishes stored events.
   * @param clock Time of each attempt.
   * @param configService Provides the `outboundRetry` settings.
   */
  constructor(
    private readonly deadLetters: OutboundDeadLetterRepository,
    private readonly publisher: UserEventPublisher,
    private readonly clock: Clock,
    configService: ConfigService,
  ) {
    this.settings = configService.getOrThrow<OutboundRetryConfig>('outboundRetry');
  }

  /**
   * Stops claiming rows: the run in progress finishes the row it holds and claims no further row,
   * and later runs claim nothing. Called on shutdown.
   */
  requestStop(): void {
    this.stopRequested = true;
  }

  /**
   * Attempts up to `batchSize` due rows, oldest due first, one transaction per row, and stops
   * early when none is left. Logs one summary line when at least one row was attempted.
   *
   * @returns The counts of this run.
   */
  async runBatch(): Promise<RetryRunSummary> {
    const summary: RetryRunSummary = { claimed: 0, resolved: 0, failed: 0, exhausted: 0 };
    for (let i = 0; i < this.settings.batchSize && !this.stopRequested; i += 1) {
      const processed = await this.deadLetters.processNextDue(
        USER_REGISTERED_TOPIC,
        this.clock.now(),
        (row) => this.attempt(row),
      );
      if (processed === null) {
        break;
      }
      summary.claimed += 1;
      this.count(summary, processed.decision);
    }
    if (summary.claimed > 0) {
      this.logger.log(
        `Outbound retry run: claimed=${summary.claimed} resolved=${summary.resolved} ` +
          `failed=${summary.failed} exhausted=${summary.exhausted}`,
      );
    }
    return summary;
  }

  /** Republishes one row unchanged and decides its next state. */
  private async attempt(row: OutboundDeadLetterRow): Promise<RetryDecision> {
    let result: RetryAttemptResult;
    if (!isEventPayload(row.payload)) {
      result = { kind: 'permanent', error: 'malformed payload: no string eventId' };
    } else {
      try {
        await this.publisher.republish(row.topic, row.key, row.payload);
        result = { kind: 'success' };
      } catch (error) {
        result = { kind: 'transient', error: messageOf(error) };
      }
    }
    return decideRetry(row.retryCount, result, this.clock.now(), this.settings);
  }

  private count(summary: RetryRunSummary, decision: RetryDecision): void {
    switch (decision.status) {
      case OutboundRetryStatus.RESOLVED:
        summary.resolved += 1;
        break;
      case OutboundRetryStatus.PENDING_RETRY:
        summary.failed += 1;
        break;
      case OutboundRetryStatus.EXHAUSTED:
        summary.exhausted += 1;
        break;
    }
  }
}
