/**
 * Retry state of an outbound event after an attempt. Values match the persisted
 * `outbound_dead_letter_status_enum`; the repository maps between the two.
 */
export enum OutboundRetryStatus {
  /** Still waiting for a later attempt. */
  PENDING_RETRY = 'PENDING_RETRY',
  /** Delivered. Final. */
  RESOLVED = 'RESOLVED',
  /** Gave up. Final: kept for manual inspection. */
  EXHAUSTED = 'EXHAUSTED',
}

/** Settings that decide a row's next state after an attempt. */
export interface RetryPolicySettings {
  /** Attempts after which a failing row is exhausted (>= 1). */
  maxAttempts: number;
  /** Delay in ms after the first failed attempt (>= 1). */
  baseDelayMs: number;
  /** Factor applied to the delay after each further failed attempt (>= 1). */
  multiplier: number;
  /** Upper bound of any delay in ms (>= `baseDelayMs`). */
  maxDelayMs: number;
}

/** Outcome of one attempt to republish an outbound event. */
export type RetryAttemptResult =
  /** The broker accepted the message. */
  | { kind: 'success' }
  /** The publish failed; a later attempt may succeed. */
  | { kind: 'transient'; error: string }
  /** The row can never succeed (for example a malformed payload). */
  | { kind: 'permanent'; error: string };

/** The row's new state after an attempt. Fields absent here are left unchanged. */
export interface RetryDecision {
  /** New status. */
  status: OutboundRetryStatus;
  /** Attempts made so far, including this one. */
  retryCount: number;
  /** Time of this attempt. */
  lastAttemptAt: Date;
  /** Failure of this attempt, or `null` after a success. */
  lastError: string | null;
  /** When the row is due again; set only when it stays `PENDING_RETRY`. */
  nextRetryAt?: Date;
  /** Time of delivery; set only when `RESOLVED`. */
  resolvedAt?: Date;
}

/**
 * Exponent above which `multiplier^exponent` is no longer computed: with a multiplier > 1 the
 * delay has long reached any sensible cap, and the power could otherwise overflow to `Infinity`.
 */
const MAX_EXPONENT = 64;

/**
 * Delay before the next attempt after failed attempt number `attempt` (1-based):
 * `min(baseDelayMs × multiplier^(attempt − 1), maxDelayMs)`. Always finite.
 *
 * @param attempt The failed attempt number, starting at 1.
 * @param settings The retry policy.
 * @returns The delay in milliseconds.
 */
export function nextRetryDelay(attempt: number, settings: RetryPolicySettings): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), MAX_EXPONENT);
  const delay = settings.baseDelayMs * Math.pow(settings.multiplier, exponent);
  return Number.isFinite(delay) ? Math.min(delay, settings.maxDelayMs) : settings.maxDelayMs;
}

/**
 * Decides a row's next state after one attempt.
 *
 * - success → `RESOLVED`, `resolvedAt = now`, `lastError = null`;
 * - permanent failure → `EXHAUSTED` at once;
 * - transient failure → `EXHAUSTED` when this attempt reaches `maxAttempts`, otherwise
 *   `PENDING_RETRY` due at `now + nextRetryDelay(attempt)`.
 *
 * Every attempt increments `retryCount` and sets `lastAttemptAt`.
 *
 * @param currentRetryCount Attempts made before this one.
 * @param result Outcome of this attempt.
 * @param now Time of this attempt.
 * @param settings The retry policy.
 */
export function decideRetry(
  currentRetryCount: number,
  result: RetryAttemptResult,
  now: Date,
  settings: RetryPolicySettings,
): RetryDecision {
  const retryCount = currentRetryCount + 1;
  if (result.kind === 'success') {
    return {
      status: OutboundRetryStatus.RESOLVED,
      retryCount,
      lastAttemptAt: now,
      lastError: null,
      resolvedAt: now,
    };
  }
  if (result.kind === 'permanent' || retryCount >= settings.maxAttempts) {
    return {
      status: OutboundRetryStatus.EXHAUSTED,
      retryCount,
      lastAttemptAt: now,
      lastError: result.error,
    };
  }
  return {
    status: OutboundRetryStatus.PENDING_RETRY,
    retryCount,
    lastAttemptAt: now,
    lastError: result.error,
    nextRetryAt: new Date(now.getTime() + nextRetryDelay(retryCount, settings)),
  };
}
