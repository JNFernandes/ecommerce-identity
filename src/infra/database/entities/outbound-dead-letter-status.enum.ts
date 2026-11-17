/** Retry state of an outbound dead-letter row (PostgreSQL enum `outbound_dead_letter_status_enum`). */
export enum OutboundDeadLetterStatus {
  /** Waiting for the retry worker; claimed once `nextRetryAt` is due. */
  PENDING_RETRY = 'PENDING_RETRY',
  /** A retry succeeded. Final: never claimed again. */
  RESOLVED = 'RESOLVED',
  /** Ran out of retries. Final: never claimed again. */
  EXHAUSTED = 'EXHAUSTED',
}
