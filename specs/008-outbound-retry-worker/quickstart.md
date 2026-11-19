# Quickstart: Outbound retry worker (US-08)

## Automated

```bash
npm run test:unit -- outbound          # policy, service, worker, config
npm run test:integration -- outbound   # SKIP LOCKED claim on real PostgreSQL (Docker)
npm run test:component -- outbound     # Kafka down → 201 → Kafka up → RESOLVED; EXHAUSTED (Docker)
```

## Manual (local infra from `ecommerce-infra`)

1. `docker compose up -d` in `ecommerce-infra`; here set `OUTBOUND_RETRY_INTERVAL_MS=5000`,
   `OUTBOUND_RETRY_BASE_DELAY_MS=2000`, then `npm run start:dev`.
2. `docker compose stop kafka`. `POST /auth/register` → **201**. `GET /health` → **200**.
3. In Postgres: `SELECT id, status, "retryCount", "nextRetryAt", "lastError" FROM outbound_dead_letters;`
   → one `PENDING_RETRY` row; over the next runs `retryCount` grows and delays roughly double.
   Logs show `warn` lines with row id, `eventId`, attempt and next time, and no email.
4. `docker compose start kafka`. Within one interval after the next due time: row `RESOLVED`,
   `resolvedAt` set; Kafka UI shows the message on `identity.user-registered` with the same
   `eventId` and key = user id.
5. Exhaustion: set `OUTBOUND_RETRY_MAX_ATTEMPTS=2`, stop Kafka, register, wait two attempts →
   row `EXHAUSTED`, one `error` log line; it is never attempted again.
6. Stop the service (Ctrl+C) mid-run: it exits cleanly; no row is left half-updated.

## Result (2026-11-19, `node dist/main.js` on port 3099 against throwaway `postgres:16-alpine` and `cp-kafka:7.6.1` containers)

Throwaway containers kept the shared local infra untouched; stopping and starting the throwaway
Kafka simulated the outage. Settings: interval 5 s (1 s for steps 5–6), base delay 2 s.

- **Steps 1–2**: Kafka stopped → `POST /auth/register` 201, `GET /health` 200
  (`kafka: unavailable`); one `PENDING_RETRY` row, `retryCount` 0. ✅
- **Step 3**: three failed attempts, delays 2 s → 4 s → 8 s; one `warn` per attempt with row id,
  `eventId`, topic, key, attempt and next time, plus one summary line per run. ✅
- **Step 4**: Kafka started → row `RESOLVED`, `resolvedAt` set, `lastError` null; exactly one
  message on `identity.user-registered`, key = user id, same `eventId`, the seven contract
  fields. ✅
- **Step 5**: `OUTBOUND_RETRY_MAX_ATTEMPTS=2` → `EXHAUSTED` after 2 attempts, one `error` line;
  not attempted again in the following runs. ✅
- **Step 6**: SIGINT (as Ctrl+C, via `enableShutdownHooks`) sent while a row was locked and its
  publish in flight (unroutable broker, 3 s connection timeout): the held row was finished
  (`retryCount` 1→2, rescheduled), the run claimed nothing more (`claimed=1`, the other two rows
  untouched and due), the process exited ~3.5 s later with 0 database connections left. On
  Windows the exit code is 1 because Nest re-raises the signal after `app.close()`. ✅
- **Logs**: no email, name or other payload field in any line. ✅
- **Automated**: `npm run test`, 1010 tests pass (unit, integration, component). ✅
