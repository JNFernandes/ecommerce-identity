# Contract: Kafka topic `identity.user-registered` (producer)

Published only after the user row is committed. Key = `aggregateId`. JSON value, `version` 1. It MUST match `ecommerce-infra/docs/events.md`, which gets this entry in the linked change (research R14).

| Field | Type | Notes |
|---|---|---|
| `eventId` | UUID | Unique; kept on dead-letter retry |
| `aggregateId` | UUID | User id; also the message key |
| `occurredAt` | ISO 8601 | Registration time |
| `version` | integer | `1` |
| `customerId` | UUID | New customer id (≠ user id) |
| `email` | string | Normalized (trimmed, lowercase) |
| `name` | string | Trimmed |

No other fields. A failed publish is stored in `outbound_dead_letters` (`PENDING_RETRY`) and is redelivered by US-08 with the same `eventId`, so delivery is at-least-once.

Consumers: Orders (creates the customer record, ADR 0004).
