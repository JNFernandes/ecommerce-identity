import { randomUUID } from 'node:crypto';

/** Data that identifies the new customer, given by the `User` aggregate. */
export interface UserRegisteredData {
  /** The user id. */
  aggregateId: string;
  /** The new customer id. */
  customerId: string;
  /** The normalized email. */
  email: string;
  /** The trimmed name. */
  name: string;
  /** When the registration happened. */
  occurredAt: Date;
}

/**
 * Domain event raised when a customer is created: by registration (`POST /auth/register`) or by an
 * admin (`POST /users` with `["CUSTOMER"]`), or on an admin's first grant of `CUSTOMER` to a user
 * without `customerId` (`PUT /users/{id}/roles`); never for an admin alone, nor for a re-grant. Published on Kafka topic
 * `identity.user-registered` after the user row is committed, keyed by `aggregateId`; a failed
 * publish is dead-lettered and retried with the same `eventId` (at-least-once delivery).
 *
 * Redelivery (outbound retry worker, ADR 0007): the stored key and payload are sent unchanged, so
 * a consumer may receive the same `eventId` more than once and MUST deduplicate on it. The JSON
 * field order of a redelivered message may differ; the fields and values do not.
 *
 * Payload (JSON, exactly these fields, documented in `ecommerce-infra/docs/events.md`):
 *
 * | Field         | Type     | Notes                                  |
 * |---------------|----------|----------------------------------------|
 * | `eventId`     | UUID     | Unique; kept on dead-letter retry      |
 * | `aggregateId` | UUID     | User id; also the message key          |
 * | `occurredAt`  | ISO 8601 | Registration time                      |
 * | `version`     | integer  | `1`                                    |
 * | `customerId`  | UUID     | New customer id (different from the user id) |
 * | `email`       | string   | Normalized (trimmed, lowercase)        |
 * | `name`        | string   | Trimmed                                |
 *
 * Consumers: Orders (creates the customer record).
 */
export class UserRegistered {
  /** Payload schema version of this event. */
  static readonly VERSION = 1;

  /** Unique event id (UUID), kept when a dead-lettered event is retried. */
  readonly eventId: string;
  /** The user id (UUID); also the Kafka message key. */
  readonly aggregateId: string;
  /** Registration time, ISO 8601. */
  readonly occurredAt: string;
  /** Payload schema version, always `1`. */
  readonly version: number;
  /** The new customer id (UUID), different from the user id. */
  readonly customerId: string;
  /** The normalized email (trimmed, lowercase). */
  readonly email: string;
  /** The trimmed name. */
  readonly name: string;

  /**
   * Creates the event with a new `eventId`.
   *
   * @param data The new customer's identifiers and registration time.
   */
  constructor(data: UserRegisteredData) {
    this.eventId = randomUUID();
    this.aggregateId = data.aggregateId;
    this.occurredAt = data.occurredAt.toISOString();
    this.version = UserRegistered.VERSION;
    this.customerId = data.customerId;
    this.email = data.email;
    this.name = data.name;
  }
}
