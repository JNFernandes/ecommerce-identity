# Contract: Outbound retry worker (US-08)

No HTTP endpoint changes. The external contracts are the republished message, the settings and the
log lines.

## Republished message

- Topic: the row's `topic` (only `identity.user-registered`).
- Key: the row's `key` (the user id = `aggregateId`), unchanged.
- Value: the row's `payload` as JSON: same fields and values as the original, including `eventId`
  (field order may differ). Schema unchanged: see `ecommerce-infra/docs/events.md`.
- Delivery: at-least-once. A consumer may see the same `eventId` more than once and MUST
  deduplicate on it.

## Settings

| Variable | Default | Rule |
|---|---|---|
| `OUTBOUND_RETRY_ENABLED` | `true` | `false` disables the worker |
| `OUTBOUND_RETRY_INTERVAL_MS` | `30000` | integer ≥ 1 |
| `OUTBOUND_RETRY_BATCH_SIZE` | `20` | integer ≥ 1 |
| `OUTBOUND_RETRY_MAX_ATTEMPTS` | `10` | integer ≥ 1 |
| `OUTBOUND_RETRY_BASE_DELAY_MS` | `5000` | integer ≥ 1 |
| `OUTBOUND_RETRY_MULTIPLIER` | `2` | number ≥ 1 |
| `OUTBOUND_RETRY_MAX_DELAY_MS` | `300000` | integer ≥ base delay |
| `OUTBOUND_RETRY_SHUTDOWN_TIMEOUT_MS` | `10000` | integer ≥ 1 |

An invalid value stops startup with `<VARIABLE> must be ...`.

## Log lines (context `RetryOutboundEventsService`)

| Level | When | Content |
|---|---|---|
| log | run attempted ≥ 1 row | `claimed`, `resolved`, `failed`, `exhausted` counts |
| warn | attempt failed, rescheduled | row id, `eventId`, topic, key, attempt n, next attempt time, error |
| error | row exhausted | row id, `eventId`, topic, key, attempts, last error |
| error | run failed (e.g. database down) | error message |

Never logged: the payload or any field of it (email, name, customerId).
