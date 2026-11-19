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
