# Data model: Outbound dead-letter retry (US-08)

No schema change (research R1).

## `outbound_dead_letters` (existing)

| Column | Use in US-08 |
|---|---|
| `id` uuid PK | Row id, logged |
| `eventId` uuid | Logged; equal to the payload's `eventId` |
| `topic` varchar | Only `identity.user-registered` rows are claimed |
| `key` varchar | Sent as the Kafka message key, unchanged; logged on exhaustion |
| `payload` jsonb | Sent as the message value; never logged |
| `error` text | Original US-01 failure; never changed |
| `status` enum | `PENDING_RETRY` → `RESOLVED` / `EXHAUSTED` |
| `retryCount` int | Worker attempts made (+1 per attempt) |
| `nextRetryAt` timestamptz | Due when `<= now()`; moved forward on a transient failure |
| `lastAttemptAt` timestamptz | Time of the latest attempt |
| `lastError` text | Latest failure; null after success |
| `resolvedAt` timestamptz | Set on success |

Claim query uses the existing index `(status, nextRetryAt)`.

## State transitions (`decideRetry`, pure, `src/domain/outbound/`)

`n = retryCount + 1`, `now` from the `Clock` port.

| From | Attempt result | To | Writes |
|---|---|---|---|
| `PENDING_RETRY` | success | `RESOLVED` | `retryCount=n`, `lastAttemptAt=now`, `resolvedAt=now`, `lastError=null` |
| `PENDING_RETRY` | transient, `n < maxAttempts` | `PENDING_RETRY` | `retryCount=n`, `lastAttemptAt=now`, `lastError`, `nextRetryAt=now+delay(n)` |
| `PENDING_RETRY` | transient, `n >= maxAttempts` | `EXHAUSTED` | `retryCount=n`, `lastAttemptAt=now`, `lastError` |
| `PENDING_RETRY` | permanent (malformed row) | `EXHAUSTED` | as above |
| `RESOLVED` / `EXHAUSTED` | — | final | never claimed |

`delay(n) = min(baseDelayMs × multiplier^(n−1), maxDelayMs)`; exponent capped so it never
overflows. Defaults give 5, 10, 20, 40, 80, 160, 300, 300, 300 s.

## `RetryPolicySettings` (domain value)

`maxAttempts ≥ 1`, `baseDelayMs ≥ 1`, `multiplier ≥ 1`, `maxDelayMs ≥ baseDelayMs`. Validated at
config load (research R8).
